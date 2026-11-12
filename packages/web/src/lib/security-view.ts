import {
  HEADER_LABEL, SCORE_DEDUCTION, headerFixFor, isCspQualityFinding,
  type CspAnalysisDto, type CspViolationDto, type FindingDto, type FixRequestDto, type HeaderKey, type HeaderMode, type HeaderRulesDto, type ScanStageDto,
} from '@airlock/shared'

/**
 * Reiter Security am Projekt: reine Funktionen für Lage-Satz, Hinweise in der
 * Befundliste, Sortierung, Header-Zustände, «Würde blockieren» und die
 * Prüfstufen als Chips. Ohne React, getestet in security-view.test.ts.
 */

export type Sev = FindingDto['severity']
export const SEVERITIES: Sev[] = ['critical', 'high', 'medium', 'low']
export const SEVERITY_LABEL: Record<Sev, string> = { critical: 'kritisch', high: 'hoch', medium: 'mittel', low: 'niedrig' }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/* --- Vorschläge von Claude zum Befund ------------------------------------------- */

/**
 * Vorschläge, die zu einem Befund gehören. Nach einem neuen Scan hat derselbe
 * Befund eine neue Id; dann zählt Titel und Werkzeug. Neueste zuerst.
 */
export function fixesFor(f: Pick<FindingDto, 'id' | 'title' | 'tool'>, fixes: readonly FixRequestDto[]): FixRequestDto[] {
  return fixes
    .filter((x) => x.findingId === f.id || (x.findingTitle === f.title && x.tool === f.tool))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Ein Vorschlag wartet auf «Übernehmen» */
export const hasReadyFix = (f: Pick<FindingDto, 'id' | 'title' | 'tool'>, fixes: readonly FixRequestDto[]) =>
  fixesFor(f, fixes).some((x) => x.status === 'proposed')

/* --- Lage in einem Satz ---------------------------------------------------------- */

export interface Impact {
  /** Was zu tun ist, z.B. «Basis-Image aktualisieren» */
  label: string
  /** Punkte, um die der Score stiege */
  points: number
  ids: string[]
}

/** Gruppe für «Am meisten bringt»: was mit einer Handlung behoben ist */
function impactGroup(f: FindingDto): { key: string; label: string } {
  if (f.tool === 'trivy' && /Basis-Image/i.test(f.fix)) return { key: 'base-image', label: 'Basis-Image aktualisieren' }
  const h = headerFixFor(f)
  if (h) return { key: `header:${h}`, label: `${HEADER_LABEL[h]} setzen` }
  return { key: `f:${f.id}`, label: `«${f.title}» beheben` }
}

const scoreOf = (open: readonly Pick<FindingDto, 'severity'>[]) => Math.max(0, 100 - open.reduce((s, f) => s + SCORE_DEDUCTION[f.severity], 0))

/**
 * Die Handlung mit der grössten Wirkung auf den Score. Gleiche Handlungen
 * zusammen (alle Pakete aus dem Basis-Image); gezählt wird, was der Score
 * wirklich gewinnt (nie über 100, nie aus einem Score unter 0).
 */
export function topImpact(open: readonly FindingDto[]): Impact | null {
  const now = scoreOf(open)
  const groups = new Map<string, { label: string; ids: string[]; sev: Sev }>()
  for (const f of open) {
    const g = impactGroup(f)
    const cur = groups.get(g.key)
    if (cur) {
      cur.ids.push(f.id)
      if (SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(cur.sev)) cur.sev = f.severity
    } else groups.set(g.key, { label: g.label, ids: [f.id], sev: f.severity })
  }
  let best: (Impact & { sev: Sev }) | null = null
  for (const g of groups.values()) {
    const points = scoreOf(open.filter((f) => !g.ids.includes(f.id))) - now
    if (points <= 0) continue
    // Bei Gleichstand gewinnt die schwerere Gruppe, dann die frühere (Liste ist nach Schwere sortiert)
    if (!best || points > best.points || (points === best.points && SEVERITIES.indexOf(g.sev) < SEVERITIES.indexOf(best.sev))) best = { label: g.label, ids: g.ids, points, sev: g.sev }
  }
  return best ? { label: best.label, points: best.points, ids: best.ids } : null
}

export interface Situation {
  headline: string
  detail: string | null
  tone: 'bad' | 'warn' | 'ok'
}

/**
 * Lage in einem Satz aus echten Daten: Sperrt etwas «Öffentlich»? Wie viele
 * kritische und hohe Befunde? Was bringt am meisten? Wie viele Vorschläge von
 * Claude warten?
 */
export function situation(open: readonly FindingDto[], fixes: readonly FixRequestDto[]): Situation {
  if (open.length === 0) return { headline: 'Keine offenen Befunde.', detail: null, tone: 'ok' }
  const crit = open.filter((f) => f.severity === 'critical').length
  const high = open.filter((f) => f.severity === 'high').length
  const highText = plural(high, 'hoher Befund', 'hohe Befunde')
  let headline: string
  let tone: Situation['tone']
  if (crit > 0) {
    headline = `${plural(crit, 'kritische Lücke', 'kritische Lücken')}${high ? ` und ${highText}` : ''} – öffentlich machen ist gesperrt.`
    tone = 'bad'
  } else if (high > 0) {
    headline = `${highText} offen – öffentlich machen ist möglich.`
    tone = 'warn'
  } else {
    headline = `${plural(open.length, 'offener Befund', 'offene Befunde')}, keiner kritisch oder hoch.`
    tone = 'ok'
  }
  const parts: string[] = []
  const top = topImpact(open)
  if (top) parts.push(`Am meisten bringt: ${top.label} (+${top.points}).`)
  const ready = open.filter((f) => hasReadyFix(f, fixes)).length
  if (ready) parts.push(`Für ${plural(ready, 'Befund', 'Befunde')} liegt ein Vorschlag von Claude bereit.`)
  return { headline, detail: parts.length ? parts.join(' ') : null, tone }
}

/* --- Zeile der Befundliste --------------------------------------------------------- */

export type HintKind = 'blocks' | 'claude' | 'csp' | 'oneclick' | 'build'

/** Hinweis rechts in der Zeile: der nächste Schritt in zwei, drei Wörtern */
export function findingHint(
  f: FindingDto,
  ctx: { fixes: readonly FixRequestDto[]; rules?: HeaderRulesDto; sourceType?: string },
): { kind: HintKind; label: string } | null {
  if (f.status !== 'open') return null
  if (f.severity === 'critical') return { kind: 'blocks', label: 'blockiert Öffentlich' }
  if (hasReadyFix(f, ctx.fixes)) return { kind: 'claude', label: 'Vorschlag bereit' }
  const h = headerFixFor(f)
  if (h === 'content-security-policy' || isCspQualityFinding(f)) return { kind: 'csp', label: 'Header & CSP' }
  if (h && ctx.rules && !ctx.rules.rules.some((r) => r.header === h) && !(h === 'strict-transport-security' && !ctx.rules.hsts.ok)) {
    return { kind: 'oneclick', label: 'Ein Klick' }
  }
  if (f.tool === 'trivy' && ctx.sourceType && ctx.sourceType !== 'image' && /Basis-Image|neu (zu )?bauen/i.test(f.fix)) return { kind: 'build', label: 'beim nächsten Build' }
  return null
}

/** Woher der Befund kommt, in einem Wort wie die Prüfstufen */
export function sourceOf(f: Pick<FindingDto, 'tool'>, sourceType?: string): string {
  switch (f.tool) {
    case 'trivy': return sourceType === 'image' ? 'Image' : 'Pakete & Code'
    case 'header-check': return 'Header'
    case 'zap': return 'Webseite'
    case 'nuclei': return 'Dateien & Panels'
    case 'testssl': return 'TLS'
    default: return f.tool
  }
}

/** Ort ohne Schema und Host (die Adresse ist für alle gleich); «/» allein entfällt */
export function shortLocation(loc: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/\s]+(\/\S*)?(.*)$/i.exec(loc.trim())
  if (!m) return loc.trim()
  const path = (m[1] ?? '/') + (m[2] ?? '')
  return path === '/' ? '' : path
}

