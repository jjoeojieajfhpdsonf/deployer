import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  availabilityOf, dayState, statusDays, dayInZone, fmtPercent, renderStatusPage, renderStatusFeed, showsOnStatusPage,
  PUBLIC_STATUS_FIELDS, RESERVED_PUBLIC_LABELS, STATUS_CSP, STATUS_DAYS, type PublicStatusJson,
} from '@airlock/shared'
import { buildPublicStatus, feedIncidents, incidentKey, publicIncident, type SnapshotIncident, type SnapshotProject } from './snapshot.js'
import { planAutoIncidents } from './auto-incidents.js'
import { statusRouteSpec } from './route.js'
import { buildCaddyConfig } from '../drivers/caddy-config.js'
import { resolvePublicHostname, reconcileIngress } from '../lib/public-hosts.js'

const NOW = new Date('2026-11-12T13:05:00Z')
const TZ = 'Europe/Zurich'

const PID = '0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3'
const PID2 = '1c7d2e3f-4051-4b6c-9d7e-8f90a1b2c3d4'
const HIDDEN = '2d8e3f40-5162-4c7d-8e8f-90a1b2c3d4e5'
const IID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

function sample(): { data: PublicStatusJson; incidents: SnapshotIncident[] } {
  // Absichtlich mit Feldern, die nie öffentlich werden dürfen (wie eine Datenbankzeile)
  const leaky = (p: SnapshotProject & Record<string, unknown>) => p
  const projects: SnapshotProject[] = [
    leaky({ id: PID, name: 'Fotoalbum', state: 'ok', slug: 'fotoalbum', hostname: 'fotoalbum.int.example.ch', ip: '10.0.3.7', version: 'sha256:abc123', error: 'ECONNREFUSED 172.18.0.4:3000',
      counts: [{ date: '2026-11-12', upMinutes: 700, downMinutes: 0, pausedMinutes: 0 }, { date: '2026-11-11', upMinutes: 1430, downMinutes: 10, pausedMinutes: 0 }] }),
    leaky({ id: PID2, name: 'Blog', state: 'stoerung', slug: 'blog-intern', counts: [{ date: '2026-11-12', upMinutes: 600, downMinutes: 100, pausedMinutes: 0 }] }),
  ]
  const incidents: SnapshotIncident[] = [
    { id: IID, title: 'Blog nicht erreichbar', state: 'untersucht', createdAt: new Date('2026-11-12T12:00:00Z'), resolvedAt: null, projectIds: [PID2, HIDDEN],
      updates: [{ state: 'untersucht', body: 'Wir schauen nach.\n\nMehr folgt.', createdAt: new Date('2026-11-12T12:00:00Z') }] },
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Alt', state: 'behoben', createdAt: new Date('2026-10-01T10:00:00Z'), resolvedAt: new Date('2026-10-01T11:00:00Z'), projectIds: [],
      updates: [{ state: 'behoben', body: 'Erledigt', createdAt: new Date('2026-10-01T11:00:00Z') }] },
    // Automatisch, zu einem Projekt, das nicht auf der Seite steht: bleibt weg
    { id: 'aaaaaaaa-0000-4000-8000-000000000002', title: 'Geheim nicht erreichbar', state: 'untersucht', createdAt: new Date('2026-11-12T12:30:00Z'), resolvedAt: null, projectIds: [HIDDEN],
      updates: [{ state: 'untersucht', body: 'x', createdAt: new Date('2026-11-12T12:30:00Z') }] },
  ]
  const data = buildPublicStatus({ title: 'Status Beispiel', now: NOW, timeZone: TZ, projects, incidents, autoIncidents: new Set(['aaaaaaaa-0000-4000-8000-000000000002']) })
  return { data, incidents }
}

