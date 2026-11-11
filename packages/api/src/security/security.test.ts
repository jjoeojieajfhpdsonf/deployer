import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { score, grade, fingerprint, publishable, dedupe, bySeverity, type FindingInput } from './score.js'
import { checkHeaders } from './headers.js'
import { parseTrivy, parseZap, parseNuclei, parseTestssl } from './parsers.js'

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')

describe('Score und Note (SPEC)', () => {
  test('ohne Befunde 100, A', () => {
    assert.equal(score([]), 100)
    assert.equal(grade(100), 'A')
  })
  test('Abzüge: kritisch 25, hoch 10, mittel 4, niedrig 1', () => {
    assert.equal(score([{ severity: 'critical' }]), 75)
    assert.equal(score([{ severity: 'high' }, { severity: 'medium' }, { severity: 'low' }]), 85)
  })
  test('Minimum 0', () => {
    assert.equal(score(Array(5).fill({ severity: 'critical' })), 0)
  })
  test('Notengrenzen 90/75/50', () => {
    assert.deepEqual([90, 89, 75, 74, 50, 49, 0].map(grade), ['A', 'B', 'B', 'C', 'C', 'D', 'D'])
  })
  test('Schwelle für öffentlich', () => {
    assert.equal(publishable(false, []).ok, false, 'ohne Scan nicht')
    assert.equal(publishable(true, [{ severity: 'high', title: 'x' }]).ok, true, 'hoch allein hält nicht auf')
    const r = publishable(true, [{ severity: 'critical', title: 'Secret im Code' }])
    assert.equal(r.ok, false)
    assert.match((r as { reason: string }).reason, /Secret im Code/)
  })
  test('Fingerabdruck stabil, Doppelte nur einmal', () => {
    const f: FindingInput = { tool: 't', severity: 'low', title: 'a', location: 'b', description: '', fix: '' }
    const anders: FindingInput = { ...f, description: 'anders' }
    assert.equal(fingerprint(f), fingerprint(anders))
    assert.notEqual(fingerprint(f), fingerprint({ ...f, location: 'c' }))
    assert.equal(
      fingerprint({ ...f, location: 'http://dep_shop_abc123:80/.env' }),
      fingerprint({ ...f, location: 'http://shop.int.meinedomain.ch/.env' }),
      'Host wechselt mit Deploy und Basisdomain; der Fingerabdruck nicht',
    )
    assert.notEqual(fingerprint({ ...f, location: 'http://x/.env' }), fingerprint({ ...f, location: 'http://x/.git/config' }))
    assert.equal(dedupe([f, { ...f, severity: 'high' }]).length, 1)
    assert.equal(dedupe([f, { ...f, severity: 'high' }])[0]!.severity, 'high')
  })
})

describe('Header-Check', () => {
  const bare = { url: 'http://x/', status: 200, headers: {}, body: '<h1>x</h1>', isHttps: false }

  test('nackte Seite: CSP, frame-ancestors, nosniff, Referrer-Policy fehlen', () => {
    const titles = checkHeaders(bare).map((f) => f.title)
    assert.ok(titles.some((t) => /Content-Security-Policy/.test(t)))
    assert.ok(titles.some((t) => /Einbetten/.test(t)))
    assert.ok(titles.some((t) => /nosniff/.test(t)))
    assert.ok(titles.some((t) => /Referrer-Policy/.test(t)))
    assert.ok(!titles.some((t) => /Strict-Transport/.test(t)), 'HSTS nur bei HTTPS')
  })

  test('Seite mit allen Headern: nichts', () => {
    const f = checkHeaders({
      ...bare,
      headers: {
        'content-security-policy': "default-src 'self'; frame-ancestors 'self'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'permissions-policy': 'camera=(), microphone=()',
        'set-cookie': ['sid=1; HttpOnly; SameSite=Lax; Path=/'],
      },
    })
    assert.deepEqual(f, [])
  })

  test('Antwort 7: Permissions-Policy, X-AspNet-Version und X-Backend-Server aus dem Header-Check', () => {
    const titles = checkHeaders({ ...bare, headers: { 'x-aspnet-version': '4.0.30319', 'x-backend-server': 'web-02.intern' } }).map((x) => x.title)
    assert.ok(titles.includes('Permissions-Policy fehlt'))
    assert.ok(titles.includes('Versionsangabe im Header X-AspNet-Version'))
    assert.ok(titles.includes('Interner Server im Header X-Backend-Server'))
  })

  test('HTTPS: HSTS, Secure-Cookie, gemischte Inhalte', () => {
    const titles = checkHeaders({
      ...bare, isHttps: true,
      headers: { 'set-cookie': ['sid=1; HttpOnly; SameSite=Lax'] },
      body: '<script src="http://cdn.example/x.js"></script>',
    }).map((f) => f.title)
    assert.ok(titles.some((t) => /Strict-Transport/.test(t)))
    assert.ok(titles.some((t) => /ohne Secure/.test(t)))
    assert.ok(titles.some((t) => /Gemischte Inhalte/.test(t)))
  })

  test('Versionsangaben in Server/X-Powered-By', () => {
    const titles = checkHeaders({ ...bare, headers: { server: 'nginx/1.21.6', 'x-powered-by': 'Express' } }).map((f) => f.title)
    assert.ok(titles.some((t) => /Server/.test(t)))
    assert.ok(!titles.some((t) => /X-Powered-By/.test(t)), 'ohne Zahl keine Versionsangabe')
  })
})