export type SortKey = 'schwere' | 'quelle' | 'alter'
export const SORT_LABEL: Record<SortKey, string> = { schwere: 'Nach Schwere', quelle: 'Nach Quelle', alter: 'Nach Alter' }

const sevIdx = (f: Pick<FindingDto, 'severity'>) => SEVERITIES.indexOf(f.severity)
const firstMs = (f: FindingDto) => (f.firstSeenAt ? Date.parse(f.firstSeenAt) : Number.POSITIVE_INFINITY)

/** Schwere: schwerste zuerst. Quelle: nach Quelle, darin nach Schwere. Alter: am längsten offen zuerst. */
export function sortFindings(list: readonly FindingDto[], by: SortKey, sourceType?: string): FindingDto[] {
  const title = (a: FindingDto, b: FindingDto) => a.title.localeCompare(b.title, 'de')
  return [...list].sort((a, b) => {
    if (by === 'quelle') return sourceOf(a, sourceType).localeCompare(sourceOf(b, sourceType), 'de') || sevIdx(a) - sevIdx(b) || title(a, b)
    if (by === 'alter') return firstMs(a) - firstMs(b) || sevIdx(a) - sevIdx(b) || title(a, b)
    return sevIdx(a) - sevIdx(b) || title(a, b)
  })
}

