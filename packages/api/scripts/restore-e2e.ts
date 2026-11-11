/**
 * Meilenstein Backup, Etappe 5: automatischer Wiederherstellungstest gegen
 * einen Wegwerf-Aufbau – Backup → alles löschen → Restore → prüfen.
 *
 *   pnpm --filter @airlock/api e2e:restore
 *
 * Braucht Docker; lädt beim ersten Mal restic/restic, postgres:17-alpine,
 * alpine:3.20 (dazu age und openssl aus Alpine) und den Socket-Proxy. Berührt
 * keinen laufenden Stack: eigene Namen (airlock-restore-e2e*), eigenes Netz,
 * eigene Volumes, Daten in einem temporären Ordner.
 *
 * Aufbau wie im Stack, nur ohne Caddy und ohne Airlock-Container: Airlock
 * läuft hier im Prozess (je Abschnitt ein eigener Prozess, damit nichts aus
 * dem Speicher – etwa der geladene Schlüssel – die Prüfung verfälscht),
 * spricht Docker nur über den Socket-Proxy mit EXEC=0 und den
 * Backup-Container nur über Aufträge. DATA_DIR, SITES_DIR und CADDY_DATA_DIR
 * sind Host-Ordner, die der Backup-Container unter /source/… sieht – wie die
 * Volumes data, sites und caddy_data im Stack.
 *
 * Ablauf, Schritt für Schritt wie docs/RESTORE.md:
 *  1. vorbereiten (Prozess 1): Datenbank, geändertes Anmelde-Passwort,
 *     Compose-Projekt mit Volume und Secret, Chat-Projekt mit Seite und
 *     Repository, produktives Wildcard-Zertifikat im Caddy-Speicher, Ziel und
 *     Repository-Passwort; Backup; Schlüssel als age-Datei exportieren.
 *  2. Schlüssel in keinem Stand (Bytes, Base64, Hex).
 *  3. alles löschen: Datenbank-Container, Daten, Seiten, Caddy-Speicher,
 *     Projekt-Volume, Staging, Backup-Container. Übrig bleibt nur das Ziel.
 *  4. frischer Aufbau; Schlüssel mit dem echten age aus der Datei holen;
 *     Komplett-Restore mit airlock-restore (backup/restore-all.sh).
 *  5. prüfen (Prozess 2): Anmeldung mit dem geänderten Passwort, Projekte
 *     da, Secrets entschlüsselbar, Zertifikat erkannt, Merker «Schlüssel
 *     gesichert» noch gültig; Projekt-Restore über die API (Vorschau,
 *     Bestätigung, Volume, Seite, Repository), Ausführer lehnt falsche
 *     Angaben ab; kein Schlüssel im Log.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startThrowawayPostgres, checker } from './lib/throwaway-pg.js'

const P = 'airlock-restore-e2e'
const NET = `${P}-net`
const BACKUP = P
const PG = `${P}-pg`
const PROXY = `${P}-proxy`
const IMAGE = 'airlock/backup:e2e-restore'
const PROXY_IMAGE = 'tecnativa/docker-socket-proxy:0.3.0'
// Wie im Stack benannte Volumes für data, sites und caddy_data: restic liest Dateien aus
// Host-Ordnern von Docker Desktop (Bind-Mount, macOS) nicht («input/output error»)
const VOL = { staging: `${P}_staging`, target: `${P}_target`, data: `${P}_data`, sites: `${P}_sites`, caddy: `${P}_caddy_data` }
const SRC = (st: { dataDir: string; sitesDir: string; caddyDir: string }) => [[st.dataDir, VOL.data], [st.sitesDir, VOL.sites], [st.caddyDir, VOL.caddy]] as const

/**
 * Airlock läuft hier im Prozess und sieht DATA_DIR usw. als Host-Ordner; der
 * Backup-Container sieht die benannten Volumes. Abgleich in eine Richtung:
 * vor dem Backup Host → Volume, nach dem Komplett-Restore Volume → Host.
 */
