import { z } from 'zod'
import { escapeHtml } from './pause-page.js'

/**
 * Etappe 5 «Statusseite»: öffentliche Seite status.<hauptzone> je Umgebung.
 *
 * Airlock schreibt jede Minute index.html, status.json, feed.xml und die
 * beiden Dateien status.css/status.js in ein Volume; der Container
 * airlock-status liefert sie nur aus (kein Zugriff auf Airlock, Datenbank
 * oder Docker). Dieser Teil ist rein (kein DOM, kein Node): derselbe
 * Renderer für den Server und für die Test-Szene der Oberfläche.
 *
 * Grundsatz: Auf die Seite kommt nur, was in PublicStatusJson steht – Name,
 * Zustand, Tageswerte, Störungen. Keine Projekt-IDs, Kurznamen,
 * Hostnamen, IPs, Versionen oder Fehlertexte.
 */

/** Label der Seite in der Hauptzone: status.<zone> (für Projekte reserviert) */
export const STATUS_HOST_LABEL = 'status'
/** Tage im Balken */
export const STATUS_DAYS = 90
/** Ab so langer Störung legt Airlock selbst einen Eintrag an */
export const STATUS_AUTO_DOWN_MS = 5 * 60_000
/** Erledigte Störungen bleiben so lange auf der Seite sichtbar (RSS: die letzten 50) */
export const STATUS_PAST_DAYS = 14
/** Standardtitel der Seite */
export const STATUS_DEFAULT_TITLE = 'Status'

/* --- Störungen -------------------------------------------------------------------- */

export const incidentStates = ['untersucht', 'erkannt', 'behoben'] as const
export type IncidentState = (typeof incidentStates)[number]

/** Wort je Zustand – überall gleich (Airlock, Seite, RSS) */
export const INCIDENT_STATE_LABEL: Record<IncidentState, string> = {
  untersucht: 'Wird untersucht',
  erkannt: 'Ursache erkannt',
  behoben: 'Behoben',
}

const incidentText = z.string().trim().min(1, 'Bitte einen Text eingeben').max(2000, 'Höchstens 2000 Zeichen')

export const incidentCreateSchema = z.object({
  title: z.string().trim().min(1, 'Bitte einen Titel eingeben').max(120, 'Höchstens 120 Zeichen'),
  body: incidentText,
  state: z.enum(incidentStates).default('untersucht'),
  /** Betroffene Projekte (nur solche auf der Statusseite erscheinen öffentlich) */
  projectIds: z.array(z.string().uuid()).max(20).default([]),
})
export type IncidentCreateInput = z.infer<typeof incidentCreateSchema>

export const incidentUpdateSchema = z.object({
  state: z.enum(incidentStates),
  body: incidentText,
})
export type IncidentUpdateInput = z.infer<typeof incidentUpdateSchema>

export const statusSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  title: z.string().trim().min(1, 'Bitte einen Titel eingeben').max(80, 'Höchstens 80 Zeichen').optional(),
})
export type StatusSettingsInput = z.infer<typeof statusSettingsSchema>

export interface IncidentUpdateDto {
  id: string
  state: IncidentState
  body: string
  at: string
  /** Wer: «admin», «system» (automatisch) */
  actor: string
}

export interface IncidentDto {
  id: string
  title: string
  state: IncidentState
  /** Von Airlock angelegt (Projekt länger als 5 Minuten nicht erreichbar) */
  auto: boolean
  projects: { id: string; name: string; shown: boolean }[]
  createdAt: string
  resolvedAt: string | null
  /** Neueste zuerst */
  updates: IncidentUpdateDto[]
}

/** Einstellungen und Zustand der Statusseite einer Umgebung (Airlock-Oberfläche) */
export interface StatusPageDto {
  enabled: boolean
  title: string
  /** status.<hauptzone>; null ohne Hauptzone */
  hostname: string | null
  /** Öffentlich erreichbar: Cloudflare-Token, Tunnel und Hauptzone eingerichtet */
  publicReady: boolean
  /** Warum (noch) nicht erreichbar – Satz für die Oberfläche; null = alles da */
  problem: string | null
  /** Zuletzt in das Volume geschrieben (null: noch nie, oder Ablage aus) */
  writtenAt: string | null
  /** Ablage im Volume eingerichtet (STATUS_DIR) */
  storage: boolean
  projects: { id: string; name: string; shown: boolean; explicit: boolean; public: boolean }[]
}