describe('status.json: nur erlaubte Felder', () => {
  test('jedes Objekt hat genau die erlaubten Schlüssel', () => {
    const { data } = sample()
    const only = (o: object, allowed: readonly string[], where: string) => {
      for (const k of Object.keys(o)) assert.ok(allowed.includes(k), `${where}: Feld «${k}» ist nicht erlaubt`)
    }
    only(data, PUBLIC_STATUS_FIELDS.root, 'Wurzel')
    for (const p of data.projects) {
      only(p, PUBLIC_STATUS_FIELDS.project, 'Projekt')
      for (const d of p.days) only(d, PUBLIC_STATUS_FIELDS.day, 'Tag')
    }
    for (const i of data.incidents) {
      only(i, PUBLIC_STATUS_FIELDS.incident, 'Störung')
      for (const u of i.updates) only(u, PUBLIC_STATUS_FIELDS.update, 'Update')
    }
  })

  test('keine IDs, Kurznamen, Hostnamen, IPs, Versionen oder Fehlertexte – weder im JSON noch in Seite und RSS', () => {
    const { data, incidents } = sample()
    const json = JSON.stringify(data)
    const page = renderStatusPage(data)
    const feed = renderStatusFeed(data, feedIncidents(incidents, new Map([[PID, 'Fotoalbum'], [PID2, 'Blog']]), new Set(['aaaaaaaa-0000-4000-8000-000000000002'])), 'https://status.example.ch')
    for (const [what, text] of [['JSON', json], ['Seite', page], ['RSS', feed]] as const) {
      for (const bad of [PID, PID2, HIDDEN, IID, 'fotoalbum.int', 'blog-intern', '10.0.3.7', '172.18.', 'sha256:', 'ECONNREFUSED', 'Geheim']) {
        assert.ok(!text.includes(bad), `${what} enthält «${bad}»`)
      }
      assert.doesNotMatch(text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, `${what} enthält eine IP`)
    }
  })

  test('Projekte nach Name, je genau 90 Tage, älteste zuerst; Störung nennt nur Projekte auf der Seite', () => {
    const { data } = sample()
    assert.deepEqual(data.projects.map((p) => p.name), ['Blog', 'Fotoalbum'])
    for (const p of data.projects) {
      assert.equal(p.days.length, STATUS_DAYS)
      assert.equal(p.days.at(-1)!.date, '2026-11-12')
      assert.equal(p.days[0]!.date, '2026-08-15')
    }
    assert.deepEqual(data.incidents.map((i) => i.title), ['Blog nicht erreichbar'])
    assert.deepEqual(data.incidents[0]!.projects, ['Blog'])
    assert.equal(data.incidents[0]!.key, incidentKey(IID))
    assert.equal(data.overall, 'stoerung')
  })
})

describe('Verfügbarkeit', () => {
  test('Tage ohne Messung sind «keine Daten», nie geschätzt', () => {
    const days = statusDays([{ date: '2026-11-12', upMinutes: 10, downMinutes: 0, pausedMinutes: 0 }], '2026-11-12')
    assert.equal(days.filter((d) => d.state === 'keine-daten').length, 89)
    assert.equal(days.filter((d) => d.availability === null).length, 89)
    assert.equal(days.at(-1)!.state, 'ok')
  })

  test('Prozent über gemessene Minuten, abgerundet; eine Minute Ausfall ist nie 100 %', () => {
    assert.equal(availabilityOf([]), null)
    assert.equal(availabilityOf([{ upMinutes: 1440, downMinutes: 0 }]), 100)
    assert.equal(availabilityOf([{ upMinutes: 14399, downMinutes: 1 }]), 99.99)
    assert.equal(availabilityOf([{ upMinutes: 100_000, downMinutes: 1 }]), 99.99)
    assert.equal(availabilityOf([{ upMinutes: 1430, downMinutes: 10 }, { upMinutes: 0, downMinutes: 0 }]), 99.3)
    assert.equal(fmtPercent(99.3), '99,30 %')
    assert.equal(fmtPercent(100), '100 %')
  })

  test('Wartung zählt nicht; Zustand je Tag nach Anteil der Störung', () => {
    assert.equal(dayState({ upMinutes: 0, downMinutes: 0, pausedMinutes: 60 }), 'pausiert')
    assert.equal(dayState({ upMinutes: 0, downMinutes: 0, pausedMinutes: 0 }), 'keine-daten')
    assert.equal(dayState({ upMinutes: 1430, downMinutes: 10, pausedMinutes: 0 }), 'teilweise')
    assert.equal(dayState({ upMinutes: 1000, downMinutes: 100, pausedMinutes: 300 }), 'stoerung')
    assert.equal(availabilityOf([{ upMinutes: 60, downMinutes: 0 }]), 100)
  })

  test('Kalendertag in der Zeitzone der Anzeige (kurz nach Mitternacht in Zürich)', () => {
    assert.equal(dayInZone(new Date('2026-11-11T23:30:00Z'), TZ), '2026-11-12')
    assert.equal(dayInZone(new Date('2026-11-11T22:30:00Z'), TZ), '2026-11-11')
  })

  test('Standard «Auf Statusseite zeigen»: öffentlich an, intern aus; ausdrücklich gewinnt', () => {
    assert.equal(showsOnStatusPage(null, true), true)
    assert.equal(showsOnStatusPage(null, false), false)
    assert.equal(showsOnStatusPage(false, true), false)
    assert.equal(showsOnStatusPage(true, false), true)
  })
})