function syncToVolumes(st: { dataDir: string; sitesDir: string; caddyDir: string }): void {
  for (const [dir, vol] of SRC(st)) {
    sh(['run', '--rm', '-v', `${dir}:/from:ro`, '-v', `${vol}:/to`, 'alpine:3.20', 'sh', '-c', 'find /to -mindepth 1 -delete && cp -a /from/. /to/'])
  }
}
function syncFromVolumes(st: { dataDir: string; sitesDir: string; caddyDir: string }): void {
  for (const [dir, vol] of SRC(st)) {
    sh(['run', '--rm', '-v', `${vol}:/from:ro`, '-v', `${dir}:/to`, 'alpine:3.20', 'sh', '-c', 'find /to -mindepth 1 -delete && cp -a /from/. /to/'])
  }
}
const COMPOSE_SLUG = 'e2erestore'
const FILES_SLUG = 'e2eseite'
const PROJECT_VOL = `air_${COMPOSE_SLUG}_data`
const APP = `${P}-app`
const BASE = 'e2e.example.ch'

const here = fileURLToPath(new URL('.', import.meta.url))
const phase = process.env.RESTORE_E2E_PHASE ?? 'main'

/* === Gemeinsam ============================================================================ */

const CLI_DOCKER_HOST = process.env.RESTORE_E2E_CLI_DOCKER_HOST ?? process.env.DOCKER_HOST
const cliEnv = () => {
  const env = { ...process.env }
  if (!CLI_DOCKER_HOST) delete env.DOCKER_HOST
  else env.DOCKER_HOST = CLI_DOCKER_HOST
  return env
}
const sh = (args: string[], input?: string) => execFileSync('docker', args, { encoding: 'utf8', input, env: cliEnv(), stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim()
const shBuf = (args: string[]) => execFileSync('docker', args, { env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 })
const quiet = (args: string[]) => {
  try {
    sh(args)
  } catch {
    /* gab es nicht */
  }
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** Alles, was dieser Prozess ausgibt, zum Suchen nach dem Schlüssel */
function captureOutput(): () => string {
  const out: string[] = []
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream)
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof stream.write
  }
  return () => out.join('')
}

interface State {
  root: string
  jobs: string
  dataDir: string
  sitesDir: string
  caddyDir: string
  password: string
  newAdminPassword: string
  passphrase: string
  secret: string
  ageFile?: string
  keySha?: string
  snapshot?: string
  blobSha?: string
  siteHtml?: string
  readme?: string
}
const statePath = () => join(process.env.RESTORE_E2E_ROOT!, 'state.json')
const loadState = (): State => JSON.parse(readFileSync(statePath(), 'utf8')) as State
const saveState = (s: State) => writeFileSync(statePath(), JSON.stringify(s, null, 2))

/** Airlock im Prozess: Datenbank, Umgebungen, Anmelde-Passwort, HTTP-Schicht */
async function airlock() {
  const { pool } = await import('../src/db/index.js')
  const { runMigrations } = await import('../src/db/migrate.js')
  const envs = await import('../src/domain/environments.js')
  const { ensureAdminPassword } = await import('../src/http/auth.js')
  const { buildApp } = await import('../src/http/app.js')
  await runMigrations(() => {})
  await envs.importLegacySettings()
  await envs.reloadEnvironments()
  await ensureAdminPassword()
  const app = await buildApp()
  await app.ready()
  const loginWith = (password: string) => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password } })
  let cookie = ''
  const ui = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const signIn = async (password: string) => {
    const r = await loginWith(password)
    cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    return r
  }
  return { pool, envs, app, ui, signIn, loginWith }
}

/* === Prozess 1: vorbereiten und sichern ======================================================= */

