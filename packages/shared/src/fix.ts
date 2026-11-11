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
  // Antwort 7: vorher nur von ZAP gemeldet (10063), jetzt im Header-Check mit «Header setzen»
  'permissions-policy',
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
  'permissions-policy': 'Permissions-Policy',
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
  // Was eine gewöhnliche Seite nicht braucht, abschalten; Apps, die es brauchen, passen den Wert an
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
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
  if (f.title.startsWith('Permissions-Policy fehlt')) return 'permissions-policy'
  return null
}

/**
 * Antwort 7: Befund von ZAP zur Qualität einer vorhandenen CSP (Regel 10055,
 * Titel «CSP: Wildcard Directive», «CSP: script-src unsafe-inline» …; ältere
 * ZAP-Versionen «CSP Scanner: …»). Bleibt ein ZAP-Befund; die Aktion führt
 * zum CSP-Ablauf (Report-Only, Vorschlag aus den Meldungen). Die fehlende
 * CSP (10038) meldet der eigene Header-Check, nicht ZAP.
 */
export function isCspQualityFinding(f: { tool: string; title: string }): boolean {
  return f.tool === 'zap' && /^CSP(?: Scanner)?\s*:/i.test(f.title.trim())
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
      if (/report-uri|report-to/i.test(value)) return 'report-uri setzt Airlock selbst'
      return /^[a-z-]+\s/.test(value) || /^[a-z-]+$/.test(value) ? null : "Regel wie default-src 'self'"
    case 'strict-transport-security': {
      if (mode !== 'enforce') return 'HSTS kennt keinen Report-Only-Modus'
      const m = /^max-age=(\d+)(;\s*includeSubDomains)?(;\s*preload)?$/i.exec(value)
      if (!m) return 'Form: max-age=<Sekunden>, optional ; includeSubDomains'
      if (/preload/i.test(value)) return 'preload setzt Airlock nicht: das lässt sich kaum rückgängig machen'
      return null
    }
    case 'permissions-policy':
      if (mode !== 'enforce') return 'Permissions-Policy kennt keinen Report-Only-Modus'
      // Liste aus «funktion=(…)», durch Komma getrennt: camera=(), geolocation=(self)
      return /^[a-z-]+=\([^()]*\)(\s*,\s*[a-z-]+=\([^()]*\))*$/i.test(value) ? null : 'Form: camera=(), geolocation=(self)'
  }
}

export interface HeaderRuleDto {
  header: HeaderKey
  value: string
  mode: HeaderMode
  createdAt: string
  updatedAt: string
  /** Nur CSP: seit wann Report-Only läuft (für «Aufrufe ohne Verstoss») */
  reportOnlySince?: string | null
  /** Nur CSP: Funktionsprüfung nach dem Scharfschalten */
  check?: CspCheckDto | null
}

/** Funktionsprüfung einer scharfen CSP im Headless-Browser */
export interface CspCheckDto {
  state: 'running' | 'ok' | 'failed' | 'unavailable'
  at: string
  /** Geladene Seiten (Pfade) */
  pages: string[]
  /** Gemeldete Verstösse, z.B. «Inline-Skript (script-src) auf /» */
  violations: string[]
  /** Satz für die Oberfläche */
  message: string
}

/** Was in den ausgelieferten Seiten steht und eine CSP betrifft */
export interface CspAnalysisDto {
  /** Untersuchte Seiten (Pfade) */
  pages: string[]
  inlineScripts: number
  inlineStyles: number
  styleAttributes: number
  eventHandlers: number
  /** Externe Quellen je Direktive, z.B. { 'script-src': ['https://cdn.example'] } */
  external: Record<string, string[]>
  /** Was die vorgeschlagene bzw. aktuelle Regel davon blockieren würde (Sätze) */
  conflicts: string[]
  /** Fehler beim Laden der Seiten (dann keine Aussage) */
  error: string | null
}

/** Darf die CSP scharf geschaltet werden? */
export interface CspEnforceReadinessDto {
  ok: boolean
  /** Warum ja bzw. warum nicht */
  reason: string
  /** Aufrufe seit Report-Only-Beginn und davon ohne Verstoss */
  views: number | null
  viewsNeeded: number
  violationsSince: number
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
  /**
   * M9: Header-Vorlagen der Umgebung, die für dieses Projekt gelten (keine
   * eigene Regel); disabled = für dieses Projekt abgeschaltet.
   */
  inherited?: { header: HeaderKey; value: string; mode: HeaderMode; disabled: boolean }[]
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
    /** Analyse der ausgelieferten Seiten (Inline-Code, externe Quellen); null ohne CSP-Regel */
    analysis: CspAnalysisDto | null
    /** Scharf schalten erlaubt? */
    readiness: CspEnforceReadinessDto | null
    /** Auftrag für Claude, Inline-Code auszulagern (nur bei Konflikten und Chat-/GitHub-Projekten) */
    inlinePrompt: string | null
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
  /** Nachscan folgt später (CSP scharf: erst nach der Funktionsprüfung) */
  pending?: string | null
}