/* --- Projekte: wer erscheint ---------------------------------------------------- */

/** «Auf Statusseite zeigen»: ausdrücklich gesetzt oder Standard (öffentlich an, intern aus) */
export function showsOnStatusPage(explicit: boolean | null | undefined, isPublic: boolean): boolean {
  return explicit ?? isPublic
}

/* --- Öffentliche Daten (status.json) ------------------------------------------- */

export type PublicDayState = 'ok' | 'teilweise' | 'stoerung' | 'pausiert' | 'keine-daten'
export type PublicProjectState = 'ok' | 'stoerung' | 'pausiert' | 'unbekannt'
export type PublicOverall = 'ok' | 'stoerung' | 'leer'

export interface PublicStatusDay {
  /** JJJJ-MM-TT (Zeitzone der Seite) */
  date: string
  state: PublicDayState
  /** Anteil erreichbarer Minuten in Prozent; null ohne Messung */
  availability: number | null
  downMinutes: number
}

export interface PublicStatusProject {
  name: string
  state: PublicProjectState
  /** Über alle Tage mit Messung; null ohne Messung */
  availability: number | null
  /** Älteste zuerst, genau STATUS_DAYS */
  days: PublicStatusDay[]
}

export interface PublicStatusIncident {
  /** Kurzer Schlüssel für Anker und RSS (kein Datenbank-Schlüssel) */
  key: string
  title: string
  state: IncidentState
  startedAt: string
  resolvedAt: string | null
  /** Namen der betroffenen Projekte, die auf der Seite stehen */
  projects: string[]
  /** Neueste zuerst */
  updates: { at: string; state: IncidentState; text: string }[]
}

export interface PublicStatusJson {
  version: 1
  title: string
  generatedAt: string
  /** Zeitzone für die Anzeige von Tagen und Uhrzeiten */
  timeZone: string
  overall: PublicOverall
  /** Offene zuerst, dann erledigte der letzten STATUS_PAST_DAYS Tage */
  incidents: PublicStatusIncident[]
  projects: PublicStatusProject[]
}

/** Felder, die status.json je haben darf – der Test prüft dagegen (nichts Internes). */
export const PUBLIC_STATUS_FIELDS = {
  root: ['version', 'title', 'generatedAt', 'timeZone', 'overall', 'incidents', 'projects'],
  project: ['name', 'state', 'availability', 'days'],
  day: ['date', 'state', 'availability', 'downMinutes'],
  incident: ['key', 'title', 'state', 'startedAt', 'resolvedAt', 'projects', 'updates'],
  update: ['at', 'state', 'text'],
} as const

/* --- Tageswerte und Verfügbarkeit ---------------------------------------------- */

/** Minuten eines Tages, wie Airlock sie misst */
export interface StatusDayCount {
  date: string
  upMinutes: number
  downMinutes: number
  /** Absichtlich angehalten oder öffentlich pausiert: zählt nicht zur Verfügbarkeit */
  pausedMinutes: number
}

/** Ab diesem Anteil Störung (in Prozent der gemessenen Minuten) ist ein Tag «Störung» statt «teilweise» */
export const STATUS_BAD_DAY_DOWN_PERCENT = 5

const round2 = (v: number) => Math.floor(v * 100) / 100

/** Zustand eines Tages aus den Minuten. Ohne Messung: «keine Daten» – nie geschätzt. */
export function dayState(c: Pick<StatusDayCount, 'upMinutes' | 'downMinutes' | 'pausedMinutes'> | null | undefined): PublicDayState {
  if (!c) return 'keine-daten'
  const measured = c.upMinutes + c.downMinutes
  if (measured === 0) return c.pausedMinutes > 0 ? 'pausiert' : 'keine-daten'
  if (c.downMinutes === 0) return 'ok'
  return (c.downMinutes / measured) * 100 >= STATUS_BAD_DAY_DOWN_PERCENT ? 'stoerung' : 'teilweise'
}

