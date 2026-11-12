import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { NOT_FOUND_TEXT, SNAKE_CSS, SNAKE_JS, SNAKE_LOGIC_JS, renderSnakePage } from '@airlock/shared'
import { buildCaddyConfig, gameHostPatterns, notFoundGameHeaders, TUNNEL_HEADERS, type RouteSpec } from './caddy-config.js'

/**
 * Etappe 7: Snake auf der Seite «Kein Projekt unter diesem Namen» – nur für
 * unbekannte interne Namen aus LAN/Tailnet, nie über den Tunnel.
 */

type Match = { host?: string[]; remote_ip?: { ranges: string[] }; not?: Record<string, unknown>[] }
type Route = { match?: Match[]; handle: { handler: string; status_code?: number; body?: string; headers?: Record<string, string[]> }[] }
type Srv = { routes: Route[] }
const servers = (cfg: unknown) => (cfg as { apps: { http: { servers: Record<string, Srv> } } }).apps.http.servers

const app: RouteSpec = { hosts: ['app.int.example.ch'], kind: 'proxy', upstream: 'app:80' }
const shop: RouteSpec = { hosts: ['shop.example.ch'], kind: 'proxy', upstream: 'shop:80' }
const lan = ['192.168.1.0/24', '100.64.0.0/10', '127.0.0.0/8', '::1/128']
const tunnel = ['172.30.0.5/32']
const game = { hosts: ['*.int.example.ch', '*.192-168-1-10.nip.io'], cidrs: lan }
const base = { cidrs: lan, adminSocket: '/run/caddy/admin.sock', trustedProxies: tunnel, probeSocket: '/run/caddy/probe.sock' }
const tls = { baseDomain: 'int.example.ch', acmeCa: 'production' as const, tokenFile: '/t', redirect: true }

const isGame = (r: Route) => r.handle[0]?.body === renderSnakePage()
const isPlain = (r: Route) => r.match === undefined && r.handle[0]?.body === NOT_FOUND_TEXT

/** Nachbau des Caddy-Matchers für die Spiel-Route (Host-Muster mit einem Label, remote_ip, not) */
function cidrHit(ip: string, cidr: string): boolean {
  if (ip.includes(':') || cidr.includes(':')) return ip === cidr.split('/')[0]
  const [net, bits] = cidr.split('/') as [string, string]
  const n = (s: string) => s.split('.').reduce((a, p) => (a << 8) + Number(p), 0) >>> 0
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0
  return ((n(ip) & mask) >>> 0) === ((n(net) & mask) >>> 0)
}
const hostHit = (host: string, pattern: string) => {
  if (!pattern.startsWith('*.')) return host === pattern
  const rest = pattern.slice(2)
  return host.endsWith(`.${rest}`) && !host.slice(0, -rest.length - 1).includes('.')
}
function matches(m: Match, req: { host: string; ip: string; headers?: Record<string, string> }): boolean {
  if (m.host && !m.host.some((p) => hostHit(req.host, p))) return false
  if (m.remote_ip && !m.remote_ip.ranges.some((c) => cidrHit(req.ip, c))) return false
  for (const n of m.not ?? []) {
    const ranges = (n.remote_ip as { ranges: string[] } | undefined)?.ranges
    if (ranges && ranges.some((c) => cidrHit(req.ip, c))) return false
    const hdr = n.header as Record<string, string[]> | undefined
    if (hdr && Object.keys(hdr).some((h) => Object.keys(req.headers ?? {}).some((k) => k.toLowerCase() === h.toLowerCase()))) return false
  }
  return true
}
/** Welche Antwort bekäme eine Anfrage an einen unbekannten Namen? (erste passende Route) */
function answer(srv: Srv, req: { host: string; ip: string; headers?: Record<string, string> }): 'spiel' | 'schlicht' | 'andere' {
  const r = srv.routes.find((x) => !x.match || x.match.some((m) => matches(m, req)))!
  return isGame(r) ? 'spiel' : isPlain(r) ? 'schlicht' : 'andere'
}

