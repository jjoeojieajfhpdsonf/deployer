import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  backupArgs, backupExcludes, forgetArgs, resticEnv, repositoryUrl, normalizeLocalPath, maskCredentials, errorTail,
  parseBackupSummary, parseSnapshots, classifyRepoProbe, targetSecrets, safeTag, KEYS_EXCLUDE, BACKUP_PATHS, SOURCE_DIRS,
  stagingVolumeDir, volumeCopyCmd,
  type ResolvedTarget,
} from './restic.js'

const S3: ResolvedTarget = {
  kind: 's3', endpoint: 'https://s3.eu-central-003.backblazeb2.com/', bucket: 'airlock-backup', prefix: 'server1',
  region: 'eu-central-003', accessKeyId: 'AKIAEXAMPLEKEY12345', secretAccessKey: 'geheim/SecretKey+abc123456789', // allowlist-secret: erfundene Testwerte
}
const PASSWORD = 'repo-passwort-lang-genug' // allowlist-secret: erfundener Testwert

describe('Backup: Ausschlüsse', () => {
  test('secrets.key (Ordner keys/ im Daten-Volume) ist immer ausgeschlossen', () => {
    assert.ok(backupExcludes().includes(`${SOURCE_DIRS.data}/keys`))
    assert.equal(KEYS_EXCLUDE, '/source/data/keys')
    const args = backupArgs({ version: '0.1.0', environments: [] })
    const i = args.indexOf(KEYS_EXCLUDE)
    assert.ok(i > 0 && args[i - 1] === '--exclude', 'keys/ als --exclude in den Argumenten')
  })
  test('das Daten-Volume selbst wird gesichert, nur ohne keys/', () => {
    assert.ok(BACKUP_PATHS.includes(SOURCE_DIRS.data))
    assert.ok(!BACKUP_PATHS.some((p) => p.includes('keys')))
  })
  test('Zwischenstände (work, scan) fliegen raus, Artefakte und Repos nicht', () => {
    const ex = backupExcludes()
    assert.ok(ex.includes('/source/data/work'))
    assert.ok(ex.includes('/source/data/scan-src'))
    assert.ok(!ex.some((e) => e.endsWith('/deployments') || e.endsWith('/repos') || e.endsWith('/uploads')))
  })
})

describe('Backup: restic-Argumente', () => {
  test('backup: JSON, feste Host-Kennung, Tags für Version und Umgebungen, alle Pfade', () => {
    const args = backupArgs({ version: '0.1.0', environments: ['jherren', 'Kunde A'] })
    assert.deepEqual(args.slice(0, 4), ['backup', '--json', '--host', 'airlock'])
    const tags = args.flatMap((a, i) => (args[i - 1] === '--tag' ? [a] : []))
    assert.deepEqual(tags, ['airlock', 'airlock-0.1.0', 'env-jherren', 'env-kunde-a'])
    assert.deepEqual(args.slice(-BACKUP_PATHS.length), [...BACKUP_PATHS])
  })
  test('Tags enthalten nie ein Komma (Trenner bei restic)', () => {
    assert.equal(safeTag('a,b c'), 'a-b-c')
  })
  test('keine Geheimnisse in den Argumenten (die stehen in der Auftragsdatei und in jeder Prozessliste)', () => {
    const all = [...backupArgs({ version: '1', environments: ['x'] }), ...forgetArgs({ daily: 7, weekly: 4, monthly: 6 })].join(' ')
    assert.ok(!all.includes(PASSWORD))
    assert.ok(!/password|secret/i.test(all))
  })
  test('forget: 7/4/6 als Vorgabe, gruppiert nach Host, mit prune', () => {
    assert.deepEqual(forgetArgs({ daily: 7, weekly: 4, monthly: 6 }), [
      'forget', '--json', '--host', 'airlock', '--tag', 'airlock', '--group-by', 'host',
      '--keep-daily', '7', '--keep-weekly', '4', '--keep-monthly', '6', '--prune',
    ])
  })
  test('forget: 0 lässt die Klasse weg, alles 0 ist verboten', () => {
    const args = forgetArgs({ daily: 3, weekly: 0, monthly: 0 })
    assert.ok(!args.includes('--keep-weekly'))
    assert.ok(args.includes('--keep-daily'))
    assert.throws(() => forgetArgs({ daily: 0, weekly: 0, monthly: 0 }), /mindestens ein Stand/)
    assert.throws(() => forgetArgs({ daily: 1.5, weekly: 0, monthly: 0 }))
  })
})