describe('automatische Störung nach 5 Minuten', () => {
  const t0 = Date.parse('2026-11-12T10:00:00Z')
  const min = 60_000
  const down = [{ projectId: PID, name: 'Fotoalbum', state: 'down' as const }]

  test('erst ab 5 Minuten ununterbrochen gestört, dann genau eine', () => {
    let since = new Map<string, number>()
    for (let m = 0; m < 5; m++) {
      const plan = planAutoIncidents({ now: t0 + m * min, observations: down, downSince: since, openAuto: [] })
      assert.deepEqual(plan.create, [], `nach ${m} Minuten schon angelegt`)
      since = plan.downSince
    }
    const plan = planAutoIncidents({ now: t0 + 5 * min, observations: down, downSince: since, openAuto: [] })
    assert.deepEqual(plan.create, [{ projectId: PID, name: 'Fotoalbum', since: t0 }])
    // Schon offen: keine zweite
    const again = planAutoIncidents({ now: t0 + 6 * min, observations: down, downSince: plan.downSince, openAuto: [{ id: 'i1', projectId: PID }] })
    assert.deepEqual(again.create, [])
  })

  test('ein Zwischenhoch setzt die Uhr zurück; Wartung ist keine Störung', () => {
    let since = new Map<string, number>()
    since = planAutoIncidents({ now: t0, observations: down, downSince: since, openAuto: [] }).downSince
    since = planAutoIncidents({ now: t0 + 3 * min, observations: [{ ...down[0]!, state: 'up' }], downSince: since, openAuto: [] }).downSince
    const plan = planAutoIncidents({ now: t0 + 6 * min, observations: down, downSince: since, openAuto: [] })
    assert.deepEqual(plan.create, [])
    const paused = planAutoIncidents({ now: t0 + 60 * min, observations: [{ ...down[0]!, state: 'paused' }], downSince: new Map([[PID, t0]]), openAuto: [] })
    assert.deepEqual(paused.create, [])
    assert.equal(paused.downSince.has(PID), false)
  })

  test('läuft es wieder: offene automatische Störung wird behoben', () => {
    const plan = planAutoIncidents({ now: t0, observations: [{ projectId: PID, name: 'Fotoalbum', state: 'up' }], downSince: new Map([[PID, t0 - 10 * min]]), openAuto: [{ id: 'i1', projectId: PID }] })
    assert.deepEqual(plan.resolve, [{ incidentId: 'i1', projectId: PID, name: 'Fotoalbum' }])
  })
})

describe('RSS', () => {
  test('gültiges RSS 2.0 mit escaped Text, neueste zuerst, guid ändert sich mit jedem Update', () => {
    const { data } = sample()
    const inc = [
      publicIncident({ id: IID, title: 'A & <B>', state: 'erkannt', createdAt: new Date('2026-11-12T12:00:00Z'), resolvedAt: null, projectIds: [],
        updates: [{ state: 'erkannt', body: 'Ursache: "Platte voll"', createdAt: new Date('2026-11-12T12:30:00Z') }, { state: 'untersucht', body: 'x', createdAt: new Date('2026-11-12T12:00:00Z') }] }, new Map()),
      publicIncident({ id: 'bbbbbbbb-0000-4000-8000-000000000001', title: 'Früher', state: 'behoben', createdAt: new Date('2026-11-01T12:00:00Z'), resolvedAt: new Date('2026-11-01T13:00:00Z'), projectIds: [],
        updates: [{ state: 'behoben', body: 'ok', createdAt: new Date('2026-11-01T13:00:00Z') }] }, new Map()),
    ]
    const feed = renderStatusFeed(data, inc, 'https://status.example.ch/')
    assert.match(feed, /^<\?xml version="1.0" encoding="utf-8"\?>\n<rss version="2.0">/)
    assert.ok(feed.includes('<title>Ursache erkannt: A &amp; &lt;B&gt;</title>'))
    assert.ok(feed.includes('&quot;Platte voll&quot;'))
    assert.ok(feed.indexOf('A &amp;') < feed.indexOf('Früher'))
    assert.ok(feed.includes(`<guid isPermaLink="false">stoerung-${incidentKey(IID)}-2</guid>`))
    assert.ok(feed.includes(`<link>https://status.example.ch/#stoerung-${incidentKey(IID)}</link>`))
    assert.ok(feed.includes('<pubDate>Thu, 12 Nov 2026 12:30:00 GMT</pubDate>'))
    assert.equal((feed.match(/<item>/g) ?? []).length, 2)
  })
})