/* ------------------------------------------------------------------ *
 * M8 – Etappe 2: Mit Claude lösen
 * ------------------------------------------------------------------ */

export const fixStatuses = ['proposed', 'applied', 'pr_open', 'merged', 'verified', 'rejected', 'failed'] as const
export type FixStatus = (typeof fixStatuses)[number]

/** Status als Wort (nie nur Farbe) */
export const FIX_STATUS_LABEL: Record<FixStatus, string> = {
  proposed: 'Vorschlag',
  applied: 'übernommen, Nachscan läuft',
  pr_open: 'Pull Request offen',
  merged: 'gemergt, Deploy folgt',
  verified: 'behoben (Nachscan bestätigt)',
  rejected: 'verworfen',
  failed: 'gescheitert',
}

/**
 * Wie ein Befund behoben wird:
 * header – Caddy ergänzt den Header (set_security_header)
 * files – Chat-Projekt: Vorschlag als Diff, nach Bestätigung neue Version
 * github – Repo mit verbundener GitHub App: Pull Request
 * repo – Git-Repo ohne Verbindung: Änderung im Repo selbst
 * image – fertiges Image: nur Hinweis auf eine neuere Version
 * none – nicht über Code lösbar (etwa ein Upload ohne Repo)
 */
export type FixWay = 'header' | 'files' | 'github' | 'repo' | 'image' | 'none'

export interface ImageHintDto {
  image: string
  /** Paket und Version, die den Fehler beheben (aus dem Befund) */
  fixedIn: string | null
  /** Neuere Tags derselben Linie, neueste zuerst */
  candidates: string[]
  /** Warum keine Kandidaten (Registry nicht erreichbar, Tag ohne Version) */
  note: string | null
}

export interface FixHintDto {
  way: FixWay
  /** Fertiger Auftrag zum Kopieren (nicht bei header und image) */
  prompt: string | null
  explanation: string
  image: ImageHintDto | null
}

export interface FixRequestDto {
  id: string
  findingId: string | null
  findingTitle: string
  tool: string
  way: 'mcp' | 'api' | 'github'
  status: FixStatus
  explanation: string
  diff: string
  baseCommit: string | null
  commit: string | null
  branch: string | null
  prUrl: string | null
  note: string | null
  actor: string
  createdAt: string
  updatedAt: string
}

/* ------------------------------------------------------------------ *
 * M8 – Etappe 3: GitHub App
 * ------------------------------------------------------------------ */

export interface GithubStatusDto {
  /** App angelegt (Manifest getauscht) */
  connected: boolean
  app: { name: string; slug: string; htmlUrl: string; owner: string | null; createdAt: string } | null
  installed: boolean
  repos: string[]
  /** Link zum Installieren bzw. Ändern der Repo-Auswahl */
  installUrl: string | null
  /** Rechte, die die App verlangt */
  permissions: Record<string, string>
  /** Vorschlag für den Namen der App (global eindeutig bei GitHub) */
  suggestedName: string
  /** Wohin GitHub nach dem Anlegen zurückleitet */
  callbackUrl: string
}

export const githubManifestRequestSchema = z.object({
  name: z.string().trim().min(3, 'Mindestens 3 Zeichen').max(34, 'GitHub erlaubt höchstens 34 Zeichen').regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, 'Buchstaben, Ziffern, Leerzeichen, Punkt, Bindestrich'),
  org: z.string().trim().max(39).regex(/^$|^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, 'Name der Organisation wie auf GitHub').optional(),
})

/**
 * Auftrag für Claude: kurz, mit allem, was Claude zum Finden braucht, und
 * mit der Regel, nichts ohne Zustimmung einzuspielen.
 */
export function fixPrompt(o: { projectName: string; slug: string; findingId: string; title: string; severity: string; way: FixWay }): string {
  const how =
    o.way === 'files'
      ? 'Schlage die Änderung mit propose_fix vor (nicht mit update_files); ich prüfe den Diff in Airlock und übernehme ihn dort.'
      : o.way === 'github'
        ? 'Schlage die Änderung mit propose_fix vor; Airlock öffnet dafür einen Pull Request auf einem eigenen Branch.'
        : 'Das Projekt kommt aus einem Git-Repo: Ändere es im Repo auf einem eigenen Branch, nie direkt auf dem Standard-Branch.'
  const sev: Record<string, string> = { critical: 'kritisch', high: 'hoch', medium: 'mittel', low: 'niedrig' }
  return [
    `Behebe den Befund «${o.title}» (Schwere ${sev[o.severity] ?? o.severity}) im Airlock-Projekt «${o.projectName}» (${o.slug}).`,
    `Hole dir zuerst Befund, Erklärung und betroffene Dateien mit dem Airlock-MCP: get_fix_context mit project "${o.slug}" und finding "${o.findingId}".`,
    how,
    'Erkläre kurz, was die Änderung behebt und was sie sonst beeinflussen könnte.',
  ].join('\n')
}
