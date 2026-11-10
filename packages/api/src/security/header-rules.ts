import type { HeaderKey, HeaderMode } from '@deployer/shared'

/**
 * M8, Etappe 1: Security-Header über Caddy. Reine Funktionen – ohne
 * Datenbank und ohne config.ts, damit sie sich ohne Umgebung testen lassen.
 *
 * Grundsatz: Caddy ERGÄNZT nur. Jeder Header bekommt einen eigenen
 * headers-Handler mit `require` (Header fehlt in der Antwort) und `deferred`
 * – das entspricht `header ?Name Wert` im Caddyfile. Setzt die App den
 * Header selbst, bleibt ihr Wert (geprüft gegen echtes Caddy,
 * scripts/caddy-headers-e2e.ts).
 */

export interface HeaderRuleSpec {
  header: HeaderKey
  value: string
  mode: HeaderMode
}

export interface HeaderBuildContext {
  /** Route auf :443 (bzw. ihr Abbild im Probe-Server) */
  secure: boolean
  /** HSTS erlaubt: Wildcard-Zertifikat mit Produktions-CA */
  hstsAllowed: boolean
  /** Ziel für CSP-Meldungen (absolute URL); fehlt: keine report-uri */
  reportUri?: string | null
}

type Handler = Record<string, unknown> & { handler: string }

/** Header nur setzen, wenn die Antwort ihn nicht schon hat. */
export const addIfMissing = (name: string, value: string): Handler => ({
  handler: 'headers',
  response: { set: { [name]: [value] }, require: { headers: { [name]: null } }, deferred: true },
})

const withReport = (policy: string, uri: string | null | undefined) => (uri ? `${policy}; report-uri ${uri}` : policy)

/** X-Frame-Options kennt nur DENY und SAMEORIGIN; fremde Herkunft geht nur über CSP. */
export function xfoFor(frameAncestors: string): string | null {
  const v = frameAncestors.trim()
  if (v === "'none'") return 'DENY'
  if (v === "'self'") return 'SAMEORIGIN'
  return null
}

const hasDirective = (policy: string, d: string) => policy.split(';').some((p) => p.trim().toLowerCase().startsWith(`${d} `) || p.trim().toLowerCase() === d)

/**
 * Caddy-Handler für die Regeln eines Projekts, in fester Reihenfolge.
 * HSTS nur auf HTTPS-Routen und nur, wenn TLS stabil läuft.
 */
export function headerHandlers(rules: HeaderRuleSpec[], ctx: HeaderBuildContext): Handler[] {
  const by = new Map(rules.map((r) => [r.header, r]))
  const out: Handler[] = []

  const xcto = by.get('x-content-type-options')
  if (xcto) out.push(addIfMissing('X-Content-Type-Options', xcto.value))

  const ref = by.get('referrer-policy')
  if (ref) out.push(addIfMissing('Referrer-Policy', ref.value))

  const fa = by.get('frame-ancestors')
  const csp = by.get('content-security-policy')
  // Eine scharfe CSP nimmt frame-ancestors auf; sonst eine eigene, kleine CSP.
  if (csp && csp.mode === 'enforce') {
    const policy = fa && !hasDirective(csp.value, 'frame-ancestors') ? `${csp.value}; frame-ancestors ${fa.value}` : csp.value
    out.push(addIfMissing('Content-Security-Policy', withReport(policy, ctx.reportUri)))
  } else if (fa) {
    out.push(addIfMissing('Content-Security-Policy', `frame-ancestors ${fa.value}`))
  }
  if (fa) {
    // Setzt die App eine eigene CSP ohne frame-ancestors, schliesst X-Frame-Options die Lücke.
    const xfo = xfoFor(fa.value)
    if (xfo) out.push(addIfMissing('X-Frame-Options', xfo))
  }
  if (csp && csp.mode === 'report-only') {
    out.push(addIfMissing('Content-Security-Policy-Report-Only', withReport(csp.value, ctx.reportUri)))
  }

  const hsts = by.get('strict-transport-security')
  if (hsts && ctx.secure && ctx.hstsAllowed) out.push(addIfMissing('Strict-Transport-Security', hsts.value))

  return out
}

/* --- CSP-Meldungen ------------------------------------------------------------- */

export interface CspViolation {
  directive: string
  /** 'inline', 'eval', 'data:', 'blob:', 'self' oder eine Herkunft (https://cdn.example) */
  blocked: string
  /** Pfad der Seite, ohne Parameter (keine Personendaten aus der Query) */
  path: string | null
}

/** Effektive Direktive auf die Grundform: script-src-elem -> script-src. */
export function baseDirective(d: string): string {
  const v = d.trim().toLowerCase().split(/\s+/)[0] ?? ''
  return v.replace(/-(elem|attr)$/, '')
}

const KEYWORDS: Record<string, string> = { inline: 'inline', eval: 'eval', 'wasm-eval': 'eval', data: 'data:', blob: 'blob:', self: 'self' }