describe('Seite', () => {
  test('ein Tab-Halt je Verlauf (heute), Texte je Tag, Zustand mit Wort, RSS verlinkt, kein Inline-Skript', () => {
    const { data } = sample()
    const html = renderStatusPage(data)
    assert.equal((html.match(/tabindex="0"/g) ?? []).length, 2)
    assert.ok(html.includes('12. November 2026 (heute, bisher)'))
    assert.ok(html.includes('keine Daten'))
    assert.ok(html.includes('Störung</p>') || html.includes('Störung\n'))
    assert.ok(html.includes('href="feed.xml"'))
    assert.ok(!/<script>(?!<\/script>)/.test(html), 'Inline-Skript gefunden')
    assert.ok(!/ style="/.test(html), 'Inline-Stil gefunden')
    assert.ok(!/(src|href)="https?:\/\//.test(html), 'Datei von aussen')
  })

  test('Titel und Texte werden escaped', () => {
    const { data } = sample()
    const html = renderStatusPage({ ...data, title: '<script>x</script>', incidents: [{ ...data.incidents[0]!, title: '{http.request.host}' }] })
    assert.ok(!html.includes('<script>x'))
    assert.ok(html.includes('&#123;http.request.host&#125;'))
  })
})

describe('Caddy, Tunnel und Name', () => {
  test('Route status.<zone>: nur von cloudflared, Pfad in den Ordner der Umgebung, Header wie Projekte, kein Besucher-Log', () => {
    const spec = statusRouteSpec({ hostname: 'status.example.ch', dir: 'example', upstream: 'airlock-status:8080', edgeCidrs: ['172.30.0.5/32'], templates: [{ header: 'referrer-policy', value: 'no-referrer', mode: 'enforce' }] })!
    const cfg = buildCaddyConfig([spec], { ipFilter: true, cidrs: ['192.168.1.0/24'], adminSocket: '/run/caddy/admin.sock', visitsLogDir: '/var/log/airlock-access' }) as {
      apps: { http: { servers: { srv0: { routes: { match?: { host: string[]; remote_ip?: { ranges: string[] } }[]; handle: Record<string, unknown>[] }[] } } } }
      logging: { logs: Record<string, unknown> }
    }
    const route = cfg.apps.http.servers.srv0.routes.find((r) => r.match?.[0]?.host.includes('status.example.ch') && r.handle.some((h) => h.handler === 'reverse_proxy'))!
    assert.deepEqual(route.match![0]!.remote_ip, { ranges: ['172.30.0.5/32'] })
    const json = JSON.stringify(route.handle)
    assert.ok(json.includes('"uri":"/example{http.request.uri.path}"'))
    assert.ok(json.includes('"dial":"airlock-status:8080"'))
    assert.ok(json.includes(STATUS_CSP.replace(/'/g, "'")))
    assert.ok(json.includes('no-referrer'), 'Vorlage der Umgebung fehlt')
    assert.ok(json.includes('nosniff'), 'Standard-Header fehlt')
    assert.ok(json.includes('Permissions-Policy'))
    assert.ok(!('visits' in cfg.logging.logs), 'Statusseite im Besucher-Log')
    // Ohne Tunnel keine Route
    assert.equal(statusRouteSpec({ hostname: 'status.example.ch', dir: 'example', upstream: 'x:1', edgeCidrs: [], templates: [] }), null)
  })

  test('«status» ist für Projekte reserviert; der Tunnel führt status.<zone> zu Caddy', () => {
    assert.ok((RESERVED_PUBLIC_LABELS as readonly string[]).includes('status'))
    assert.throws(() => resolvePublicHostname({ subdomain: 'status' }, { zones: [{ id: 'z', name: 'example.ch' }], defaultZone: 'example.ch', internalBaseDomain: 'int.example.ch', reservedLabels: RESERVED_PUBLIC_LABELS }), /reserviert/)
    const { ingress } = reconcileIngress([], ['foto.example.ch', 'status.example.ch'], [])
    assert.deepEqual(ingress.find((r) => r.hostname === 'status.example.ch'), { hostname: 'status.example.ch', service: 'http://caddy:80' })
  })
})