describe('Parser gegen echte Ausgaben', () => {
  test('Trivy Image: CVEs mit Fix, je Paket zusammengefasst', () => {
    const f = parseTrivy(JSON.parse(fx('trivy-image.json')))
    assert.equal(f.length, 3, 'drei Pakete statt 35 Einzelbefunde')
    const curl = f.find((x) => x.title.startsWith('curl'))!
    assert.equal(curl.severity, 'critical')
    assert.match(curl.title, /\d+ bekannte Schwachstellen/)
    assert.match(curl.fix, /aktualisieren/)
  })

  test('Trivy fs: Secret ohne die gefundene Zeichenfolge, Dockerfile als root', () => {
    const f = parseTrivy(JSON.parse(fx('trivy-fs.json')))
    const secret = f.find((x) => x.title.startsWith('Secret im Code'))!
    assert.equal(secret.severity, 'critical')
    assert.equal(secret.location, 'config.js:1')
    assert.ok(!JSON.stringify(f).includes('const token'), 'die Fundzeile darf nicht übernommen werden')
    assert.ok(f.some((x) => /root/.test(x.title) && x.severity === 'high'))
  })

  test('ZAP: Header-Regeln und "Out of Date" weg, Info zählt nicht', () => {
    const f = parseZap(JSON.parse(fx('zap.json')))
    const titles = f.map((x) => x.title)
    assert.ok(!titles.some((t) => /Content Security Policy|Clickjacking|X-Content-Type|Out of Date/.test(t)), titles.join(' | '))
    // Antwort 7: Permissions-Policy prüft jetzt der Header-Check (ZAP 10063 unterdrückt)
    assert.ok(!titles.some((t) => /Permissions Policy/.test(t)), 'Permissions-Policy nur aus dem Header-Check')
    assert.ok(!titles.some((t) => /Storable and Cacheable/.test(t)), 'Info zählt nicht')
    assert.ok(f.every((x) => !/<p>/.test(x.fix)), 'HTML entfernt')
  })

  test('ZAP: alles, was der Header-Check prüft, kommt nur von dort (auch gemischte Inhalte)', () => {
    const alert = (pluginid: string, name: string) => ({ pluginid, name, riskcode: '2', desc: '', solution: '', instances: [{ uri: 'https://x' }] })
    const doc = { site: [{ '@name': 'https://x', alerts: [alert('10040', 'Secure Pages Include Mixed Content'), alert('10038', 'CSP Header Not Set'), alert('10202', 'Absence of Anti-CSRF Tokens')] }] }
    assert.deepEqual(parseZap(doc).map((x) => x.title), ['Absence of Anti-CSRF Tokens'])
  })

  test('Nuclei: .env und .git/config, ähnliche Vorlagen zusammengefasst, Info weg', () => {
    const f = parseNuclei(fx('nuclei.jsonl'))
    assert.equal(f.length, 2)
    const env = f.find((x) => x.location.endsWith('/.env'))!
    assert.equal(env.severity, 'high')
    assert.match(env.title, /\+1 ähnliche/)
    assert.ok(f.some((x) => x.location.endsWith('/.git/config') && x.severity === 'medium'))
  })

  test('testssl: Schweregrade, OK und INFO zählen nicht', () => {
    const f = parseTestssl([
      { id: 'SSLv3', severity: 'HIGH', finding: 'offered', port: '443' },
      { id: 'TLS1_3', severity: 'OK', finding: 'offered' },
      { id: 'cert_expirationStatus', severity: 'WARN', finding: 'expires < 30 days' },
      { id: 'banner', severity: 'INFO', finding: 'x' },
    ], 'shop.example')
    assert.deepEqual(f.map((x) => [x.title, x.severity]), [['TLS: SSLv3', 'high'], ['TLS: cert_expirationStatus', 'low']])
  })

  test('Sortierung nach Schwere', () => {
    const s = [{ severity: 'low' as const }, { severity: 'critical' as const }, { severity: 'medium' as const }].sort(bySeverity)
    assert.deepEqual(s.map((x) => x.severity), ['critical', 'medium', 'low'])
  })
})