describe('Snake auf der 404-Seite: nur intern, nie über den Tunnel', () => {
  test('Spiel-Route direkt vor der schlichten Auffangroute, auf :80 und :443', () => {
    const { srv0, srv1 } = servers(buildCaddyConfig([app, shop], { ...base, ipFilter: true, tls, notFoundGame: game }))
    for (const srv of [srv0!, srv1!]) {
      assert.ok(isPlain(srv.routes.at(-1)!), 'die schlichte Seite bleibt die letzte Route')
      const g = srv.routes.at(-2)!
      assert.ok(isGame(g))
      assert.equal(g.handle[0]!.status_code, 404)
      assert.deepEqual(g.match![0]!.host, game.hosts)
      assert.deepEqual(g.match![0]!.remote_ip, { ranges: lan })
    }
  })

  test('Ausnahmen: Absender aus dem Tunnel (cloudflared) und Cloudflare-Kopfzeilen', () => {
    const { srv1 } = servers(buildCaddyConfig([app], { ...base, ipFilter: true, tls, notFoundGame: game }))
    const not = srv1!.routes.at(-2)!.match![0]!.not!
    assert.deepEqual(not[0], { remote_ip: { ranges: tunnel } })
    for (const h of TUNNEL_HEADERS) assert.ok(not.some((n) => JSON.stringify(n) === JSON.stringify({ header: { [h]: ['*'] } })), h)
  })

  test('Wer bekommt was: LAN und Tailnet das Spiel, Tunnel, Internet und öffentliche Namen die schlichte Seite', () => {
    const { srv1 } = servers(buildCaddyConfig([app, shop], { ...base, ipFilter: true, tls, notFoundGame: game }))
    const srv = srv1!
    assert.equal(answer(srv, { host: 'tippfehler.int.example.ch', ip: '192.168.1.23' }), 'spiel', 'LAN')
    assert.equal(answer(srv, { host: 'tippfehler.int.example.ch', ip: '100.88.1.2' }), 'spiel', 'Tailnet')
    // Über den Tunnel: cloudflared ist der Absender – auch wenn sein Netz im LAN-Bereich läge
    assert.equal(answer(srv, { host: 'tippfehler.int.example.ch', ip: '172.30.0.5' }), 'schlicht', 'cloudflared')
    const overlap = servers(buildCaddyConfig([app], { ...base, ipFilter: true, tls, trustedProxies: ['192.168.1.77/32'], notFoundGame: game })).srv1!
    assert.equal(answer(overlap, { host: 'x.int.example.ch', ip: '192.168.1.77' }), 'schlicht', 'cloudflared im LAN-Bereich')
    assert.equal(answer(srv, { host: 'tippfehler.int.example.ch', ip: '192.168.1.23', headers: { 'CF-Connecting-IP': '203.0.113.9' } }), 'schlicht', 'Cloudflare-Kopfzeile')
    assert.equal(answer(srv, { host: 'tippfehler.int.example.ch', ip: '192.168.1.23', headers: { 'cf-ray': '8f00-ZRH' } }), 'schlicht', 'Cf-Ray')
    assert.equal(answer(srv, { host: 'tippfehler.int.example.ch', ip: '203.0.113.9' }), 'schlicht', 'fremde Adresse')
    assert.equal(answer(srv, { host: 'unbekannt.example.ch', ip: '192.168.1.23' }), 'schlicht', 'öffentlicher Name')
    assert.equal(answer(srv, { host: 'a.b.int.example.ch', ip: '192.168.1.23' }), 'schlicht', 'zwei Ebenen tiefer')
  })

  test('Probe-Server (Header-Check von aussen) bekommt nie das Spiel', () => {
    const { probe } = servers(buildCaddyConfig([app], { ...base, ipFilter: true, tls, notFoundGame: game }))
    assert.equal(probe!.routes.some(isGame), false)
    assert.ok(isPlain(probe!.routes.at(-1)!))
  })

  test('Spass-Funktionen aus (oder keine internen Namen): keine Spiel-Route', () => {
    for (const g of [null, undefined, { hosts: [], cidrs: lan }, { hosts: game.hosts, cidrs: [] }]) {
      const s = servers(buildCaddyConfig([app], { ...base, ipFilter: true, tls, notFoundGame: g }))
      assert.equal([...Object.values(s)].some((srv) => srv.routes.some(isGame)), false)
    }
  })

  test('ohne Tunnel: keine leere Ausnahme-Liste der Absender', () => {
    const s = servers(buildCaddyConfig([app], { ...base, trustedProxies: [], ipFilter: false, notFoundGame: game })).srv0!
    const not = s.routes.at(-2)!.match![0]!.not!
    assert.equal(not.some((n) => 'remote_ip' in n), false)
    assert.equal(not.length, TUNNEL_HEADERS.length)
  })

  test('Muster der internen Namen aus Beispiel-Adressen', () => {
    assert.deepEqual(gameHostPatterns(['x.int.example.ch', 'x.100-88-41-12.nip.io', 'x.int.example.ch', 'x.int.invalid', 'x.int.verein.ch']),
      ['*.100-88-41-12.nip.io', '*.int.example.ch', '*.int.verein.ch'])
    assert.deepEqual(gameHostPatterns(['localhost']), [])
  })
})