/** Link «Details ↗» für CVE- und GHSA-Kennungen im Titel oder in der Beschreibung */
export function detailsLink(f: Pick<FindingDto, 'title' | 'description'>): { href: string; label: string } | null {
  const cve = /\bCVE-\d{4}-\d{4,}\b/.exec(`${f.title} ${f.description}`)?.[0]
  if (cve) return { href: `https://nvd.nist.gov/vuln/detail/${cve}`, label: 'CVE-Details' }
  const ghsa = /\bGHSA(?:-[23456789cfghjmpqrvwx]{4}){3}\b/.exec(`${f.title} ${f.description}`)?.[0]
  if (ghsa) return { href: `https://github.com/advisories/${ghsa}`, label: 'Advisory' }
  return null
}

/* --- Header & CSP ----------------------------------------------------------------- */

/** Reihenfolge der Tabelle; die CSP zuletzt (ihr Ablauf steht rechts) */
export const HEADER_ORDER: HeaderKey[] = ['strict-transport-security', 'x-content-type-options', 'frame-ancestors', 'referrer-policy', 'permissions-policy', 'content-security-policy']

export type HeaderStateKind = 'missing' | 'accepted' | 'app' | 'caddy' | 'template' | 'present'

export interface HeaderState {
  key: HeaderKey
  label: string
  state: HeaderStateKind
  /** Wert, wie gesetzt bzw. gesehen */
  value: string | null
  mode: HeaderMode | null
  /** Befund «… fehlt» (offen oder akzeptiert) */
  finding: FindingDto | null
  /** Zusatz in einem Satz (Regel ruht, HTTPS fehlt) */
  note: string | null
}

/**
 * Zustand je Header: Caddy setzt ihn (eigene Regel oder Vorlage der Umgebung),
 * die App setzt ihn (im Scan gesehen), er fehlt (Befund offen bzw. akzeptiert)
 * oder er ist vorhanden (älterer Scan ohne gesehene Werte, kein Befund).
 */
