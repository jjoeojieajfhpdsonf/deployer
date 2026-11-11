/**
 * Meilenstein Backup, Etappen 1 und 2: Sichern mit echtem restic gegen einen
 * Wegwerf-Aufbau (Postgres, Backup-Container aus backup/Dockerfile,
 * S3-Testserver SeaweedFS).
 *
 *   pnpm --filter @airlock/api exec tsx scripts/backup-e2e.ts
 *
 * Braucht Docker und lädt beim ersten Mal restic/restic, postgres:17-alpine,
 * alpine:3.20 und SeaweedFS. Airlock spricht Docker wie in compose.yaml nur
 * über einen Socket-Proxy mit EXEC=0; den Backup-Container steuert es über
 * Aufträge in einem Verzeichnis (hier ein temporärer Host-Ordner, im Stack
 * das tmpfs-Volume backup_jobs), das der Container unter /jobs sieht.
 * Nichts davon berührt einen laufenden Airlock-Stack: eigene Namen
 * (airlock-backup-e2e*), eigenes Netz, eigene Volumes, kein Host-Port ausser
 * dem der Wegwerf-Datenbank und dem des Proxys (nur 127.0.0.1).
 *
 * Abnahme laut docs/MILESTONE-BACKUP.md:
 * - Etappe 1: Ziel lokal und S3 (Plan: MinIO, hier SeaweedFS) einrichten, Repository wird angelegt,
 *   Passwort steht nicht im Klartext in DB oder Logs (Audit).
 * - Etappe 2: zwei Läufe hintereinander, der zweite ist dedupliziert klein;
 *   Aufbewahrung entfernt alte Stände; ein absichtlich falsches Ziel ergibt
 *   Fehlschlag mit Benachrichtigung; «48 h ohne Erfolg» meldet sich.
 * - Dazu: secrets.key ist in keinem Stand; ein Projekt-Volume ist drin.
 * - Ohne exec: der Proxy lehnt exec ab; nach den Läufen liegt kein
 *   Geheimnis im Auftrags-Verzeichnis und keins im Log des Ausführers; der
 *   Ausführer lehnt nicht erlaubte Vorgänge ab.
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startThrowawayPostgres, checker } from './lib/throwaway-pg.js'

const P = 'airlock-backup-e2e'
const NET = `${P}-net`
const BACKUP = P
const S3 = `${P}-s3`
const IMAGE = 'airlock/backup:e2e'
// S3-kompatibler Testserver. Der Plan nennt MinIO; dessen Images sind nicht mehr
// öffentlich zu ziehen (Docker Hub und quay.io verweigern es, Stand November 2026).
const S3_IMAGE = 'chrislusf/seaweedfs:3.97'
// Wie in compose.yaml: Airlock spricht Docker nur über den Socket-Proxy (EXEC=0)
const PROXY = `${P}-proxy`
const PROXY_IMAGE = 'tecnativa/docker-socket-proxy:0.3.0'
// Ein «Projekt-Container», der für den Modus «stop» angehalten und wieder gestartet wird
const APP = `${P}-app`
const VOL = { data: `${P}_data`, caddy: `${P}_caddy`, sites: `${P}_sites`, staging: `${P}_staging`, target: `${P}_target` }
// Projekt-Volume wie von Compose angelegt (air_<slug>_<name>)
const SLUG = 'e2ebackup'
const PROJECT_VOL = `air_${SLUG}_data`

const here = fileURLToPath(new URL('.', import.meta.url))
// Die docker-CLI nutzt ihren eigenen Kontext; DOCKER_HOST im Prozess ist für Airlock (Proxy)
const CLI_DOCKER_HOST = process.env.DOCKER_HOST
const cliEnv = () => {
  const env = { ...process.env }
  if (CLI_DOCKER_HOST === undefined) delete env.DOCKER_HOST
  else env.DOCKER_HOST = CLI_DOCKER_HOST
  return env
}
const sh = (args: string[], input?: string) => execFileSync('docker', args, { encoding: 'utf8', input, env: cliEnv(), stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const quiet = (args: string[]) => {
  try {
    sh(args)
  } catch {
    /* gab es nicht */
  }
}