/**
 * Verfügbarkeit in Prozent, abgerundet auf zwei Stellen (100 nur ganz ohne
 * Störung – eine Minute Ausfall zeigt nie «100 %»). null ohne Messung.
 */
export function availabilityOf(counts: readonly Pick<StatusDayCount, 'upMinutes' | 'downMinutes'>[]): number | null {
  let up = 0
  let down = 0
  for (const c of counts) { up += c.upMinutes; down += c.downMinutes }
  if (up + down === 0) return null
  return round2((up / (up + down)) * 100)
}

/** Tag JJJJ-MM-TT minus n Tage (Kalenderrechnung, ohne Zeitzone) */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return t.toISOString().slice(0, 10)
}

/** Kalendertag eines Zeitpunkts in einer Zeitzone (JJJJ-MM-TT) */
export function dayInZone(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Die letzten n Tage bis «heute», älteste zuerst; fehlende Tage als «keine Daten» */
export function statusDays(counts: readonly StatusDayCount[], today: string, n = STATUS_DAYS): PublicStatusDay[] {
  const by = new Map(counts.map((c) => [c.date, c]))
  const out: PublicStatusDay[] = []
  for (let i = n - 1; i >= 0; i--) {
    const date = addDays(today, -i)
    const c = by.get(date)
    out.push({ date, state: dayState(c), availability: c ? availabilityOf([c]) : null, downMinutes: c?.downMinutes ?? 0 })
  }
  return out
}

/** Gesamtzustand der Seite */
export function overallOf(projects: readonly { state: PublicProjectState }[], incidents: readonly { state: IncidentState }[]): PublicOverall {
  if (projects.some((p) => p.state === 'stoerung') || incidents.some((i) => i.state !== 'behoben')) return 'stoerung'
  if (projects.length === 0) return 'leer'
  return 'ok'
}

/* --- Formate ------------------------------------------------------------------- */

/** «99,95 %» (Dezimalkomma wie in der Oberfläche) */
export function fmtPercent(v: number | null): string {
  if (v === null) return 'keine Daten'
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: 2, minimumFractionDigits: v === 100 ? 0 : 2 })} %`
}

const dateLabel = (date: string, timeZone: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  // Mittag UTC: in jeder Zeitzone derselbe Kalendertag
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('de-CH', { day: 'numeric', month: 'long', year: 'numeric', timeZone })
}
const timeLabel = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleString('de-CH', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone })

/** Minuten als «10 Min.» bzw. «2 Std. 5 Min.» */
export function fmtMinutes(min: number): string {
  if (min < 60) return `${min} Min.`
  const h = Math.floor(min / 60)
  const r = min % 60
  return r ? `${h} Std. ${r} Min.` : `${h} Std.`
}

/** Text eines Tages (Tooltip, Screenreader) */
export function dayText(day: PublicStatusDay, timeZone: string, today: boolean): string {
  const when = `${dateLabel(day.date, timeZone)}${today ? ' (heute, bisher)' : ''}`
  switch (day.state) {
    case 'keine-daten': return `${when}: keine Daten`
    case 'pausiert': return `${when}: Wartung, nicht gemessen`
    case 'ok': return `${when}: ${fmtPercent(day.availability)} verfügbar`
    default: return `${when}: ${fmtPercent(day.availability)} verfügbar, ${fmtMinutes(day.downMinutes)} Störung`
  }
}

export const PROJECT_STATE_LABEL: Record<PublicProjectState, string> = {
  ok: 'Läuft',
  stoerung: 'Störung',
  pausiert: 'Wartung',
  unbekannt: 'Unbekannt',
}
/** Zeichen neben dem Wort (nie nur Farbe) */
const PROJECT_STATE_MARK: Record<PublicProjectState, string> = { ok: '✓', stoerung: '✕', pausiert: '‖', unbekannt: '?' }
const INCIDENT_STATE_MARK: Record<IncidentState, string> = { untersucht: '!', erkannt: '!', behoben: '✓' }

/* --- Seite -------------------------------------------------------------------- */

/**
 * CSP der Statusseite (Caddy setzt sie vor dem Container): nur eigene
 * Dateien, kein Inline, kein fremdes Ziel.
 */
export const STATUS_CSP = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'"

/** Dateien im Ordner einer Umgebung (flach, keine Unterordner) */
export const STATUS_FILES = { page: 'index.html', json: 'status.json', feed: 'feed.xml', css: 'status.css', js: 'status.js' } as const

/** Text mit Leerzeilen als Absätze (kein Markdown, alles escaped) */
function paragraphs(text: string): string {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')
}

const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%231e7a46'/%3E%3C/svg%3E"

function renderIncident(i: PublicStatusIncident, tz: string, level: 'h3'): string {
  const open = i.state !== 'behoben'
  const updates = i.updates.map((u) => `
          <li class="update">
            <p class="update-head"><strong>${escapeHtml(INCIDENT_STATE_LABEL[u.state])}</strong> <time datetime="${escapeHtml(u.at)}">${escapeHtml(timeLabel(u.at, tz))}</time></p>
            <div class="update-text">${paragraphs(u.text)}</div>
          </li>`).join('')
  return `
      <article class="incident ${open ? 'incident-open' : 'incident-done'}" id="stoerung-${escapeHtml(i.key)}" aria-labelledby="t-${escapeHtml(i.key)}">
        <div class="incident-head">
          <${level} id="t-${escapeHtml(i.key)}">${escapeHtml(i.title)}</${level}>
          <p class="pill pill-${open ? 'open' : 'done'}"><span aria-hidden="true">${INCIDENT_STATE_MARK[i.state]}</span> ${escapeHtml(INCIDENT_STATE_LABEL[i.state])}</p>
        </div>
        ${i.projects.length ? `<p class="affected">Betrifft: ${i.projects.map(escapeHtml).join(', ')}</p>` : ''}
        <ol class="updates" aria-label="Verlauf">${updates}
        </ol>
      </article>`
}

function renderProject(p: PublicStatusProject, tz: string, idx: number): string {
  const last = p.days.length - 1
  const days = p.days.map((d, n) => {
    const edge = n < 8 ? ' tip-start' : n > last - 8 ? ' tip-end' : ''
    return `<li class="day day-${d.state}${edge}" tabindex="${n === last ? 0 : -1}"><span class="bar" aria-hidden="true"></span><span class="tip">${escapeHtml(dayText(d, tz, n === last))}</span></li>`
  }).join('')
  const titleId = `p-${idx}`
  return `
      <li class="project">
        <div class="project-head">
          <h3 id="${titleId}">${escapeHtml(p.name)}</h3>
          <p class="state state-${p.state}"><span aria-hidden="true">${PROJECT_STATE_MARK[p.state]}</span> ${PROJECT_STATE_LABEL[p.state]}</p>
        </div>
        <ol class="days" aria-label="${escapeHtml(p.name)}: Verfügbarkeit der letzten ${p.days.length} Tage, älteste zuerst">${days}</ol>
        <div class="project-foot" aria-hidden="true"><span>vor ${p.days.length} Tagen</span><span>heute</span></div>
        <p class="availability">${p.availability === null ? 'Noch keine Messung' : `${fmtPercent(p.availability)} verfügbar`}<span class="muted"> · über die Tage mit Messung</span></p>
      </li>`
}

const OVERALL_TEXT = (data: PublicStatusJson): string => {
  if (data.overall === 'leer') return 'Noch keine Dienste auf dieser Seite'
  const down = data.projects.filter((p) => p.state === 'stoerung').length
  if (down) return `Störung bei ${down} von ${data.projects.length} ${data.projects.length === 1 ? 'Dienst' : 'Diensten'}`
  if (data.overall === 'stoerung') return 'Es gibt eine aktuelle Störung'
  return 'Alle Dienste laufen'
}

/** Die ganze Seite als statisches HTML (funktioniert auch ohne JavaScript). */
export function renderStatusPage(data: PublicStatusJson): string {
  const tz = data.timeZone
  const open = data.incidents.filter((i) => i.state !== 'behoben')
  const past = data.incidents.filter((i) => i.state === 'behoben')
  const overallMark = data.overall === 'ok' ? '✓' : data.overall === 'leer' ? '–' : '!'
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(data.title)}</title>
  <link rel="icon" href="${ICON}">
  <link rel="stylesheet" href="${STATUS_FILES.css}">
  <link rel="alternate" type="application/rss+xml" title="Störungen – ${escapeHtml(data.title)}" href="${STATUS_FILES.feed}">
  <script src="${STATUS_FILES.js}" defer></script>
</head>
<body>
  <a class="skip" href="#dienste">Zu den Diensten</a>
  <header class="wrap top">
    <h1>${escapeHtml(data.title)}</h1>
    <p class="overall overall-${data.overall}"><span class="overall-mark" aria-hidden="true">${overallMark}</span> ${escapeHtml(OVERALL_TEXT(data))}</p>
  </header>
  <main class="wrap">
    ${open.length ? `<section class="block" aria-labelledby="h-aktuell">
      <h2 id="h-aktuell">Aktuelle Störungen</h2>${open.map((i) => renderIncident(i, tz, 'h3')).join('')}
    </section>` : ''}
    <section class="block" id="dienste" aria-labelledby="h-dienste" tabindex="-1">
      <h2 id="h-dienste">Dienste</h2>
      ${data.projects.length ? `<div class="legend">
        <p>Je Balken ein Tag. Mit der Tab-Taste einen Verlauf wählen, mit den Pfeiltasten den Tag wechseln.</p>
        <ul class="legend-list">
          <li><span class="key day-ok" aria-hidden="true"><span class="bar"></span></span> Verfügbar</li>
          <li><span class="key day-teilweise" aria-hidden="true"><span class="bar"></span></span> Kurze Störung</li>
          <li><span class="key day-stoerung" aria-hidden="true"><span class="bar"></span></span> Störung (ab ${STATUS_BAD_DAY_DOWN_PERCENT} % des Tages)</li>
          <li><span class="key day-pausiert" aria-hidden="true"><span class="bar"></span></span> Wartung</li>
          <li><span class="key day-keine-daten" aria-hidden="true"><span class="bar"></span></span> Keine Daten</li>
        </ul>
      </div>
      <ul class="projects">${data.projects.map((p, i) => renderProject(p, tz, i)).join('')}
      </ul>` : '<p class="muted">Hier erscheinen Dienste, sobald sie für die Statusseite freigegeben sind.</p>'}
    </section>
    ${past.length ? `<section class="block" aria-labelledby="h-vergangen">
      <h2 id="h-vergangen">Behobene Störungen der letzten ${STATUS_PAST_DAYS} Tage</h2>${past.map((i) => renderIncident(i, tz, 'h3')).join('')}
    </section>` : ''}
  </main>
  <footer class="wrap foot">
    <p><a href="${STATUS_FILES.feed}">Störungen als RSS-Feed</a></p>
    <p class="muted">Stand <time datetime="${escapeHtml(data.generatedAt)}">${escapeHtml(timeLabel(data.generatedAt, tz))}</time> · wird jede Minute aktualisiert</p>
  </footer>
</body>
</html>
`
}