describe('Snake-Seite: CSP und Caddy-Platzhalter', () => {
  const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('base64')
  const html = renderSnakePage()

  test('CSP: nichts von aussen, kein unsafe-inline, Hashes passen auf Skript und Stil in der Seite', () => {
    const csp = notFoundGameHeaders()['Content-Security-Policy']![0]!
    assert.match(csp, /default-src 'none'/)
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/)
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!
    const style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!
    assert.equal(script, SNAKE_JS)
    assert.equal(style, SNAKE_CSS)
    assert.ok(csp.includes(`'sha256-${sha(script)}'`))
    assert.ok(csp.includes(`'sha256-${sha(style)}'`))
    // Hash-CSP verbietet Inline-Styles und Event-Attribute: es gibt keine
    assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=/)
  })

  test('kein Text, den Caddy in static_response ersetzen würde (sonst stimmt der Hash nicht mehr)', () => {
    // Bekannte Platzhalter haben die Form {name.name}; «\{» ist ein Escape
    assert.doesNotMatch(html, /\{[a-z_]+\.[a-z_]/i)
    assert.doesNotMatch(html, /\\[{}]/)
  })

  test('ohne JavaScript nur der Text; der Host kommt nie aus der Anfrage ins HTML', () => {
    assert.match(html, /<section id="game" class="game"[^>]* hidden>/)
    assert.match(html, /<h1>Kein Projekt unter diesem Namen<\/h1>/)
    assert.doesNotMatch(html, /http\.request/)
  })

  test('Kopfzeilen: 404-Seite nie im Cache und nie im Index', () => {
    const h = notFoundGameHeaders()
    assert.deepEqual(h['Cache-Control'], ['no-store'])
    assert.deepEqual(h['X-Robots-Tag'], ['noindex'])
  })
})

describe('Snake: Spiel-Logik (dieselbe Zeichenkette wie in der Seite)', () => {
  type P = [number, number]
  type S = { size: number; snake: P[]; dir: P; food: P | null; alive: boolean; score: number }
  const g = new Function(`${SNAKE_LOGIC_JS}; return { keyDir, swipeDir, turn, placeFood, newGame, step, tickMs }`)() as {
    keyDir: (k: string) => P | null
    swipeDir: (dx: number, dy: number, min: number) => P | null
    turn: (dir: P, next: P | null) => P
    placeFood: (snake: P[], size: number, rnd: () => number) => P | null
    newGame: (size: number, rnd: () => number) => S
    step: (s: S, next: P | null, rnd: () => number) => S
    tickMs: (score: number) => number
  }
  const zero = () => 0

  test('Pfeiltasten und WASD; anderes zählt nicht', () => {
    assert.deepEqual(g.keyDir('ArrowUp'), [0, -1])
    assert.deepEqual(g.keyDir('D'), [1, 0])
    assert.equal(g.keyDir('x'), null)
  })

  test('Wischen: grösste Richtung gewinnt, kurze Berührung ist kein Wischen', () => {
    assert.deepEqual(g.swipeDir(80, 10, 24), [1, 0])
    assert.deepEqual(g.swipeDir(-5, -60, 24), [0, -1])
    assert.equal(g.swipeDir(10, 12, 24), null)
  })

  test('Umkehren ist nicht erlaubt', () => {
    assert.deepEqual(g.turn([1, 0], [-1, 0]), [1, 0])
    assert.deepEqual(g.turn([1, 0], [0, 1]), [0, 1])
    assert.deepEqual(g.turn([1, 0], null), [1, 0])
  })

  test('fressen: länger, ein Punkt, neues Futter auf einem freien Feld', () => {
    const s: S = { size: 10, snake: [[3, 3], [2, 3], [1, 3]], dir: [1, 0], food: [4, 3], alive: true, score: 0 }
    const n = g.step(s, null, zero)
    assert.equal(n.snake.length, 4)
    assert.equal(n.score, 1)
    assert.ok(n.food && !n.snake.some((c) => c[0] === n.food![0] && c[1] === n.food![1]))
  })

  test('Wand und eigener Körper beenden das Spiel; der Schwanz gibt sein Feld frei', () => {
    const wall: S = { size: 5, snake: [[4, 0], [3, 0], [2, 0]], dir: [1, 0], food: [0, 4], alive: true, score: 2 }
    assert.equal(g.step(wall, null, zero).alive, false)
    const loop: S = { size: 5, snake: [[1, 1], [2, 1], [2, 2], [1, 2], [0, 2]], dir: [0, 1], food: [4, 4], alive: true, score: 0 }
    assert.equal(g.step(loop, [1, 0], zero).alive, false, 'beisst sich')
    const tail: S = { size: 5, snake: [[1, 1], [2, 1], [2, 2], [1, 2]], dir: [0, 1], food: [4, 4], alive: true, score: 0 }
    assert.equal(g.step(tail, null, zero).alive, true, 'ins Feld, das der Schwanz gerade verlässt')
  })

  test('neues Spiel: Futter nie auf der Schlange; volles Feld: kein Futter', () => {
    const s = g.newGame(20, zero)
    assert.ok(s.food && !s.snake.some((c) => c[0] === s.food![0] && c[1] === s.food![1]))
    assert.equal(g.placeFood([[0, 0], [1, 0], [0, 1], [1, 1]], 2, zero), null)
  })

  test('Tempo steigt mit den Punkten, aber nicht unter 70 ms', () => {
    assert.equal(g.tickMs(0), 140)
    assert.ok(g.tickMs(10) < g.tickMs(0))
    assert.equal(g.tickMs(1000), 70)
  })
})
