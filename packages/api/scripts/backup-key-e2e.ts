/**
 * Meilenstein Backup, Etappe 4: secrets.key getrennt sichern – über die echte
 * HTTP-Schicht (buildApp, inject) gegen eine Wegwerf-Datenbank.
 *
 *   pnpm --filter @airlock/api e2e:backup-key
 *
 * Braucht Docker nur für Postgres. Geprüft:
 * - Export nur nach frischer Anmeldung: ohne bzw. mit falschem Passwort 400,
 *   mit API-Token 403, Antworten mit Cache-Control no-store.
 * - Datei-Export (age) und Wiedereinlesen ergeben denselben Schlüssel
 *   (Prüfsumme), «Datei prüfen» erkennt ihn und einen fremden.
 * - Papier: Base64 und Hex sind der Schlüssel, QR-Code vorhanden.
 * - Merker erst nach «getrennt abgelegt», nur für diesen Schlüssel; ohne
 *   Export keine Bestätigung.
 * - Der Schlüssel steht in keinem Audit-Eintrag und in keiner Log-Zeile.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { startThrowawayPostgres, checker } from './lib/throwaway-pg.js'

const pgc = await startThrowawayPostgres('airlock-backup-key-e2e')
const { check, done } = checker()

// Alles, was der Prozess ausgibt (Logs von Fastify und Airlock), zum Suchen nach dem Schlüssel
const output: string[] = []
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream)
  stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof stream.write
}

try {
  const { pool } = await import('../src/db/index.js')
  const { runMigrations } = await import('../src/db/migrate.js')
  const envs = await import('../src/domain/environments.js')
  const { ensureAdminPassword } = await import('../src/http/auth.js')
  const { buildApp } = await import('../src/http/app.js')
  const { createToken } = await import('../src/domain/tokens.js')
  const { ageDecrypt, ageEncrypt, keyFingerprint } = await import('../src/backup/key.js')
  const { inEnvironment } = await import('../src/lib/scope.js')

  await runMigrations(() => {})
  await envs.importLegacySettings()
  await envs.reloadEnvironments()
  await ensureAdminPassword()
  const app = await buildApp()
  await app.ready()
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: process.env.ADMIN_PASSWORD } })
  const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  check(login.statusCode === 200, 'Anmeldung')
  const ui = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })

  // Der Status legt den Schlüssel an (wie beim ersten Start)
  const s0 = (await ui('GET', '/system/backup')).json() as { key: { fingerprint: string; savedAt: string | null } }
  const key = readFileSync(join(process.env.DATA_DIR!, 'keys', 'secrets.key'))
  check(key.length === 32 && s0.key.fingerprint === keyFingerprint(key) && s0.key.savedAt === null, 'Status: Prüfsumme des Schlüssels, noch nicht gesichert', s0.key)

  /* --- frische Anmeldung ------------------------------------------------------------ */
  const PASSPHRASE = `e2e-passphrase-${randomBytes(6).toString('hex')}` // allowlist-secret: Testwert
  const noPw = await ui('POST', '/system/backup/key/file', { passphrase: PASSPHRASE })
  const wrongPw = await ui('POST', '/system/backup/key/file', { password: 'falsch', passphrase: PASSPHRASE })
  check(noPw.statusCode === 400 && wrongPw.statusCode === 400 && /Anmelde-Passwort stimmt nicht/.test(wrongPw.body), 'Datei-Export ohne bzw. mit falschem Anmelde-Passwort abgelehnt (400, kein Abmelden)', [noPw.statusCode, wrongPw.statusCode])
  const paperWrong = await ui('POST', '/system/backup/key/paper', { password: 'falsch' })
  check(paperWrong.statusCode === 400 && !paperWrong.body.includes(key.toString('base64')), 'Papier mit falschem Passwort abgelehnt')
  const shortPass = await ui('POST', '/system/backup/key/file', { password: process.env.ADMIN_PASSWORD, passphrase: 'kurz' })
  check(shortPass.statusCode === 400 && /Mindestens 12/.test(shortPass.body), 'Passphrase unter 12 Zeichen abgelehnt')

  const { token } = await createToken(inEnvironment(envs.defaultEnvironmentId()), 'e2e', 'e2e')
  const viaToken = await app.inject({ method: 'POST', url: '/api/v1/system/backup/key/paper', headers: { authorization: `Bearer ${token}` }, payload: { password: process.env.ADMIN_PASSWORD } })
  check(viaToken.statusCode === 403 && !viaToken.body.includes(key.toString('base64')), 'Mit API-Token: 403, auch mit Passwort', viaToken.statusCode)

  /* --- Merker erst nach Export -------------------------------------------------------- */
  const early = await ui('POST', '/system/backup/key/confirm', { method: 'file' })
  check(early.statusCode === 400, 'Bestätigen ohne vorherigen Export geht nicht')

  /* --- Datei ------------------------------------------------------------------------- */
  const f = await ui('POST', '/system/backup/key/file', { password: process.env.ADMIN_PASSWORD, passphrase: PASSPHRASE })
  const fileDto = f.json() as { filename: string; file: string; fingerprint: string }
  check(f.statusCode === 200 && f.headers['cache-control'] === 'no-store', 'Datei-Export mit Passwort, Cache-Control no-store', [f.statusCode, f.headers['cache-control']])
  const ageFile = Buffer.from(fileDto.file, 'base64')
  check(!f.body.includes(key.toString('base64')) && !f.body.includes(key.toString('hex')) && !ageFile.includes(key), 'Antwort enthält den Schlüssel nur verschlüsselt')
  check(/^airlock-secrets-key-.+-\d{4}-\d{2}-\d{2}\.age$/.test(fileDto.filename) && ageFile.subarray(0, 21).toString() === 'age-encryption.org/v1', 'Dateiname und age-Kopf', fileDto.filename)
  const back = ageDecrypt(ageFile, PASSPHRASE)
  check(back.equals(key) && keyFingerprint(back) === fileDto.fingerprint, 'Export und Wiedereinlesen ergeben denselben Schlüssel (Prüfsumme)')

  const v1 = await ui('POST', '/system/backup/key/verify', { file: fileDto.file, passphrase: PASSPHRASE })
  check(v1.statusCode === 200 && v1.json().matches === true && !v1.body.includes(key.toString('base64')), '«Datei prüfen»: passt, ohne den Schlüssel zurückzugeben', v1.body)
  const v2 = await ui('POST', '/system/backup/key/verify', { file: fileDto.file, passphrase: 'falsche passphrase' })
  check(v2.statusCode === 400 && /Passphrase passt nicht/.test(v2.body), '«Datei prüfen»: falsche Passphrase erkannt', v2.body)
  const other = ageEncrypt(randomBytes(32), PASSPHRASE, 10).toString('base64')
  const v3 = await ui('POST', '/system/backup/key/verify', { file: other, passphrase: PASSPHRASE })
  check(v3.statusCode === 200 && v3.json().matches === false, '«Datei prüfen»: fremder Schlüssel erkannt', v3.body)

  const c1 = await ui('POST', '/system/backup/key/confirm', { method: 'file' })
  const s1 = (await ui('GET', '/system/backup')).json() as { key: { savedAt: string | null; method: string | null } }
  check(c1.statusCode === 200 && s1.key.method === 'file' && !!s1.key.savedAt, 'Merker «gesichert am … als Datei» gesetzt', s1.key)

  /* --- Papier ------------------------------------------------------------------------ */
  const p = await ui('POST', '/system/backup/key/paper', { password: process.env.ADMIN_PASSWORD })
  const paper = p.json() as { key: string; hex: string[]; qr: string[]; fingerprint: string; sha256: string }
  check(p.statusCode === 200 && p.headers['cache-control'] === 'no-store' && Buffer.from(paper.key, 'base64').equals(key) && Buffer.from(paper.hex.join(''), 'hex').equals(key),
    'Papier: Base64 und Hex sind der Schlüssel, no-store')
  check(paper.qr.length >= 21 && paper.qr.every((r) => r.length === paper.qr.length) && paper.fingerprint === keyFingerprint(key), 'Papier: QR-Code und Prüfsumme')
  const c2 = await ui('POST', '/system/backup/key/confirm', { method: 'paper' })
  check(c2.statusCode === 200 && (c2.json() as { key: { method: string } }).key.method === 'paper', 'Merker «auf Papier» gesetzt')

  /* --- anderer Schlüssel: Merker gilt nicht mehr ---------------------------------------- */
  const { getSetting, setSetting } = await import('../src/db/index.js')
  await setSetting('secrets_key_backup', JSON.stringify({ ...JSON.parse((await getSetting('secrets_key_backup'))!), fingerprint: '0000 0000 0000 0000' }))
  const s2 = (await ui('GET', '/system/backup')).json() as { key: { savedAt: string | null } }
  check(s2.key.savedAt === null, 'Merker für einen anderen Schlüssel zählt nicht (Warnung bleibt)')

  /* --- nichts davon im Audit und im Log ------------------------------------------------- */
  const audit = (await pool.query("SELECT action, params_masked::text AS p, coalesce(error, '') AS e FROM audit_events WHERE action LIKE 'backup.key%'")).rows as { action: string; p: string; e: string }[]
  const secretForms = [key.toString('base64'), key.toString('hex'), paper.hex.join(' '), PASSPHRASE]
  check(audit.length >= 4 && audit.every((a) => !secretForms.some((s) => a.p.includes(s) || a.e.includes(s))), 'Audit: Export, Prüfung, Merker – ohne Schlüssel und Passphrase', audit.map((a) => a.action))
  const log = output.join('')
  check(!secretForms.some((s) => log.includes(s)), 'Keine Log-Zeile enthält Schlüssel oder Passphrase')
  await app.close()
  await pool.end()
} catch (err) {
  check(false, 'Ablauf ohne Ausnahme', String((err as Error).stack ?? err))
} finally {
  pgc.stop()
}
done()