async function prepare(): Promise<void> {
  const output = captureOutput()
  const { check, done } = checker()
  const st = loadState()
  try {
    const { pool, envs, app, ui, signIn } = await airlock()
    const { changePassword } = await import('../src/http/auth.js')
    const { replaceEnv } = await import('../src/domain/env.js')
    const { startBackup } = await import('../src/backup/run.js')
    const { ageDecrypt } = await import('../src/backup/key.js')

    // Anmelde-Passwort in der Oberfläche geändert: nach dem Restore muss DIESES gelten, nicht das aus .env
    await changePassword(process.env.ADMIN_PASSWORD!, st.newAdminPassword)
    check((await signIn(st.newAdminPassword)).statusCode === 200, 'Anmeldung mit dem geänderten Passwort')

    const env = envs.defaultEnvironmentId()
    const [compose] = (await pool.query("INSERT INTO projects (name, slug, source_type, environment_id, desired_state) VALUES ('E2E Restore', $1, 'compose', $2, 'running') RETURNING id", [COMPOSE_SLUG, env])).rows as { id: string }[]
    await pool.query("INSERT INTO projects (name, slug, source_type, environment_id, local_repo_path) VALUES ('E2E Seite', $1, 'files', $2, $3)", [FILES_SLUG, env, join(st.dataDir, 'repos', FILES_SLUG)])
    await replaceEnv(compose!.id, [{ key: 'API_KEY', value: st.secret, isSecret: true }, { key: 'MODE', value: 'prod', isSecret: false }])
    const raw = (await pool.query('SELECT value_encrypted FROM project_env WHERE key = $1', ['API_KEY'])).rows[0] as { value_encrypted: Buffer | string } | undefined
    check(!!raw && !String(raw.value_encrypted).includes(st.secret), 'Secret des Projekts verschlüsselt in der Datenbank')

    const s = await ui('PUT', '/system/backup/settings', { target: { kind: 'local', path: '/target/airlock' }, password: st.password })
    check(s.statusCode === 200, 'Ziel lokal und Repository-Passwort eingerichtet', s.body.slice(0, 200))
    const t = await ui('POST', '/system/backup/test')
    check(t.statusCode === 200 && t.json().ok === true, 'Verbindung testen: Repository angelegt', t.body)

    // Schlüssel als age-Datei (frische Anmeldung), Merker setzen – vor dem Backup, damit der Merker im Stand ist
    const f = await ui('POST', '/system/backup/key/file', { password: st.newAdminPassword, passphrase: st.passphrase })
    const file = Buffer.from((f.json() as { file: string }).file, 'base64')
    st.ageFile = join(st.root, 'airlock-secrets-key.age')
    writeFileSync(st.ageFile, file)
    const key = readFileSync(join(st.dataDir, 'keys', 'secrets.key'))
    st.keySha = sha(key)
    check(ageDecrypt(file, st.passphrase).equals(key), 'Schlüssel als age-Datei exportiert (Wiedereinlesen ergibt denselben Schlüssel)')
    const c = await ui('POST', '/system/backup/key/confirm', { method: 'file' })
    check(c.statusCode === 200, 'Merker «Schlüssel gesichert» gesetzt')

    // Stand der Host-Ordner in die Volumes, die der Backup-Container liest (mit keys/secrets.key – den schliesst restic aus)
    syncToVolumes(st)
    const run = await (await startBackup('manual', 'e2e')).done
    check(run.status === 'ok' && !!run.snapshotId, 'Backup erfolgreich', run)
    st.snapshot = run.snapshotId ?? undefined

    check(!output().includes(key.toString('base64')) && !output().includes(key.toString('hex')), 'Keine Log-Zeile enthält den Schlüssel (vorbereiten)')
    saveState(st)
    await app.close()
    await pool.end()
  } catch (err) {
    check(false, 'vorbereiten ohne Ausnahme', String((err as Error).stack ?? err))
  }
  done()
}

/* === Prozess 2: nach dem Restore prüfen ======================================================== */