describe('Backup: Projekt-Volumes im Staging', () => {
  test('Ziel /staging/volumes/<slug>/<volume>', () => {
    assert.equal(stagingVolumeDir('fotoalbum', 'db-data'), '/staging/volumes/fotoalbum/db-data')
  })
  test('nichts Ausführbares im Shell-Befehl, kein Ausbruch aus dem Staging', () => {
    const cmd = volumeCopyCmd('foto', "x'; rm -rf / #")
    assert.equal(cmd[0], 'sh')
    assert.ok(!cmd[2]!.includes("x'"))
    assert.equal(stagingVolumeDir('foto', '../../etc'), '/staging/volumes/foto/etc')
    assert.equal(stagingVolumeDir('foto', '..'), '/staging/volumes/foto/volume')
  })
})

describe('Backup: Ziel und Umgebung', () => {
  test('S3: Adresse aus Endpoint, Bucket, Unterordner; Schlüssel nur in der Umgebung', () => {
    assert.equal(repositoryUrl(S3), 's3:https://s3.eu-central-003.backblazeb2.com/airlock-backup/server1')
    const env = resticEnv(S3, PASSWORD)
    assert.equal(env.RESTIC_PASSWORD, PASSWORD)
    assert.equal(env.AWS_ACCESS_KEY_ID, S3.kind === 's3' ? S3.accessKeyId : '')
    assert.equal(env.AWS_DEFAULT_REGION, 'eu-central-003')
    assert.ok(!env.RESTIC_REPOSITORY!.includes(S3.kind === 's3' ? S3.secretAccessKey : 'x'))
  })
  test('S3 ohne Unterordner und Region (MinIO)', () => {
    const t: ResolvedTarget = { ...S3, endpoint: 'http://minio:9000', prefix: '', region: '' } as ResolvedTarget
    assert.equal(repositoryUrl(t), 's3:http://minio:9000/airlock-backup')
    assert.equal(resticEnv(t, PASSWORD).AWS_DEFAULT_REGION, undefined)
  })
  test('S3 ohne Schlüssel und ohne Passwort: Fehler statt halber Aufruf', () => {
    assert.throws(() => resticEnv({ ...S3, secretAccessKey: '' } as ResolvedTarget, PASSWORD), /Secret-Key/)
    assert.throws(() => resticEnv(S3, ''), /Passwort/)
  })
  test('lokal: nur unter /target, ohne «..»', () => {
    assert.equal(normalizeLocalPath('/target/airlock/'), '/target/airlock')
    assert.equal(normalizeLocalPath('/target'), '/target')
    assert.equal(repositoryUrl({ kind: 'local', path: '/target//nas/airlock' }), '/target/nas/airlock')
    assert.throws(() => normalizeLocalPath('/target/../etc'), /\.\./)
    assert.throws(() => normalizeLocalPath('/data/keys'), /unter \/target/)
    assert.throws(() => normalizeLocalPath('target/x'), /beginnen/)
    assert.throws(() => normalizeLocalPath('/targetx'), /unter \/target/)
  })
  test('Geheimnisse eines Ziels für das Schwärzen', () => {
    assert.deepEqual(targetSecrets(S3, PASSWORD).sort(), [PASSWORD, 'AKIAEXAMPLEKEY12345', 'geheim/SecretKey+abc123456789'].sort())
    assert.deepEqual(targetSecrets({ kind: 'local', path: '/target' }, null), [])
  })
})