export function headerStates(o: { rules: HeaderRulesDto; observed?: Record<string, string> | null; findings: readonly FindingDto[] }): HeaderState[] {
  return HEADER_ORDER.map((key) => {
    const finding = o.findings.find((f) => f.status !== 'fixed' && headerFixFor(f) === key) ?? null
    const base = { key, label: HEADER_LABEL[key], finding, note: null as string | null }
    const rule = o.rules.rules.find((r) => r.header === key)
    const inherited = o.rules.inherited?.find((r) => r.header === key && !r.disabled)
    const obs = o.observed?.[key] ?? null
    const obsReportOnly = key === 'content-security-policy' ? o.observed?.['content-security-policy-report-only'] ?? null : null
    if (rule) {
      // Caddy ergänzt nur, was die App nicht selbst setzt
      if (obs && obs !== rule.value && rule.mode === 'enforce') {
        return { ...base, state: 'app' as const, value: obs, mode: 'enforce' as const, note: 'Die App setzt den Header selbst; die Regel bei Caddy ruht.' }
      }
      return { ...base, state: 'caddy' as const, value: rule.value, mode: rule.mode }
    }
    if (inherited) return { ...base, state: 'template' as const, value: inherited.value, mode: inherited.mode, note: 'Vorlage der Umgebung' }
    if (obs) return { ...base, state: 'app' as const, value: obs, mode: 'enforce' as const }
    if (obsReportOnly) return { ...base, state: 'app' as const, value: obsReportOnly, mode: 'report-only' as const }
    const hstsNote = key === 'strict-transport-security' && !o.rules.hsts.ok ? o.rules.hsts.reason : null
    if (finding) return { ...base, state: finding.status === 'accepted' ? 'accepted' as const : 'missing' as const, value: null, mode: null, note: hstsNote }
    if (o.observed) return { ...base, state: 'missing' as const, value: null, mode: null, note: hstsNote }
    return { ...base, state: 'present' as const, value: null, mode: null }
  })
}

/** Fehlende Header, die sich ohne Rückfrage setzen lassen (nicht HSTS, nicht CSP) */
export const settableInOne = (states: readonly HeaderState[]): HeaderKey[] =>
  states.filter((s) => s.state === 'missing' && s.key !== 'content-security-policy' && s.key !== 'strict-transport-security').map((s) => s.key)

const KIND: Record<string, [one: string, inline: string]> = {
  'script-src': ['Skript', 'Inline-Skript'],
  'style-src': ['Style', 'Inline-Style'],
  'img-src': ['Bild', 'Inline-Bild'],
  'font-src': ['Schrift', 'Inline-Schrift'],
  'connect-src': ['Verbindung', 'Verbindung'],
  'frame-src': ['Frame', 'Frame'],
  'media-src': ['Medien', 'Medien'],
  'worker-src': ['Worker', 'Inline-Worker'],
  'object-src': ['Objekt', 'Objekt'],
  'form-action': ['Formular', 'Formular'],
}

export interface BlockRow {
  /** Satz ohne den Ort, z.B. «Inline-Skript auf» oder «Skript von» */
  text: string
  /** Ort oder Quelle, als Code gesetzt */
  code: string | null
  /** Gemeldete Aufrufe; null = nur aus der Seitenanalyse */
  count: number | null
}

const hostOf = (u: string) => { try { return new URL(u).host } catch { return u } }

/**
 * «Würde blockieren»: gemeldete Verstösse zusammengefasst (gleiche Art und
 * Quelle), dazu Konflikte aus der Seitenanalyse, die keine Meldung schon
 * abdeckt. Meiste Aufrufe zuerst.
 */
export function wouldBlock(violations: readonly CspViolationDto[], analysis: CspAnalysisDto | null): BlockRow[] {
  const rows = new Map<string, BlockRow>()
  const covered: string[] = []
  for (const v of violations) {
    const dir = v.directive.replace(/-(elem|attr)$/, '')
    const [one, inline] = KIND[dir] ?? [dir, `Inline (${dir})`]
    let text: string
    let code: string | null
    if (v.blocked === 'inline') { text = `${inline} auf`; code = v.samplePath ?? '/'; covered.push(inline) }
    else if (v.blocked === 'eval') { text = 'eval() in Skript auf'; code = v.samplePath ?? '/'; covered.push('eval') }
    else if (v.blocked === 'self') { text = `${one} von der eigenen Adresse`; code = null }
    else if (/^(data|blob):?$/.test(v.blocked)) { text = `${one} aus`; code = `${v.blocked.replace(/:$/, '')}:` }
    else { text = `${one} von`; code = hostOf(v.blocked); covered.push(v.blocked, code) }
    const key = `${text}\0${code}`
    const cur = rows.get(key)
    if (cur) cur.count = (cur.count ?? 0) + v.count
    else rows.set(key, { text, code, count: v.count })
  }
  const out = [...rows.values()].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
  for (const c of analysis?.error ? [] : analysis?.conflicts ?? []) {
    if (covered.some((k) => c.includes(k))) continue
    out.push({ text: c, code: null, count: null })
  }
  return out
}