/* --- RSS ---------------------------------------------------------------------- */

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/**
 * RSS 2.0 der Störungen (neueste zuerst). Ein Eintrag je Störung; die guid
 * enthält die Anzahl der Updates, damit ein neues Update im Reader erscheint.
 */
export function renderStatusFeed(data: PublicStatusJson, incidents: readonly PublicStatusIncident[], siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, '')
  const items = [...incidents]
    .sort((a, b) => (b.updates[0]?.at ?? b.startedAt).localeCompare(a.updates[0]?.at ?? a.startedAt))
    .map((i) => {
      const last = i.updates[0]?.at ?? i.startedAt
      const history = i.updates.map((u) => `${INCIDENT_STATE_LABEL[u.state]} (${timeLabel(u.at, data.timeZone)}): ${u.text}`).join('\n\n')
      const affected = i.projects.length ? `Betrifft: ${i.projects.join(', ')}\n\n` : ''
      return `
    <item>
      <title>${xml(`${INCIDENT_STATE_LABEL[i.state]}: ${i.title}`)}</title>
      <link>${xml(`${base}/#stoerung-${i.key}`)}</link>
      <guid isPermaLink="false">${xml(`stoerung-${i.key}-${i.updates.length}`)}</guid>
      <pubDate>${new Date(last).toUTCString()}</pubDate>
      <description>${xml(affected + history)}</description>
    </item>`
    }).join('')
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>${xml(`Störungen – ${data.title}`)}</title>
    <link>${xml(`${base}/`)}</link>
    <description>${xml(`Störungen und Updates von ${data.title}`)}</description>
    <language>de</language>
    <lastBuildDate>${new Date(data.generatedAt).toUTCString()}</lastBuildDate>
    <ttl>5</ttl>${items}
  </channel>
</rss>
`
}

/* --- Stil und Skript (eigene Dateien, keine Airlock-Assets) ------------------- */

/**
 * Ruhig und klar: eine Spalte, Systemschrift, flache Flächen, ein Radius.
 * Farben nur über die Tokens oben; Hell und Dunkel nach Gerät
 * (prefers-color-scheme). Kontraste prüft docs/design-cal/contrast.mjs
 * (Block «Statusseite»): Text ≥ 4.5:1, Balken und Rahmen ≥ 3:1.
 */
export const STATUS_CSS = `/* Statusseite – erzeugt von Airlock */
:root {
  --bg: #f7f7f5;
  --surface: #ffffff;
  --ink: #1b1b19;
  --muted: #5d5d58;
  --line: #deded9;
  --empty: #8c8c86;
  --ok: #1e7a46;
  --warn: #946200;
  --bad: #b42318;
  --ok-bg: #e9f4ed;
  --bad-bg: #fbecea;
  --focus: #1f5fbf;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131312;
    --surface: #1c1c1a;
    --ink: #ededea;
    --muted: #a6a6a0;
    --line: #34342f;
    --empty: #7c7c76;
    --ok: #4cbf7c;
    --warn: #d9a43a;
    --bad: #f07a6a;
    --ok-bg: #16281d;
    --bad-bg: #331a17;
    --focus: #79a8ff;
    color-scheme: dark;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
.wrap { width: 100%; max-width: 760px; margin: 0 auto; padding: 0 24px; }
a { color: var(--ink); text-underline-offset: 3px; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 2px; }
.skip { position: absolute; left: 16px; top: -48px; background: var(--surface); padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; }
.skip:focus { top: 12px; }
.muted { color: var(--muted); }
h1 { font-size: 28px; line-height: 1.25; margin: 0 0 16px; font-weight: 650; letter-spacing: -0.01em; }
h2 { font-size: 18px; line-height: 1.3; margin: 0 0 16px; font-weight: 650; }
h3 { font-size: 16px; line-height: 1.35; margin: 0; font-weight: 600; }
p { margin: 0; }
.top { padding-top: 56px; padding-bottom: 32px; }
.overall {
  display: flex; align-items: center; gap: 12px; padding: 16px 20px;
  background: var(--surface); border: 1px solid var(--line); border-radius: 8px; font-weight: 600;
}
.overall-mark {
  display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 50%;
  font-size: 15px; color: var(--surface); background: var(--muted); flex: none;
}
.overall-ok .overall-mark { background: var(--ok); }
.overall-stoerung { border-color: var(--bad); }
.overall-stoerung .overall-mark { background: var(--bad); }
.block { padding: 0 0 40px; }
.block:focus { outline: none; }
.incident { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 20px; margin-bottom: 12px; }
.incident-open { border-left: 4px solid var(--bad); }
.incident-head { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; flex-wrap: wrap; }
.pill { font-size: 14px; font-weight: 600; white-space: nowrap; }
.pill-open { color: var(--bad); }
.pill-done { color: var(--ok); }
.affected { color: var(--muted); font-size: 14px; margin-top: 4px; }
.updates { list-style: none; margin: 16px 0 0; padding: 0; }
.update { padding: 12px 0 0; border-top: 1px solid var(--line); margin-top: 12px; }
.update:first-child { border-top: 0; margin-top: 0; padding-top: 0; }
.update-head { font-size: 14px; }
.update-head time { color: var(--muted); margin-left: 6px; }
.update-text p { margin-top: 4px; }
.legend { color: var(--muted); font-size: 14px; margin-bottom: 16px; }
.legend-list { list-style: none; display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 10px 0 0; padding: 0; }
.legend-list li { display: inline-flex; align-items: center; gap: 8px; }
.key { display: inline-flex; align-items: flex-end; width: 8px; height: 18px; }
.projects { list-style: none; margin: 0; padding: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
.project { padding: 20px; border-top: 1px solid var(--line); }
.project:first-child { border-top: 0; }
.project-head { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; margin-bottom: 12px; }
.state { font-size: 14px; font-weight: 600; white-space: nowrap; }
.state-ok { color: var(--ok); }
.state-stoerung { color: var(--bad); }
.state-pausiert, .state-unbekannt { color: var(--muted); }
.days { list-style: none; display: flex; gap: 2px; height: 34px; margin: 0; padding: 0; }
.day { position: relative; flex: 1 1 0; min-width: 2px; display: flex; align-items: flex-end; border-radius: 2px; }
.bar, .key .bar { display: block; width: 100%; border-radius: 2px; }
/* Nie nur Farbe: die Höhe sagt dasselbe (voll = verfügbar, kürzer = Störung, Strich = keine Daten) */
.day-ok .bar { height: 100%; background: var(--ok); }
.day-teilweise .bar { height: 70%; background: var(--warn); }
.day-stoerung .bar { height: 42%; background: var(--bad); }
.day-pausiert .bar { height: 100%; border: 1px dashed var(--empty); }
.day-keine-daten .bar { height: 4px; background: var(--empty); }
.day:hover .bar { filter: brightness(1.1); }
.tip {
  /* Unter dem Balken: verdeckt nur die Achse, nie Name oder Zustand */
  position: absolute; top: calc(100% + 8px); left: 50%; transform: translateX(-50%);
  width: max-content; max-width: 260px; padding: 8px 10px; font-size: 13px; line-height: 1.4;
  background: var(--ink); color: var(--bg); border-radius: 6px; z-index: 2;
  /* Versteckt, aber für Screenreader lesbar; sichtbar bleibt er auch, wenn der Zeiger darauf wandert */
  clip-path: inset(50%); opacity: 0;
}
.tip-start .tip { left: 0; transform: none; }
.tip-end .tip { left: auto; right: 0; transform: none; }
.day:hover .tip, .day:focus .tip { clip-path: none; opacity: 1; }
.days.tips-off .tip { clip-path: inset(50%); opacity: 0; }
.project-foot { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); margin-top: 6px; }
.availability { font-size: 14px; margin-top: 8px; font-weight: 600; }
.availability .muted { font-weight: 400; }
.foot { padding-top: 8px; padding-bottom: 56px; font-size: 14px; display: flex; flex-direction: column; gap: 4px; }
@media (max-width: 560px) {
  .top { padding-top: 32px; }
  h1 { font-size: 24px; }
  .wrap { padding: 0 16px; }
  .days { gap: 1px; }
}
@media (prefers-reduced-motion: no-preference) {
  .tip { transition: opacity 120ms ease-out; }
}
`

/**
 * Tastatur: je Verlauf ein Tab-Halt (der heutige Tag), Pfeiltasten, Pos1 und
 * Ende wechseln den Tag; Esc blendet den Tooltip aus (WCAG 1.4.13). Ohne
 * JavaScript bleibt alles lesbar.
 */
export const STATUS_JS = `/* Statusseite – erzeugt von Airlock */
(function () {
  document.querySelectorAll('.days').forEach(function (list) {
    var days = Array.prototype.slice.call(list.querySelectorAll('.day'))
    list.addEventListener('keydown', function (e) {
      var i = days.indexOf(document.activeElement)
      if (i < 0) return
      if (e.key === 'Escape') { list.classList.add('tips-off'); return }
      var j = e.key === 'ArrowLeft' ? i - 1 : e.key === 'ArrowRight' ? i + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? days.length - 1 : null
      if (j === null) return
      e.preventDefault()
      j = Math.max(0, Math.min(days.length - 1, j))
      days[i].tabIndex = -1
      days[j].tabIndex = 0
      list.classList.remove('tips-off')
      days[j].focus()
    })
    list.addEventListener('focusout', function () { list.classList.remove('tips-off') })
  })
})()
`