function cleanup(): void {
  for (const c of [BACKUP, S3, PROXY, APP]) quiet(['rm', '-f', c])
  // Wegwerf-Container der Volume-Kopie (falls ein Lauf abbrach)
  quiet(['container', 'prune', '-f', '--filter', `label=airlock.project=${SLUG}`])
  for (const v of [...Object.values(VOL), PROJECT_VOL]) quiet(['volume', 'rm', '-f', v])
  quiet(['network', 'rm', NET])
  quiet(['network', 'rm', `air_${SLUG}`])
}

cleanup()
const pgc = await startThrowawayPostgres(`${P}-pg`)
const { check, done } = checker()
// Auftrags-Verzeichnis: Airlock (dieser Prozess) schreibt hier, der Backup-Container sieht es unter /jobs
const JOBS = mkdtempSync(join(tmpdir(), `${P}-jobs-`))

// DOCKER_HOST setzt der Aufbau unten (Socket-Proxy), vor dem Laden der Module
Object.assign(process.env, {
  BACKUP_CONTAINER: BACKUP,
  BACKUP_STAGING_VOLUME: VOL.staging,
  BACKUP_JOBS_DIR: JOBS,
  TZ: 'Europe/Zurich',
})

/** Inhalt aller Dateien im Auftrags-Verzeichnis (zum Suchen nach Geheimnissen) */
const jobsDirText = () => readdirSync(JOBS).map((n) => `${n}\n${readFileSync(join(JOBS, n), 'utf8')}`).join('\n')

const PASSWORD = `e2e-${randomBytes(12).toString('hex')}` // allowlist-secret: zufälliger Testwert
const S3_KEY = 'e2eaccesskey01' // allowlist-secret: S3-Testserver
const S3_SECRET = `e2e-secret-${randomBytes(8).toString('hex')}` // allowlist-secret: S3-Testserver
const MARKER = `GEHEIMER-SCHLUESSEL-${randomBytes(6).toString('hex')}`

// ntfy-Attrappe: fängt Benachrichtigungen auf
const pushes: { title: string; message: string }[] = []
const ntfy = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    try {
      pushes.push(JSON.parse(body))
    } catch {
      /* egal */
    }
    res.end('{}')
  })
})
await new Promise<void>((r) => ntfy.listen(0, '127.0.0.1', r))
const ntfyUrl = `http://127.0.0.1:${(ntfy.address() as { port: number }).port}`

