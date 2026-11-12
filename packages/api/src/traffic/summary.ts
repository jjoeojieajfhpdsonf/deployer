import {
  TRAFFIC_WAY_LABEL, TRAFFIC_DEVICE_LABEL, UNKNOWN_VALUE, countryName, languageName,
  type TrafficDevice, type TrafficSummaryDto,
} from '@airlock/shared'

/**
 * Die Rechnung selbst (Summen, Kurve, Ranglisten, Auflösung, Messbeginn)
 * liegt rein in @airlock/shared (traffic-summary.ts), damit die Bilder der
 * Oberfläche dieselbe Rechnung benutzen. Hier nur, was nur die API braucht.
 */
export {
  summarize, rangeStart, startOfToday, localMidnight, tzOffset, bucketStart, nextBucket, daysBefore,
  type TrafficHourRow, type TrafficDimRow,
} from '@airlock/shared'

const word = (v: string) => (v === UNKNOWN_VALUE ? 'unbekannt' : v)

/**
 * Antwort des MCP-Werkzeugs get_traffic: dieselben Zahlen, als Wörter
 * statt Codes (Zugang, Länder, Sprachen), ohne IP und ohne Kennung.
 */
export function mcpTraffic(project: string, s: TrafficSummaryDto) {
  const errors = s.statuses.filter((x) => x.status >= 400)
  return {
    project,
    range: s.range,
    from: s.from,
    to: s.to,
    measured_since: s.source.since,
    resolution: s.bucket,
    views: s.totals.views,
    visitors: s.totals.visitors,
    pages_per_visitor: s.totals.pagesPerVisit === null ? null : Math.round(s.totals.pagesPerVisit * 10) / 10,
    not_found: s.totals.notFound,
    bots_not_counted: s.totals.bots,
    ...(s.previous ? { previous_period: { views: s.previous.views, visitors: s.previous.visitors, not_found: s.previous.notFound, bots: s.previous.bots } } : {}),
    by_access: Object.fromEntries(s.ways.map((w) => [TRAFFIC_WAY_LABEL[w.way], { views: w.views, visitors: w.visitors }])),
    series: s.series.map((p) => ({ at: p.at, views: p.views, visitors: p.visitors, not_found: p.notFound, bots: p.bots })),
    top_pages: s.pages.slice(0, 20).map((p) => ({ path: p.key, views: p.views })),
    entry_pages: s.entries.slice(0, 10).map((p) => ({ path: p.key, visits: p.views })),
    exit_pages: s.exits.slice(0, 10).map((p) => ({ path: p.key, visits: p.views })),
    not_found_paths: s.notFound.slice(0, 20).map((p) => ({ path: p.key, views: p.views, ...(p.scanner ? { likely_scanner: true } : {}) })),
    referrers: s.referrers.slice(0, 20).map((p) => ({ source: p.key || 'direkt / Lesezeichen', views: p.views })),
    referrers_hidden: { within_site: s.referrersHidden.internal, airlock_itself: s.referrersHidden.airlock },
    campaigns: s.campaigns.slice(0, 20).map((c) => ({ source: c.source, medium: c.medium, campaign: c.campaign, views: c.views })),
    countries: s.countries.slice(0, 10).map((c) => ({ code: c.key || null, name: countryName(c.key), views: c.views, visitors: c.visitors })),
    ...(s.cities.length ? { cities: s.cities.map((c) => ({ city: c.key, country: c.country, views: c.views })) } : {}),
    devices: s.devices.map((d) => ({ device: TRAFFIC_DEVICE_LABEL[d.key as TrafficDevice] ?? d.key, views: d.views })),
    browsers: s.browsers.slice(0, 10).map((b) => ({ browser: word(b.key), views: b.views })),
    systems: s.systems.slice(0, 10).map((b) => ({ system: word(b.key), views: b.views })),
    languages: s.languages.slice(0, 10).map((l) => ({ language: l.key === UNKNOWN_VALUE ? 'unbekannt' : languageName(l.key), code: l.key === UNKNOWN_VALUE ? null : l.key, views: l.views })),
    ...(s.source.asnDb ? {
      networks: s.networks.slice(0, 10).map((n) => ({ asn: n.asn, name: n.name, views: n.views, bots: n.bots, ...(n.datacenter ? { datacenter_likely_bot: true } : {}) })),
    } : {}),
    status_codes: Object.fromEntries(s.statuses.map((x) => [String(x.status), x.views])),
    errors: { client_4xx: errors.filter((x) => x.status < 500).reduce((n, x) => n + x.views, 0), server_5xx: errors.filter((x) => x.status >= 500).reduce((n, x) => n + x.views, 0) },
    note: s.source.ingest === 'ok'
      ? 'Aufrufe: Seiten mit Status 2xx/3xx, ohne Bots (User-Agent oder Rechenzentrum), eigene Prüfungen, Healthchecks und statische Dateien; 404 steht unter not_found. Besucher: eindeutig je Tag (Hash mit Tagessalz, keine IP gespeichert), über den Zeitraum aufaddiert. Einstieg/Ausstieg ohne Besucher mit DNT oder Sec-GPC. Vor measured_since gibt es keine Zahlen.'
      : s.source.ingest === 'waiting'
        ? 'Das Zugriffs-Log von Caddy ist eingerichtet, aber noch nicht lesbar (Volume caddy_access). Zahlen fehlen bis dahin.'
        : 'Die Besucher-Auswertung ist nicht eingerichtet (ACCESS_LOG_DIR leer).',
  }
}