async function verify(): Promise<void> {
  const output = captureOutput()
  const { check, done } = checker()
  const st = loadState()
  try {
    const { pool, envs, app, ui, signIn, loginWith } = await airlock()
    const { resolveEnv } = await import('../src/domain/env.js')
    const { resolveSettings } = await import('../src/backup/settings.js')
    const { storedProductionWildcard } = await import('../src/lib/caddy-storage.js')
    const { runJob } = await import('../src/backup/dispatch.js')
    const { keyFingerprint } = await import('../src/backup/key.js')

    // Anmeldung: das in der Oberfläche geänderte Passwort gilt, nicht das aus .env
    check((await loginWith(process.env.ADMIN_PASSWORD!)).statusCode === 401, 'Passwort aus .env gilt nicht (Datenbank zurück, nicht neu)')
    const login = await signIn(st.newAdminPassword)
    check(login.statusCode === 200, 'Login klappt (geändertes Passwort aus dem Backup)')

    // Projekte
    const envSlug = envs.defaultEnvironment().slug
    const list = (await ui('GET', `/environments/${envSlug}/projects`)).json() as { projects: { slug: string; id: string }[] }
    const slugs = list.projects.map((p) => p.slug).sort()
    check(slugs.includes(COMPOSE_SLUG) && slugs.includes(FILES_SLUG), 'Projekte da', slugs)
    const compose = list.projects.find((p) => p.slug === COMPOSE_SLUG)!

    // Secrets entschlüsselbar
    const env = await resolveEnv(compose.id)
    check(env.API_KEY === st.secret && env.MODE === 'prod', 'Secrets entschlüsselbar (Projekt-Variable)')
    const bs = await resolveSettings()
    check(bs.password === st.password && bs.configured, 'Secrets entschlüsselbar (Repository-Passwort)')
    const key = readFileSync(join(st.dataDir, 'keys', 'secrets.key'))
    check(sha(key) === st.keySha, 'Schlüssel aus der age-Datei ist der alte')

    // Zertifikat
    const cert = storedProductionWildcard(st.caddyDir, BASE)
    check(!!cert && cert.sans.includes(`*.${BASE}`), 'Zertifikat von Caddy erkannt (produktives Wildcard im Caddy-Speicher)', cert)

    // Daten
    check(readFileSync(join(st.sitesDir, FILES_SLUG, 'v1', 'index.html'), 'utf8') === st.siteHtml, 'Statische Seite zurück')
    check(readFileSync(join(st.dataDir, 'repos', FILES_SLUG, 'README.md'), 'utf8') === st.readme, 'Lokales Repository zurück')
    check(!readdirSync(st.dataDir).includes('work'), 'Zwischenstände (work/) nicht zurückgeholt')

    // Merker «Schlüssel gesichert» gilt weiter (gleicher Schlüssel)
    const status = (await ui('GET', '/system/backup')).json() as { key: { savedAt: string | null; fingerprint: string }; restore: unknown }
    check(!!status.key.savedAt && status.key.fingerprint === keyFingerprint(key), 'Merker «Schlüssel gesichert am …» noch gültig')

    /* --- Projekt-Restore ------------------------------------------------------------------- */
    const snap = st.snapshot!
    const prev = await ui('GET', `/system/backup/restore/preview?snapshot=${snap.slice(0, 8)}&project=${COMPOSE_SLUG}`)
    const preview = prev.json() as { parts: { kind: string; name: string; files: number; bytes: number }[]; runningContainers: number }
    check(prev.statusCode === 200 && preview.parts.some((p) => p.kind === 'volume' && p.name === 'data' && p.files === 1 && p.bytes === 2_000_000),
      'Vorschau: Volume data mit 1 Datei (2 MB)', prev.body.slice(0, 400))
    check(preview.runningContainers === 1, 'Vorschau: ein laufender Container wird gestoppt', preview.runningContainers)

    const wrong = await ui('POST', '/system/backup/restore', { snapshot: snap, project: COMPOSE_SLUG, confirm: 'falsch' })
    check(wrong.statusCode === 400 && /eintippen|Tippe/.test(wrong.body), 'Restore ohne richtige Bestätigung abgelehnt', wrong.body)

    const waitRestore = async () => {
      for (let i = 0; i < 300; i++) {
        const s = (await ui('GET', '/system/backup')).json() as { restore: { status: string; restored: string[]; error: string | null; warnings: string[] } | null }
        if (s.restore && s.restore.status !== 'running') return s.restore
        await new Promise((r) => setTimeout(r, 1000))
      }
      return null
    }
    const r1 = await ui('POST', '/system/backup/restore', { snapshot: snap, project: COMPOSE_SLUG, confirm: COMPOSE_SLUG })
    check(r1.statusCode === 202, 'Restore des Compose-Projekts gestartet (202)', r1.body)
    const busy = await ui('POST', '/system/backup/run')
    check(busy.statusCode === 409, 'Während des Restores kein Backup (409)', busy.statusCode)
    const done1 = await waitRestore()
    check(done1?.status === 'ok' && done1.restored.includes('Volume data'), 'Restore: Volume zurück', done1)

    // Chat-Projekt: Seite kaputt, Repository weg → zurück
    writeFileSync(join(st.sitesDir, FILES_SLUG, 'v1', 'index.html'), 'kaputt')
    rmSync(join(st.dataDir, 'repos', FILES_SLUG), { recursive: true, force: true })
    const r2 = await ui('POST', '/system/backup/restore', { snapshot: snap, project: FILES_SLUG, confirm: FILES_SLUG })
    const done2 = r2.statusCode === 202 ? await waitRestore() : null
    check(done2?.status === 'ok' && done2.restored.includes('Statische Seite') && done2.restored.includes('Repository'), 'Restore: Seite und Repository', done2 ?? r2.body)
    check(readFileSync(join(st.sitesDir, FILES_SLUG, 'v1', 'index.html'), 'utf8') === st.siteHtml, 'Seite wieder wie im Stand')
    check(readFileSync(join(st.dataDir, 'repos', FILES_SLUG, 'README.md'), 'utf8') === st.readme, 'Repository wieder wie im Stand')

    const audit = (await pool.query("SELECT target_id, result FROM audit_events WHERE action = 'backup.restore'")).rows as { target_id: string; result: string }[]
    check(audit.length === 2 && audit.every((a) => a.result === 'ok') && audit.some((a) => a.target_id === compose.id), 'Audit «backup.restore» am Projekt')

    // Ausführer: nur feste Angaben
    const jobs = process.env.BACKUP_JOBS_DIR!
    const bad1 = await runJob(jobs, { op: 'restore-project', args: ['latest', COMPOSE_SLUG], timeoutMs: 30_000 })
    const bad2 = await runJob(jobs, { op: 'restore-project', args: [snap.slice(0, 8), '../keys'], timeoutMs: 30_000 })
    const bad3 = await runJob(jobs, { op: 'restic', args: ['restore', snap, '--target', '/staging/x'], timeoutMs: 30_000 })
    check(bad1.exitCode === 126 && bad2.exitCode === 126 && bad3.exitCode === 126, 'Ausführer lehnt «latest», «../keys» und freies «restic restore» ab', [bad1.exitCode, bad2.exitCode, bad3.exitCode])
    check(readdirSync(jobs).length === 0, 'Auftrags-Verzeichnis leer')

    check(!output().includes(key.toString('base64')) && !output().includes(key.toString('hex')), 'Keine Log-Zeile enthält den Schlüssel (prüfen)')
    await app.close()
    await pool.end()
  } catch (err) {
    check(false, 'prüfen ohne Ausnahme', String((err as Error).stack ?? err))
  }
  done()
}

