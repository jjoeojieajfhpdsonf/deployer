import { z } from 'zod'

/* ------------------------------------------------------------------ *
 * M8 – Fix-Assistent: Header über Caddy
 * ------------------------------------------------------------------ */

/** Header, die Caddy ergänzen kann (Schlüssel in Kleinbuchstaben). */
export const headerKeys = [
  'x-content-type-options',
  'referrer-policy',
  'frame-ancestors',
  'content-security-policy',
  'strict-transport-security',
] as const
export type HeaderKey = (typeof headerKeys)[number]

export const headerModes = ['report-only', 'enforce'] as const
export type HeaderMode = (typeof headerModes)[number]

/** Anzeigename je Schlüssel */
export const HEADER_LABEL: Record<HeaderKey, string> = {
  'x-content-type-options': 'X-Content-Type-Options',
  'referrer-policy': 'Referrer-Policy',
  'frame-ancestors': 'frame-ancestors',
  'content-security-policy': 'Content-Security-Policy',
  'strict-transport-security': 'Strict-Transport-Security',
}

/** Ausgangswert je Header. */
export const HEADER_DEFAULT: Record<HeaderKey, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'frame-ancestors': "'self'",
  // Ausgangsregel für Report-Only: streng, die Meldungen zeigen, was fehlt.
  'content-security-policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'",
  // Kurz zum Start (5 Minuten): kippt TLS doch, erinnern sich Browser nicht lange.
  'strict-transport-security': 'max-age=300',
}

/** Header, die nur mit Rückfrage bzw. Bestätigungs-Token scharf werden. */
export const needsConfirmation = (header: HeaderKey, mode: HeaderMode): boolean =>
  mode === 'enforce' && (header === 'content-security-policy' || header === 'strict-transport-security')

/**
 * Welcher Header behebt diesen Befund des Header-Checks? Zuordnung über den
 * Titel (security/headers.ts) – ein eigener Schlüssel am Befund hätte die
 * Fingerabdrücke und damit bestehende Akzeptanzen verändert.
 */
export function headerFixFor(f: { tool: string; title: string }): HeaderKey | null {
  if (f.tool !== 'header-check') return null
  if (f.title.startsWith('Content-Security-Policy fehlt')) return 'content-security-policy'
  if (f.title.startsWith('Schutz gegen Einbetten fehlt')) return 'frame-ancestors'
  if (f.title.startsWith('X-Content-Type-Options')) return 'x-content-type-options'
  if (f.title.startsWith('Referrer-Policy fehlt')) return 'referrer-policy'
  if (f.title.startsWith('Strict-Transport-Security fehlt')) return 'strict-transport-security'
  return null
}

/** Werte prüfen: keine Zeilenumbrüche (Header-Injection), vernünftige Länge. */
const headerValue = z
  .string()
  .trim()
  .min(1, 'Der Wert darf nicht leer sein')
  .max(4000, 'Höchstens 4000 Zeichen')
  .refine((v) => !/[\r\n\0]/.test(v), 'Keine Zeilenumbrüche im Header-Wert')

export const headerRuleInputSchema = z
  .object({
    value: headerValue.optional(),
    mode: z.enum(headerModes).default('enforce'),
    /** Rückfrage bestätigt (CSP scharf, HSTS) */
    confirm: z.boolean().optional(),
  })

/** Wert passend zum Header prüfen; liefert eine Meldung oder null. */
export function headerValueProblem(header: HeaderKey, value: string, mode: HeaderMode): string | null {
  switch (header) {
    case 'x-content-type-options':
      return value.toLowerCase() === 'nosniff' ? null : 'Einziger gültiger Wert: nosniff'
    case 'referrer-policy':
      return /^(no-referrer|no-referrer-when-downgrade|origin|origin-when-cross-origin|same-origin|strict-origin|strict-origin-when-cross-origin|unsafe-url)$/.test(value)
        ? null
        : 'Unbekannte Referrer-Policy, z.B. strict-origin-when-cross-origin'
    case 'frame-ancestors':
      return /^('none'|'self'|[\w*.:/-]+)( ('self'|[\w*.:/-]+))*$/.test(value) ? null : "Quellen wie 'self' oder https://example.ch"
    case 'content-security-policy':
      if (/report-uri|report-to/i.test(value)) return 'report-uri setzt deployer selbst'
      return /^[a-z-]+\s/.test(value) || /^[a-z-]+$/.test(value) ? null : "Regel wie default-src 'self'"
    case 'strict-transport-security': {
      if (mode !== 'enforce') return 'HSTS kennt keinen Report-Only-Modus'
      const m = /^max-age=(\d+)(;\s*includeSubDomains)?(;\s*preload)?$/i.exec(value)
      if (!m) return 'Form: max-age=<Sekunden>, optional ; includeSubDomains'
      if (/preload/i.test(value)) return 'preload setzt deployer nicht: das lässt sich kaum rückgängig machen'
      return null
    }
  }
}

export interface HeaderRuleDto {
  header: HeaderKey
  value: string
  mode: HeaderMode
  createdAt: string
  updatedAt: string
}

export interface CspViolationDto {
  directive: string
  blocked: string
  samplePath: string | null
  count: number
  lastSeen: string
}

export interface HeaderRulesDto {
  rules: HeaderRuleDto[]
  /** HSTS möglich? Sonst mit Begründung. */
  hsts: { ok: boolean; reason: string | null }
  /** Ob der Header-Check über Caddy gehen kann (Projekt hat eine Route) */
  viaCaddy: boolean
  csp: {
    violations: CspViolationDto[]
    total: number
    /** Vorschlag aus den Meldungen; null ohne Meldungen */
    suggestion: string | null
    /** Hinweise, die der Vorschlag bewusst nicht erlaubt (Inline-Skript, eval) */
    notes: string[]
  }
}

/** Ergebnis des Nachscans der Stufe «headers». */
export interface HeaderRecheckDto {
  ok: boolean
  error: string | null
  fixed: string[]
  opened: string[]
  score: number | null
  grade: 'A' | 'B' | 'C' | 'D' | null
}