describe('Backup: Zugangsdaten in Fehlermeldungen schwärzen', () => {
  test('bekannte Werte, URL mit Benutzer:Passwort, Variablen-Zuweisungen, signierte URLs', () => {
    const text = [
      `Fatal: unable to open repo at s3:https://AKIAEXAMPLEKEY12345:geheim/SecretKey+abc123456789@s3.example.com/b`,
      `env: RESTIC_PASSWORD=${PASSWORD} AWS_SECRET_ACCESS_KEY=xyz`,
      'GET https://s3.example.com/b?X-Amz-Credential=AKIA%2F2026&X-Amz-Signature=abcdef0123',
      'sftp://joel:hunter2hunter2@nas/backup',
    ].join('\n')
    const out = maskCredentials(text, targetSecrets(S3, PASSWORD))
    assert.ok(!out.includes('AKIAEXAMPLEKEY12345'))
    assert.ok(!out.includes('SecretKey'))
    assert.ok(!out.includes(PASSWORD))
    assert.ok(!out.includes('xyz'))
    assert.ok(!out.includes('hunter2'))
    assert.ok(!out.includes('abcdef0123'))
    assert.match(out, /RESTIC_PASSWORD=\*\*\*/)
    assert.match(out, /s3\.example\.com/)
  })
  test('errorTail: letzte Zeilen ohne Fortschritt, geschwärzt', () => {
    const out = errorTail(['{"message_type":"status","percent_done":0.5}', '', 'Fatal: wrong password ' + PASSWORD], [PASSWORD])
    assert.equal(out, 'Fatal: wrong password ***')
  })
})

describe('Backup: Ausgabe von restic auswerten', () => {
  test('summary aus «backup --json»', () => {
    const lines = [
      '{"message_type":"status","percent_done":0.4}',
      '{"message_type":"summary","files_new":12,"files_changed":0,"data_added":20480,"total_bytes_processed":1048576,"total_duration":2.5,"snapshot_id":"4f3e2d1c0b9a"}',
    ]
    assert.deepEqual(parseBackupSummary(lines), { snapshotId: '4f3e2d1c0b9a', bytesNew: 20480, bytesTotal: 1048576, filesNew: 12, durationMs: 2500 })
  })
  test('ohne summary: null; kaputte Zeilen stören nicht', () => {
    assert.equal(parseBackupSummary(['nichts', '{kaputt', '{"message_type":"status"}']), null)
  })
  test('snapshots: neueste zuerst, Grösse aus summary (ab 0.17)', () => {
    const json = JSON.stringify([
      { id: 'aaaa1111bbbb', short_id: 'aaaa1111', time: '2026-11-09T03:30:01.5+01:00', tags: ['airlock'], paths: ['/staging/db'] },
      { id: 'cccc2222dddd', short_id: 'cccc2222', time: '2026-11-10T03:30:02+01:00', tags: ['airlock'], paths: ['/staging/db'], summary: { total_bytes_processed: 999 } },
    ])
    const s = parseSnapshots(json)
    assert.equal(s[0]!.shortId, 'cccc2222')
    assert.equal(s[0]!.bytesTotal, 999)
    assert.equal(s[1]!.bytesTotal, null)
    assert.equal(s[0]!.time, '2026-11-10T02:30:02.000Z')
    assert.deepEqual(parseSnapshots(''), [])
    assert.throws(() => parseSnapshots('{"a":1}'))
  })
  test('cat config: Exit-Codes von restic 0.17 und Rückfall über den Text', () => {
    assert.equal(classifyRepoProbe(0, ''), 'ok')
    assert.equal(classifyRepoProbe(10, ''), 'missing')
    assert.equal(classifyRepoProbe(1, 'Fatal: unable to open config file: Stat: stat /target/x/config: no such file or directory\nIs there a repository at the following location?'), 'missing')
    assert.equal(classifyRepoProbe(12, ''), 'wrong_password')
    assert.equal(classifyRepoProbe(1, 'Fatal: wrong password or no key found'), 'wrong_password')
    assert.equal(classifyRepoProbe(11, ''), 'locked')
    assert.equal(classifyRepoProbe(1, 'Fatal: dial tcp: lookup minio: no such host'), 'error')
  })
})