/* === Hauptprozess: Docker-Aufbau, Löschen, Komplett-Restore ===================================== */

async function main(): Promise<void> {
  const { check, done } = checker()
  const root = mkdtempSync(join(tmpdir(), `${P}-`))
  const st: State = {
    root,
    jobs: join(root, 'jobs'),
    dataDir: join(root, 'data'),
    sitesDir: join(root, 'sites'),
    caddyDir: join(root, 'caddy-data'),
    password: `e2e-${randomBytes(12).toString('hex')}`, // allowlist-secret: zufälliger Testwert
    newAdminPassword: `e2e-admin-${randomBytes(8).toString('hex')}`, // allowlist-secret: zufälliger Testwert
    passphrase: `e2e-passphrase-${randomBytes(8).toString('hex')}`, // allowlist-secret: zufälliger Testwert
    secret: `sk-e2e-${randomBytes(10).toString('hex')}`, // allowlist-secret: zufälliger Testwert
  }
  for (const d of [st.jobs, st.dataDir, st.sitesDir, st.caddyDir]) mkdirSync(d, { recursive: true })
  process.env.RESTORE_E2E_ROOT = root
  saveState(st)

  const cleanup = () => {
    for (const c of [BACKUP, PROXY, APP, PG]) quiet(['rm', '-f', c])
    quiet(['container', 'prune', '-f', '--filter', `label=airlock.project=${COMPOSE_SLUG}`])
    quiet(['container', 'prune', '-f', '--filter', `label=airlock.project=${FILES_SLUG}`])
    for (const v of [...Object.values(VOL), PROJECT_VOL]) quiet(['volume', 'rm', '-f', v])
    for (const n of [NET, `air_${COMPOSE_SLUG}`, `air_${FILES_SLUG}`]) quiet(['network', 'rm', n])
  }

  const startBackupContainer = () => sh(['run', '-d', '--name', BACKUP, '--hostname', 'airlock-backup', '--init', '--network', NET,
    '-e', 'PGHOST=postgres', '-e', 'PGUSER=airlock', '-e', 'PGPASSWORD=test', '-e', 'PGDATABASE=airlock',
    '-v', `${VOL.caddy}:/source/caddy_data:ro`, '-v', `${VOL.sites}:/source/sites:ro`, '-v', `${VOL.data}:/source/data:ro`,
    '-v', `${VOL.staging}:/staging`, '-v', `${VOL.target}:/target`, '-v', `${st.jobs}:/jobs`, IMAGE])
  const startApp = () => sh(['run', '-d', '--name', APP, '--label', 'airlock.managed=true', '--label', `airlock.project=${COMPOSE_SLUG}`, '-v', `${PROJECT_VOL}:/p`, 'alpine:3.20', 'sleep', '3600'])
  const createProjectVolume = () => sh(['volume', 'create', '--label', `com.docker.compose.project=air_${COMPOSE_SLUG}`, '--label', 'com.docker.compose.volume=data', PROJECT_VOL])
  /** Wegwerf-Postgres mit Netz-Alias «postgres»; die Daten-Pfade bleiben unsere */
  const freshPostgres = async () => {
    // throwaway-pg ruft die docker-CLI mit process.env auf (exec für pg_isready): nicht über den Proxy
    const proxy = process.env.DOCKER_HOST
    const viaProxy = !!proxy && proxy !== CLI_DOCKER_HOST
    if (viaProxy) {
      if (CLI_DOCKER_HOST) process.env.DOCKER_HOST = CLI_DOCKER_HOST
      else delete process.env.DOCKER_HOST
    }
    const pgc = await startThrowawayPostgres(PG)
    // throwaway-pg setzt DOCKER_HOST auf eine tote Adresse und eigene Daten-Pfade: zurück auf unsere
    if (viaProxy) process.env.DOCKER_HOST = proxy
    else if (CLI_DOCKER_HOST) process.env.DOCKER_HOST = CLI_DOCKER_HOST
    else delete process.env.DOCKER_HOST
    Object.assign(process.env, { DATA_DIR: st.dataDir, SITES_DIR: st.sitesDir, CADDY_DATA_DIR: st.caddyDir })
    sh(['network', 'connect', '--alias', 'postgres', NET, PG])
    return pgc
  }
  const child = (name: string) => {
    const r = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: { ...process.env, RESTORE_E2E_PHASE: name, RESTORE_E2E_CLI_DOCKER_HOST: CLI_DOCKER_HOST ?? '' },
      stdio: 'inherit',
    })
    return r.status === 0
  }

  cleanup()
  const pgDirs: string[] = []
  try {
    /* --- Aufbau ------------------------------------------------------------------------------ */
    sh(['network', 'create', NET])
    let pgc = await freshPostgres()
    pgDirs.push(pgc.dir)
    for (const v of Object.values(VOL)) sh(['volume', 'create', v])
    createProjectVolume()
    sh(['run', '--rm', '-v', `${PROJECT_VOL}:/p`, 'alpine:3.20', 'sh', '-c', 'head -c 2000000 /dev/urandom > /p/blob.bin'])
    st.blobSha = sh(['run', '--rm', '-v', `${PROJECT_VOL}:/p`, 'alpine:3.20', 'sha256sum', '/p/blob.bin']).split(/\s+/)[0]
    // Seite, Repository, Zwischenstand; Zertifikat wie von Caddy (CertMagic) abgelegt
    st.siteHtml = `<h1>E2E ${randomBytes(4).toString('hex')}</h1>`
    st.readme = `# E2E ${randomBytes(4).toString('hex')}\n`
    mkdirSync(join(st.sitesDir, FILES_SLUG, 'v1'), { recursive: true })
    writeFileSync(join(st.sitesDir, FILES_SLUG, 'v1', 'index.html'), st.siteHtml)
    mkdirSync(join(st.dataDir, 'repos', FILES_SLUG), { recursive: true })
    writeFileSync(join(st.dataDir, 'repos', FILES_SLUG, 'README.md'), st.readme)
    mkdirSync(join(st.dataDir, 'work', 'tmp'), { recursive: true })
    writeFileSync(join(st.dataDir, 'work', 'tmp', 'x'), 'tmp')
    const certSub = `caddy/certificates/acme-v02.api.letsencrypt.org-directory/wildcard_.${BASE}`
    mkdirSync(join(st.caddyDir, certSub), { recursive: true })
    sh(['run', '--rm', '-v', `${st.caddyDir}:/c`, 'alpine:3.20', 'sh', '-c',
      'apk add -q --no-cache openssl >/dev/null && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 90 ' +
      `-subj "/O=E2E Test CA/CN=*.${BASE}" -addext "subjectAltName=DNS:*.${BASE}" ` +
      `-keyout "/c/${certSub}/wildcard_.${BASE}.key" -out "/c/${certSub}/wildcard_.${BASE}.crt" 2>/dev/null`])
    saveState(st)

    sh(['build', '-q', '-t', IMAGE, resolve(here, '../../../backup')])
    startBackupContainer()
    startApp()
    const flags = [...['CONTAINERS', 'IMAGES', 'NETWORKS', 'VOLUMES', 'INFO', 'VERSION', 'POST', 'BUILD'].map((f) => `${f}=1`), 'EXEC=0'].flatMap((f) => ['-e', f])
    sh(['run', '-d', '--name', PROXY, ...flags, '-v', '/var/run/docker.sock:/var/run/docker.sock:ro', '-p', '127.0.0.1::2375', PROXY_IMAGE])
    const port = sh(['port', PROXY, '2375']).split('\n')[0]!.split(':').pop()
    await new Promise((r) => setTimeout(r, 1500))
    Object.assign(process.env, {
      DOCKER_HOST: `tcp://127.0.0.1:${port}`,
      BACKUP_CONTAINER: BACKUP,
      BACKUP_STAGING_VOLUME: VOL.staging,
      BACKUP_JOBS_DIR: st.jobs,
      TZ: 'Europe/Zurich',
    })

    /* --- 1. vorbereiten und sichern ----------------------------------------------------------- */
    check(child('vorbereiten'), 'Abschnitt «vorbereiten» grün')
    const s1 = loadState()
    Object.assign(st, s1)
    if (!st.snapshot || !st.ageFile) throw new Error('Kein Stand oder keine Schlüssel-Datei – Abbruch')
    const key = readFileSync(join(st.dataDir, 'keys', 'secrets.key'))

    /* --- 2. Schlüssel in keinem Stand -------------------------------------------------------- */
    const tar = shBuf(['exec', '-e', 'RESTIC_REPOSITORY=/target/airlock', '-e', `RESTIC_PASSWORD=${st.password}`, '-e', 'RESTIC_CACHE_DIR=/staging/cache',
      BACKUP, 'restic', 'dump', '--archive', 'tar', st.snapshot, '/'])
    check(tar.length > 2_000_000, 'Ganzer Stand als Tar gelesen', tar.length)
    check(!tar.includes(key) && !tar.includes(Buffer.from(key.toString('base64'))) && !tar.includes(Buffer.from(key.toString('hex'))),
      'Schlüssel in keinem Stand (weder Bytes noch Base64 noch Hex)')
    const files = sh(['exec', '-e', 'RESTIC_REPOSITORY=/target/airlock', '-e', `RESTIC_PASSWORD=${st.password}`, BACKUP, 'restic', 'ls', st.snapshot])
    check(!files.includes('secrets.key') && !files.includes('/source/data/keys'), 'keys/ nicht im Stand')

    /* --- 3. alles löschen ----------------------------------------------------------------- */
    for (const c of [BACKUP, APP, PG]) sh(['rm', '-f', c])
    for (const d of [st.dataDir, st.sitesDir, st.caddyDir]) for (const n of readdirSync(d)) rmSync(join(d, n), { recursive: true, force: true })
    for (const v of [VOL.staging, PROJECT_VOL, VOL.data, VOL.sites, VOL.caddy]) sh(['volume', 'rm', v])
    check(readdirSync(st.dataDir).length === 0 && readdirSync(st.sitesDir).length === 0 && readdirSync(st.caddyDir).length === 0, 'Alles gelöscht (nur das Ziel bleibt)')

    /* --- 4. frischer Aufbau, Schlüssel, Komplett-Restore (Schritte aus RESTORE.md) ------------- */
    pgc = await freshPostgres()
    pgDirs.push(pgc.dir)
    for (const v of [VOL.staging, VOL.data, VOL.sites, VOL.caddy]) sh(['volume', 'create', v])
    // 2.2: Schlüssel mit dem echten age aus der Datei holen (age liest die Passphrase vom Terminal) …
    sh(['run', '--rm', '-e', `P=${st.passphrase}`, '-v', `${st.root}:/w`, 'alpine:3.20', 'sh', '-c',
      'apk add -q --no-cache age util-linux-misc >/dev/null 2>&1 && printf \'%s\\n\' "$P" | script -qec "age -d -o /w/secrets.key /w/airlock-secrets-key.age" /dev/null >/dev/null'])
    check(sha(readFileSync(join(st.root, 'secrets.key'))) === st.keySha, 'age (das echte Werkzeug) entschlüsselt den Export: derselbe Schlüssel')

    // … ohne Schlüssel bricht airlock-restore ab …
    const restoreCmd = (dataVol: string) => ['run', '--rm', '--network', NET, '-e', 'PGHOST=postgres', '-e', 'PGUSER=airlock', '-e', 'PGPASSWORD=test', '-e', 'PGDATABASE=airlock',
      '-e', 'RESTIC_REPOSITORY=/target/airlock', '-e', `RESTIC_PASSWORD=${st.password}`, '-v', `${VOL.target}:/target`, '-v', `${VOL.staging}:/staging`,
      '-v', `${dataVol}:/restore/data`, '-v', `${VOL.sites}:/restore/sites`, '-v', `${VOL.caddy}:/restore/caddy_data`, IMAGE, 'airlock-restore', 'latest']
    const withoutKey = spawnSync('docker', restoreCmd(VOL.data), { encoding: 'utf8', env: cliEnv() })
    check(withoutKey.status !== 0 && /Erst den Schlüssel/.test(withoutKey.stderr), 'airlock-restore bricht ohne Schlüssel ab', withoutKey.stderr)

    // … also erst ins Daten-Volume legen (Befehl aus RESTORE.md), dann 2.3
    sh(['run', '--rm', '-v', `${VOL.data}:/data`, '-v', `${st.root}:/w`, 'alpine:3.20', 'sh', '-c',
      'mkdir -p /data/keys && cp /w/secrets.key /data/keys/secrets.key && chmod 700 /data/keys && chmod 600 /data/keys/secrets.key'])
    rmSync(join(st.root, 'secrets.key'))
    const full = spawnSync('docker', restoreCmd(VOL.data), { encoding: 'utf8', env: cliEnv() })
    check(full.status === 0 && /fertig/.test(full.stdout), 'Komplett-Restore (airlock-restore latest)', full.stdout + full.stderr)
    check(!`${full.stdout}${full.stderr}`.includes(st.password), 'Ausgabe des Restores ohne Repository-Passwort')
    // Airlock (hier im Prozess) sieht die Volumes als Host-Ordner
    syncFromVolumes(st)

    // Wie nach «docker compose up»: Backup-Container wieder da; Compose legt das Projekt-Volume beim Deploy leer an
    startBackupContainer()
    createProjectVolume()
    startApp()

    /* --- 5. prüfen ------------------------------------------------------------------------- */
    check(child('pruefen'), 'Abschnitt «prüfen» grün')
    const blob = sh(['run', '--rm', '-v', `${PROJECT_VOL}:/p`, 'alpine:3.20', 'sha256sum', '/p/blob.bin']).split(/\s+/)[0]
    check(blob === st.blobSha, 'Projekt-Volume nach dem Projekt-Restore wie im Stand (SHA-256)')
    check(sh(['inspect', '-f', '{{.State.Running}}', APP]) === 'true', 'Projekt-Container läuft nach dem Restore wieder')
    const runnerLog = execFileSync('docker', ['logs', BACKUP], { encoding: 'utf8', env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    check(![st.password, key.toString('base64'), key.toString('hex')].some((s) => runnerLog.includes(s)), 'Log des Ausführers ohne Passwort und Schlüssel')
  } catch (err) {
    check(false, 'Ablauf ohne Ausnahme', String((err as Error).stack ?? err))
  } finally {
    cleanup()
    for (const d of pgDirs) rmSync(d, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
  done()
}

if (phase === 'vorbereiten') await prepare()
else if (phase === 'pruefen') await verify()
else await main()