try {
  /* --- Aufbau ------------------------------------------------------------------- */
  sh(['network', 'create', NET])
  sh(['network', 'connect', '--alias', 'postgres', NET, `${P}-pg`])
  for (const v of Object.values(VOL)) sh(['volume', 'create', v])
  sh(['volume', 'create', '--label', `com.docker.compose.project=air_${SLUG}`, '--label', 'com.docker.compose.volume=data', PROJECT_VOL])
  // Daten wie auf dem Server: keys/secrets.key (darf NIE ins Backup), ein Chat-Repo, eine Seite
  sh(['run', '--rm', '-v', `${VOL.data}:/d`, '-v', `${VOL.sites}:/s`, '-v', `${VOL.caddy}:/c`, '-v', `${PROJECT_VOL}:/p`, 'alpine:3.20', 'sh', '-c',
    `mkdir -p /d/keys /d/repos/demo /d/work/tmp /s/demo /c/caddy && echo ${MARKER} > /d/keys/secrets.key && echo hallo > /d/repos/demo/README.md ` +
    `&& echo tmp > /d/work/tmp/x && echo '<h1>Demo</h1>' > /s/demo/index.html && echo cert > /c/caddy/cert.pem && head -c 2000000 /dev/urandom > /p/blob.bin`])
  sh(['build', '-t', IMAGE, resolve(here, '../../../backup')])
  sh(['run', '-d', '--name', BACKUP, '--hostname', 'airlock-backup', '--init', '--network', NET,
    '-e', 'PGHOST=postgres', '-e', 'PGUSER=airlock', '-e', 'PGPASSWORD=test', '-e', 'PGDATABASE=airlock',
    '-v', `${VOL.caddy}:/source/caddy_data:ro`, '-v', `${VOL.sites}:/source/sites:ro`, '-v', `${VOL.data}:/source/data:ro`,
    '-v', `${VOL.staging}:/staging`, '-v', `${VOL.target}:/target`, '-v', `${JOBS}:/jobs`, IMAGE])
  const s3Config = JSON.stringify({ identities: [{ name: 'e2e', credentials: [{ accessKey: S3_KEY, secretKey: S3_SECRET }], actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'] }] })
  sh(['run', '-d', '--name', S3, '--network', NET, '--network-alias', 's3', '-e', `S3CFG=${s3Config}`, '--entrypoint', 'sh', S3_IMAGE, '-c',
    'printf "%s" "$S3CFG" > /tmp/s3.json && exec weed server -dir=/data -s3 -s3.port=8333 -s3.config=/tmp/s3.json -volume.max=0'])
  sh(['run', '-d', '--name', APP, '--label', 'airlock.managed=true', '--label', `airlock.project=${SLUG}`, '-v', `${PROJECT_VOL}:/p`, 'alpine:3.20', 'sleep', '3600'])

  // Socket-Proxy mit denselben Schaltern wie compose.yaml, auf einem freien Port nur für localhost
  if (process.env.E2E_DOCKER_HOST) process.env.DOCKER_HOST = process.env.E2E_DOCKER_HOST
  else {
    const flags = [
      ...['CONTAINERS', 'IMAGES', 'NETWORKS', 'VOLUMES', 'INFO', 'VERSION', 'POST', 'BUILD'].map((f) => `${f}=1`),
      'EXEC=0',
    ].flatMap((f) => ['-e', f])
    sh(['run', '-d', '--name', PROXY, ...flags, '-v', '/var/run/docker.sock:/var/run/docker.sock:ro', '-p', '127.0.0.1::2375', PROXY_IMAGE])
    const port = sh(['port', PROXY, '2375']).split('\n')[0]!.split(':').pop()
    process.env.DOCKER_HOST = `tcp://127.0.0.1:${port}`
    await new Promise((r) => setTimeout(r, 1500))
  }

  // exec über den Proxy: Anlegen fällt unter CONTAINERS, Starten unter EXEC – das muss scheitern
  const api = process.env.DOCKER_HOST!.replace(/^tcp:/, 'http:')
  const created = await fetch(`${api}/containers/${BACKUP}/exec`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ Cmd: ['true'], AttachStdout: true }),
  })
  const execId = created.ok ? ((await created.json()) as { Id: string }).Id : null
  const startedExec = execId
    ? await fetch(`${api}/exec/${execId}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ Detach: true }) })
    : null
  check(!created.ok || startedExec?.status === 403, 'Socket-Proxy mit EXEC 0: exec wird abgelehnt', { create: created.status, start: startedExec?.status })

  const { pool } = await import('../src/db/index.js')
  const { runMigrations } = await import('../src/db/migrate.js')
  const { importLegacySettings } = await import('../src/domain/environments.js')
  const { putNotifySettings } = await import('../src/notify/send.js')
  const { putBackupSettings, getBackupSettings } = await import('../src/backup/settings.js')
  const { testConnection, listSnapshots } = await import('../src/backup/service.js')
  const { startBackup, backupStatus } = await import('../src/backup/run.js')
  const { runBackupJob } = await import('../src/jobs/backup.js')
  await runMigrations(() => {})
  await importLegacySettings()
  await pool.query("INSERT INTO projects (name, slug, source_type, environment_id) SELECT 'E2E Backup', $1, 'compose', id FROM environments WHERE is_default", [SLUG])
  await putNotifySettings({ ntfy: { url: ntfyUrl, topic: 'airlock-e2e' } }, 'e2e')

  const restic = (repo: string, args: string[], extra: string[] = []) =>
    sh(['exec', '-e', `RESTIC_REPOSITORY=${repo}`, '-e', `RESTIC_PASSWORD=${PASSWORD}`, ...extra, BACKUP, 'restic', ...args])

  /* --- Etappe 1: lokales Ziel ----------------------------------------------------- */
  await putBackupSettings({ target: { kind: 'local', path: '/target/airlock' }, password: PASSWORD }, 'e2e')
  const raw = (await pool.query("SELECT value FROM app_settings WHERE key = 'backup_settings'")).rows[0]?.value as string
  check(!!raw && !raw.includes(PASSWORD), 'Passwort nicht im Klartext in app_settings')
  const dto = await getBackupSettings()
  check(dto.configured && dto.hasPassword && !JSON.stringify(dto).includes(PASSWORD), 'Einstellungen ohne Passwort in der Antwort', dto)

  const t1 = await testConnection('e2e')
  check(t1.ok && t1.initialized, 'Verbindung testen: lokales Repository angelegt', t1)
  const t2 = await testConnection('e2e')
  check(t2.ok && !t2.initialized, 'Verbindung testen: zweites Mal nur erreicht', t2)

  /* --- Etappe 2: zwei Läufe, Deduplizierung --------------------------------------- */
  const r1 = await (await startBackup('manual', 'e2e')).done
  check(r1.status === 'ok' && !!r1.snapshotId && (r1.bytesNew ?? 0) > 1_000_000, 'Erster Lauf erfolgreich (mit Projekt-Volume)', r1)
  const r2 = await (await startBackup('manual', 'e2e')).done
  check(r2.status === 'ok' && (r2.bytesNew ?? Infinity) < (r1.bytesNew ?? 0) / 4, 'Zweiter Lauf dedupliziert klein', { first: r1.bytesNew, second: r2.bytesNew })
  check((await listSnapshots()).length === 2, 'Zwei Stände im Repository')

  const files = restic('/target/airlock', ['ls', 'latest'])
  check(!files.includes('secrets.key') && !files.includes('/source/data/keys'), 'secrets.key in keinem Stand')
  check(files.includes('/source/data/repos/demo/README.md'), 'Daten-Volume gesichert')
  check(!files.includes('/source/data/work/'), 'Zwischenstände (work/) ausgeschlossen')
  check(files.includes('/staging/db/airlock.dump'), 'Datenbank-Dump im Stand')
  check(files.includes(`/staging/volumes/${SLUG}/data/blob.bin`), 'Projekt-Volume im Stand')
  check(files.includes('/source/sites/demo/index.html') && files.includes('/source/caddy_data/caddy/cert.pem'), 'Seiten und Caddy-Speicher im Stand')
  const grep = restic('/target/airlock', ['dump', 'latest', '/source/data'], []).includes(MARKER)
  check(!grep, 'Inhalt von secrets.key nicht im Stand')
  const staging = sh(['exec', BACKUP, 'sh', '-c', 'ls /staging'])
  check(!staging.split('\n').includes('db') && !staging.split('\n').includes('volumes'), 'Staging nach dem Lauf leer (bis auf den Cache)', staging)

  /* --- Aufträge statt exec ------------------------------------------------------------ */
  check(readdirSync(JOBS).length === 0, 'Auftrags-Verzeichnis nach den Läufen leer', readdirSync(JOBS))
  const { runJob } = await import('../src/backup/dispatch.js')
  const masterkey = await runJob(JOBS, { op: 'restic', args: ['cat', 'masterkey'], env: { RESTIC_REPOSITORY: '/target/airlock', RESTIC_PASSWORD: PASSWORD }, timeoutMs: 30_000 })
  check(masterkey.exitCode === 126 && /nur mit config/.test(masterkey.stderr.join('\n')) && !masterkey.stdout.join('').includes('"encrypt"'),
    'Ausführer lehnt «restic cat masterkey» ab', masterkey)
  const repoArg = await runJob(JOBS, { op: 'restic', args: ['snapshots', '--password-command', 'cat /source/data/keys/secrets.key'], timeoutMs: 30_000 })
  check(repoArg.exitCode === 126, 'Ausführer lehnt --password-command ab', repoArg)
  check(readdirSync(JOBS).length === 0, 'Auch abgelehnte Aufträge hinterlassen nichts (Geheimnis gelöscht)', readdirSync(JOBS))

  /* --- Aufbewahrung ------------------------------------------------------------------ */
  await putBackupSettings({ retention: { daily: 1, weekly: 0, monthly: 0 } }, 'e2e')
  const r3 = await (await startBackup('manual', 'e2e')).done
  const snaps = await listSnapshots()
  check(r3.status === 'ok' && snaps.length === 1 && snaps[0]!.id === r3.snapshotId, 'Aufbewahrung entfernt alte Stände', { status: r3.status, snaps: snaps.length })
  await putBackupSettings({ retention: { daily: 7, weekly: 4, monthly: 6 } }, 'e2e')

  /* --- Projekt-Volumes mit kurzem Stopp ------------------------------------------------ */
  const startedAt = () => sh(['inspect', '-f', '{{.State.Running}} {{.State.StartedAt}}', APP])
  const before = startedAt()
  await putBackupSettings({ projects: { [SLUG]: 'stop' } }, 'e2e')
  const rs = await (await startBackup('manual', 'e2e')).done
  const after = startedAt()
  check(rs.status === 'ok' && after.startsWith('true') && after !== before, 'Modus «stop»: Projekt angehalten, gesichert, wieder gestartet', { status: rs.status, before, after, warnings: rs.warnings })
  await putBackupSettings({ projects: { [SLUG]: 'skip' } }, 'e2e')
  const rk = await (await startBackup('manual', 'e2e')).done
  check(rk.status === 'ok' && !restic('/target/airlock', ['ls', 'latest']).includes(`/staging/volumes/${SLUG}/`), 'Modus «skip»: Projekt-Volume nicht im Stand')
  await putBackupSettings({ projects: {} }, 'e2e')

  /* --- Etappe 1: S3 (Testserver) -------------------------------------------------------- */
  // Bucket vorher anlegen: SeaweedFS merkt sich ein «Bucket fehlt» aus dem ersten
  // «restic cat config» und findet danach die von init geschriebene config nicht
  // (Exit 10). Echte S3-Anbieter tun das nicht; restic legt den Bucket sonst selbst an.
  for (let i = 0; ; i++) {
    try {
      sh(['exec', S3, 'sh', '-c', 'echo "s3.bucket.create -name airlock-e2e" | weed shell 2>&1 | grep -q "created bucket"'])
      break
    } catch {
      if (i > 30) throw new Error('S3-Testserver legt keinen Bucket an')
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  await putBackupSettings({ target: { kind: 's3', endpoint: 'http://s3:8333', bucket: 'airlock-e2e', prefix: 'server1', region: 'us-east-1', accessKeyId: S3_KEY, secretAccessKey: S3_SECRET } }, 'e2e')
  const s3raw = (await pool.query("SELECT value FROM app_settings WHERE key = 'backup_settings'")).rows[0]?.value as string
  check(!s3raw.includes(S3_SECRET) && !s3raw.includes(S3_KEY), 'S3-Zugangsdaten nicht im Klartext in app_settings')
  let s3t = await testConnection('e2e')
  for (let i = 0; i < 15 && !s3t.ok; i++) {
    // Der Testserver braucht ein paar Sekunden
    await new Promise((r) => setTimeout(r, 2000))
    s3t = await testConnection('e2e')
  }
  check(s3t.ok, 'S3: Repository angelegt und erreichbar', s3t)
  const r4 = await (await startBackup('manual', 'e2e')).done
  check(r4.status === 'ok' && !!r4.snapshotId, 'S3: Lauf erfolgreich', r4)
  check((await listSnapshots()).length === 1, 'S3: ein Stand im Repository')
  const wrongPw = await (async () => {
    await putBackupSettings({ password: 'ein-ganz-anderes-passwort' }, 'e2e') // absichtlich falsches Test-Passwort, allowlist-secret
    const r = await testConnection('e2e')
    await putBackupSettings({ password: PASSWORD }, 'e2e')
    return r
  })()
  check(!wrongPw.ok && /Passwort passt nicht/.test(wrongPw.message), 'S3: falsches Repository-Passwort erkannt', wrongPw)

  /* --- Falsches Ziel: Fehlschlag mit Benachrichtigung ------------------------------------ */
  pushes.length = 0
  await putBackupSettings({ target: { kind: 's3', endpoint: 'http://gibt-es-nicht:9000', bucket: 'airlock-e2e', prefix: '', region: '' } }, 'e2e')
  const bad = await testConnection('e2e')
  check(!bad.ok && !bad.message.includes(S3_SECRET), 'Falsches Ziel: Test schlägt fehl, ohne Zugangsdaten in der Meldung', bad)
  const r5 = await (await startBackup('manual', 'e2e')).done
  check(r5.status === 'failed' && !!r5.error && !r5.error.includes(S3_SECRET), 'Falsches Ziel: Lauf scheitert', r5)
  await new Promise((r) => setTimeout(r, 500))
  check(pushes.some((p) => p.title === 'Backup fehlgeschlagen'), 'Benachrichtigung «Backup fehlgeschlagen» verschickt', pushes)

  /* --- 48 h ohne Erfolg (Zeit vorgestellt) ----------------------------------------------- */
  pushes.length = 0
  const job = await runBackupJob(new Date(Date.now() + 49 * 3600_000))
  await new Promise((r) => setTimeout(r, 500))
  check(job.staleNotified && pushes.some((p) => p.title === 'Seit über 48 Stunden kein Backup'), '«48 h ohne Erfolg» gemeldet', { job, pushes })
  const again = await runBackupJob(new Date(Date.now() + 50 * 3600_000))
  check(!again.staleNotified, '«48 h ohne Erfolg» höchstens einmal pro Tag')
  check((await backupStatus()).runs.length >= 5, 'Läufe in backup_runs')

  /* --- Nichts Geheimes im Audit-Log ---------------------------------------------------- */
  const audit = (await pool.query("SELECT params_masked::text AS p, coalesce(error, '') AS e FROM audit_events WHERE action LIKE 'backup.%'")).rows as { p: string; e: string }[]
  check(audit.length > 0 && audit.every((a) => ![PASSWORD, S3_SECRET, S3_KEY].some((s) => a.p.includes(s) || a.e.includes(s))), 'Audit-Einträge ohne Passwort und Zugangsdaten', audit.length)
  check(audit.length > 0, 'Audit-Einträge zu Backup vorhanden')

  /* --- Nichts Geheimes im Auftrags-Verzeichnis und im Log des Ausführers ------------------- */
  const leftover = jobsDirText()
  check(![PASSWORD, S3_SECRET, S3_KEY].some((s) => leftover.includes(s)) && !readdirSync(JOBS).some((n) => n.endsWith('.env')),
    'Kein Geheimnis im Auftrags-Verzeichnis liegen geblieben', readdirSync(JOBS))
  const runnerLog = execFileSync('docker', ['logs', BACKUP], { encoding: 'utf8', env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  check(/runner: bereit/.test(runnerLog) && ![PASSWORD, S3_SECRET, S3_KEY].some((s) => runnerLog.includes(s)), 'Log des Ausführers ohne Geheimnisse')
  await pool.end()
} catch (err) {
  check(false, 'Ablauf ohne Ausnahme', String((err as Error).stack ?? err))
} finally {
  ntfy.close()
  cleanup()
  // throwaway-pg ruft docker mit process.env auf
  process.env = cliEnv()
  pgc.stop()
  // Erst jetzt frei: die Wegwerf-Datenbank hing noch im Netz
  quiet(['network', 'rm', NET])
  rmSync(JOBS, { recursive: true, force: true })
}
done()