/** Blockierte Quelle -> Herkunft oder Schlüsselwort; null, wenn unbrauchbar. */
export function normalizeBlocked(blocked: string | undefined, documentUrl: string | undefined): string | null {
  const b = (blocked ?? '').trim()
  if (!b) return 'inline'
  if (KEYWORDS[b]) return KEYWORDS[b]!
  if (/^(data|blob|mediastream|filesystem):/i.test(b)) return `${b.split(':')[0]!.toLowerCase()}:`
  let u: URL
  try {
    u = new URL(b)
  } catch {
    return null
  }
  if (!/^(https?|wss?):$/.test(u.protocol)) return null
  try {
    if (documentUrl && new URL(documentUrl).origin === u.origin) return 'self'
  } catch {
    /* Seite unbekannt */
  }
  return u.origin
}

const pathOf = (doc: string | undefined) => {
  try {
    return doc ? new URL(doc).pathname.slice(0, 200) : null
  } catch {
    return null
  }
}

/**
 * Body eines Report-Endpunkts lesen. Zwei Formate: `report-uri`
 * (application/csp-report, ein Objekt) und die Reporting-API
 * (application/reports+json, eine Liste). Unbekanntes wird ignoriert.
 */
export function parseCspReports(body: unknown): CspViolation[] {
  const out: CspViolation[] = []
  const push = (directive: unknown, blocked: unknown, doc: unknown) => {
    if (typeof directive !== 'string' || !directive) return
    const b = normalizeBlocked(typeof blocked === 'string' ? blocked : undefined, typeof doc === 'string' ? doc : undefined)
    if (!b) return
    out.push({ directive: baseDirective(directive), blocked: b, path: pathOf(typeof doc === 'string' ? doc : undefined) })
  }
  if (Array.isArray(body)) {
    for (const r of body.slice(0, 100)) {
      const x = r as { type?: string; body?: Record<string, unknown>; url?: string }
      if (x?.type !== 'csp-violation' || !x.body) continue
      push(x.body.effectiveDirective ?? x.body.violatedDirective, x.body.blockedURL, x.body.documentURL ?? x.url)
    }
  } else if (body && typeof body === 'object') {
    const r = (body as Record<string, Record<string, unknown>>)['csp-report']
    if (r) push(r['effective-directive'] ?? r['violated-directive'], r['blocked-uri'], r['document-uri'])
  }
  return out.filter((v) => /^[a-z-]{3,40}$/.test(v.directive) && v.blocked.length <= 300)
}

/* --- Vorschlag ----------------------------------------------------------------- */

/** Reihenfolge der Direktiven in der vorgeschlagenen Regel */
const ORDER = ['default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'connect-src', 'media-src', 'frame-src', 'worker-src', 'manifest-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors']
/** Direktiven, die nicht auf default-src zurückfallen */
const NO_FALLBACK = new Set(['base-uri', 'form-action', 'frame-ancestors'])

export function parsePolicy(policy: string): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const part of policy.split(';')) {
    const [d, ...src] = part.trim().split(/\s+/)
    if (!d) continue
    const key = d.toLowerCase()
    if (key === 'report-uri' || key === 'report-to') continue
    if (!m.has(key)) m.set(key, src)
  }
  return m
}

export function formatPolicy(m: Map<string, string[]>): string {
  const keys = [...m.keys()].sort((a, b) => {
    const ia = ORDER.indexOf(a)
    const ib = ORDER.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
  })
  return keys.map((k) => [k, ...(m.get(k) ?? [])].join(' ')).join('; ')
}

const quoted = (b: string) => (b === 'self' ? "'self'" : b)

/**
 * Vorschlag aus den gesammelten Meldungen: die Ausgangsregel, ergänzt um die
 * blockierten Quellen je Direktive. Inline-Code und eval werden NICHT erlaubt
 * ('unsafe-inline' hebelt den XSS-Schutz aus), sondern als Hinweis gemeldet.
 */
export function suggestCsp(base: string, violations: { directive: string; blocked: string }[]): { policy: string; notes: string[] } {
  const m = parsePolicy(base)
  const notes = new Set<string>()
  const fallback = m.get('default-src') ?? []
  for (const v of violations) {
    const d = v.directive
    if (d === 'default-src' || d === 'report-uri' || d === 'report-to') continue
    if (v.blocked === 'inline') {
      notes.add(`Inline-Code in ${d}: in eine Datei auslagern oder per Hash/Nonce erlauben – 'unsafe-inline' schlägt deployer nicht vor.`)
      continue
    }
    if (v.blocked === 'eval') {
      notes.add(`eval() bzw. new Function in ${d}: Code ohne eval schreiben – 'unsafe-eval' schlägt deployer nicht vor.`)
      continue
    }
    if (!m.has(d)) m.set(d, NO_FALLBACK.has(d) ? [] : [...fallback.filter((s) => s !== "'none'")])
    const list = m.get(d)!
    const src = quoted(v.blocked)
    if (list.includes("'none'")) list.splice(list.indexOf("'none'"), 1)
    if (!list.includes(src)) list.push(src)
  }
  return { policy: formatPolicy(m), notes: [...notes].sort() }
}