describe('stabile Fingerabdrücke (Review M6)', () => {
  const base = { tool: 'trivy', severity: 'high' as const, description: '', fix: '' }
  test('mit Schlüssel zählen Titel und Ort nicht', () => {
    const a = fingerprint({ ...base, title: 'openssl: 3 bekannte Schwachstellen', location: 'airlock/x:abc · openssl 3.0.1', key: 'vuln:os-pkgs:alpine::openssl' })
    const b = fingerprint({ ...base, title: 'openssl: 4 bekannte Schwachstellen', location: 'airlock/x:def · openssl 3.0.2', key: 'vuln:os-pkgs:alpine::openssl' })
    assert.equal(a, b)
  })
  test('Schlüssel mit URL: nur der Pfad zählt', () => {
    assert.equal(
      fingerprint({ ...base, tool: 'nuclei', title: 'x', location: '', key: 'nuclei:http://dep_a_1:80/.env' }),
      fingerprint({ ...base, tool: 'nuclei', title: 'y (+1 ähnliche)', location: '', key: 'nuclei:http://shop.int.x.ch/.env' }),
    )
  })
})

describe('parseTrivy/parseZap/parseNuclei liefern Schlüssel', () => {
  test('Trivy: OS-Pakete ohne Image-Tag im Schlüssel', async () => {
    const { parseTrivy } = await import('./parsers.js')
    const mk = (target: string, n: number) => parseTrivy({ Results: [{ Target: target, Class: 'os-pkgs', Type: 'alpine', Vulnerabilities: Array.from({ length: n }, (_, i) => ({ VulnerabilityID: `CVE-${i}`, PkgName: 'zlib', InstalledVersion: '1.2', FixedVersion: '1.3', Severity: 'HIGH' })) }] })
    assert.equal(fingerprint(mk('airlock/a:111 (alpine 3.20)', 1)[0]!), fingerprint(mk('airlock/a:222 (alpine 3.20)', 2)[0]!))
  })
  test('ZAP: unabhängig von der ersten Fundstelle', async () => {
    const { parseZap } = await import('./parsers.js')
    const mk = (uri: string) => parseZap({ site: [{ alerts: [{ pluginid: '10098', name: 'Cross-Domain Misconfiguration', riskcode: '2', instances: [{ uri }] }] }] })
    assert.equal(fingerprint(mk('http://x/a')[0]!), fingerprint(mk('http://x/b')[0]!))
  })
})

describe('toolsChecked: "behoben" nur für Werkzeuge, die durchliefen (Review M6)', () => {
  test('gescheiterte ZAP-Stufe: ZAP ungeprüft, die anderen geprüft; nicht anwendbar zählt nicht', async () => {
    process.env.DATABASE_URL ??= 'postgres://x@localhost/x'
    process.env.ADMIN_PASSWORD ??= 'x'
    const { toolsChecked } = await import('./scan.js')
    const t = toolsChecked({
      'trivy-image': { ran: true, findings: 2 },
      'trivy-source': { ran: false, note: 'kein Quellordner' },
      headers: { ran: true, findings: 0 },
      'zap-baseline': { ran: false, failed: true, note: 'Zeitüberschreitung' },
      nuclei: { ran: true, findings: 1 },
      testssl: { ran: false, note: 'nicht anwendbar' },
    })
    assert.deepEqual([...t].sort(), ['header-check', 'nuclei', 'trivy'])
  })
  test('eine von zwei Trivy-Stufen gescheitert: Trivy ungeprüft', async () => {
    const { toolsChecked } = await import('./scan.js')
    const t = toolsChecked({ 'trivy-image': { ran: false, failed: true }, 'trivy-source': { ran: true, findings: 0 } })
    assert.equal(t.has('trivy'), false)
  })
})