/* --- Prüfstufen als Chips --------------------------------------------------------- */

const SHORT: Record<string, string> = {
  'trivy-image': 'Image', 'trivy-source': 'Eigener Code', headers: 'Header',
  'zap-baseline': 'Webseite', 'zap-full': 'Webseite aktiv', nuclei: 'Dateien & Panels', testssl: 'TLS',
}
const TOOL_OF: Record<string, string> = { 'trivy-image': 'trivy', 'trivy-source': 'trivy', headers: 'header-check', 'zap-baseline': 'zap', 'zap-full': 'zap', nuclei: 'nuclei', testssl: 'testssl' }
const ORDER = ['trivy-image', 'trivy-source', 'headers', 'zap-baseline', 'zap-full', 'nuclei', 'testssl']

export type ChipState = 'bad' | 'warn' | 'ok' | 'skip' | 'running' | 'waiting' | 'failed'
export const CHIP_STATE_LABEL: Record<ChipState, string> = {
  bad: 'kritische oder hohe Befunde', warn: 'Befunde', ok: 'ohne offene Befunde', skip: 'übersprungen',
  running: 'läuft', waiting: 'wartet', failed: 'gescheitert',
}

export interface StageChip {
  /** Grundstufe (mehrere Images zusammen) */
  key: string
  label: string
  state: ChipState
  /** Offene Befunde */
  count: number
}

const stateOf = (v: ScanStageDto) => v.state ?? (v.ran ? 'done' : v.failed ? 'failed' : 'skipped')

/**
 * Eine Chip je Grundstufe. Trivy liefert für Image und eigenen Code dasselbe
 * Werkzeug: laufen beide, zählt je Stufe höchstens, was sie selbst fand.
 */
export function stageChips(stages: Record<string, ScanStageDto>, open: readonly FindingDto[]): StageChip[] {
  const byBase = new Map<string, ScanStageDto[]>()
  for (const [k, v] of Object.entries(stages)) {
    const base = k.split(' ')[0]!
    byBase.set(base, [...(byBase.get(base) ?? []), v])
  }
  const trivyRan = ['trivy-image', 'trivy-source'].filter((k) => byBase.get(k)?.some((v) => stateOf(v) === 'done')).length
  return [...byBase.entries()]
    .sort(([a], [b]) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99))
    .map(([key, vs]) => {
      const states = vs.map(stateOf)
      const tool = TOOL_OF[key] ?? key
      const mine = open.filter((f) => f.tool === tool)
      const found = vs.reduce((s, v) => s + (v.findings ?? 0), 0)
      const count = tool === 'trivy' && trivyRan > 1 ? Math.min(found, mine.length) : mine.length
      const worst = mine.reduce<Sev | null>((w, f) => (!w || SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(w) ? f.severity : w), null)
      let state: ChipState
      if (states.some((s) => s === 'running')) state = 'running'
      else if (states.some((s) => s === 'failed' || s === 'timeout')) state = 'failed'
      else if (states.some((s) => s === 'waiting')) state = 'waiting'
      else if (states.every((s) => s === 'skipped' || s === 'cancelled')) state = 'skip'
      else if (count > 0) state = worst === 'critical' || worst === 'high' ? 'bad' : 'warn'
      else state = 'ok'
      return { key, label: SHORT[key] ?? key, state, count: state === 'bad' || state === 'warn' ? count : 0 }
    })
}

/* --- Verlauf ---------------------------------------------------------------------- */

/** Punkte für die kleine Kurve: älteste links; nur Scans mit Score */
export function sparkPoints(scores: readonly (number | null)[], w: number, h: number, pad = 4): { x: number; y: number; v: number }[] {
  const vals = scores.filter((s): s is number => s !== null)
  if (vals.length === 0) return []
  const step = vals.length > 1 ? (w - 2 * pad) / (vals.length - 1) : 0
  return vals.map((v, i) => ({ x: Math.round((pad + i * step) * 10) / 10, y: Math.round((pad + (1 - v / 100) * (h - 2 * pad)) * 10) / 10, v }))
}
