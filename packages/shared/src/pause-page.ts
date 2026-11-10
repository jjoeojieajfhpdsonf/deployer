import { z } from 'zod'

/**
 * Pause-Seite («Vorübergehend nicht erreichbar») für pausierte öffentliche
 * Projekte. Ein Renderer für Server (Caddy liefert die Seite aus) und
 * Oberfläche (Live-Vorschau) – beide zeigen genau dasselbe.
 *
 * Sicherheit: Der Text ist einfaches Markdown (Absätze, **fett**, Links),
 * kein HTML. Alles wird escaped, bevor die wenigen Auszeichnungen
 * eingesetzt werden; Links nur https bzw. mailto. Geschweifte Klammern
 * werden als Entität ausgegeben: Caddy ersetzt in static_response-Bodies
 * Platzhalter wie {http.request.remote.host}. Die Seite läuft mit
 * CSP default-src 'none'; style-src 'unsafe-inline' – kein Script, kein Bild,
 * keine Schrift von aussen.
 */

// shared hat weder DOM- noch Node-Typen; URL gibt es zur Laufzeit in beiden.
declare const URL: new (s: string) => { protocol: string; hostname: string; href: string; pathname: string }

export const pauseLangs = ['de', 'en'] as const
export type PauseLang = (typeof pauseLangs)[number]

const httpsUrl = z.string().trim().max(500)
  .refine((v) => { try { const u = new URL(v); return u.protocol === 'https:' && Boolean(u.hostname) } catch { return false } }, 'Nur https-Adressen, z. B. https://status.example.ch')

/** Vorlage bzw. Überschreibung pro Projekt (ohne «Voraussichtlich zurück»). */
export const pausePageSchema = z.object({
  lang: z.enum(pauseLangs).default('de'),
  title: z.string().trim().min(1, 'Titel fehlt').max(120, 'Höchstens 120 Zeichen'),
  message: z.string().trim().min(1, 'Text fehlt').max(2000, 'Höchstens 2000 Zeichen'),
  linkText: z.string().trim().max(80, 'Höchstens 80 Zeichen').optional().or(z.literal('')),
  linkUrl: httpsUrl.optional().or(z.literal('')),
  contact: z.string().trim().max(200).email('Keine gültige E-Mail-Adresse').optional().or(z.literal('')),
}).superRefine((v, ctx) => {
  if (v.linkText && !v.linkUrl) ctx.addIssue({ code: 'custom', path: ['linkUrl'], message: 'Zum Linktext fehlt die Adresse' })
  if (v.linkUrl && !v.linkText) ctx.addIssue({ code: 'custom', path: ['linkText'], message: 'Zur Adresse fehlt der Linktext' })
})
export type PausePage = z.infer<typeof pausePageSchema>

/** Beim Pausieren: Überschreibung (null = wie Vorlage) und «Voraussichtlich zurück». */
export const pauseOptionsSchema = z.object({
  page: pausePageSchema.nullable().optional(),
  backAt: z.string().datetime({ offset: true, message: 'Datum und Uhrzeit nicht lesbar' }).nullable().optional(),
})
export type PauseOptions = z.infer<typeof pauseOptionsSchema>

export const DEFAULT_PAUSE_PAGE: PausePage = {
  lang: 'de',
  title: 'Vorübergehend nicht erreichbar',
  message: 'Diese Seite ist gerade pausiert. Bitte später noch einmal versuchen.',
  linkText: '',
  linkUrl: '',
  contact: '',
}

/** Kennung der Wartungsseite; die Prüfung von aussen erkennt daran «pausiert». */
export const PAUSE_STATE_HEADER = 'X-Deployer-State'
export const PAUSE_STATE_VALUE = 'paused'
export const PAUSE_CSP = "default-src 'none'; style-src 'unsafe-inline'"

/* --- Escaping und Markdown ---------------------------------------------------------- */

/** HTML-Escaping inklusive geschweifter Klammern (Caddy-Platzhalter). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
}

const safeHref = (raw: string): string | null => {
  try {
    const u = new URL(raw)
    if (u.protocol === 'https:' && u.hostname) return u.href
    if (u.protocol === 'mailto:' && /^[^@\s]+@[^@\s]+$/.test(u.pathname)) return u.href
  } catch { /* ungültig */ }
  return null
}

/** Eine Zeile: **fett** und [Text](https://…); alles andere bleibt Text. */
function inline(line: string): string {
  // Links zuerst aus dem Rohtext lösen, damit ihre Adresse nicht escaped-zerstückelt wird
  const out: string[] = []
  const re = /\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    out.push(bold(escapeHtml(line.slice(last, m.index))))
    const href = safeHref(m[2]!)
    out.push(href ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${bold(escapeHtml(m[1]!))}</a>` : bold(escapeHtml(m[0])))
    last = m.index + m[0].length
  }
  out.push(bold(escapeHtml(line.slice(last))))
  return out.join('')
}

/** **fett** auf bereits escaptem Text (Sterne sind kein HTML-Sonderzeichen). */
const bold = (escaped: string) => escaped.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')

/** Absätze (Leerzeile), Zeilenumbrüche, **fett**, Links – sonst nichts. */
export function renderMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.split('\n').map(inline).join('<br>')}</p>`)
    .join('\n')
}

/* --- Seite und Header ----------------------------------------------------------------- */

const T = {
  de: { back: 'Voraussichtlich zurück', contact: 'Kontakt', locale: 'de-CH' },
  en: { back: 'Expected back', contact: 'Contact', locale: 'en-GB' },
} as const

/** «Di., 11. Nov. 2026, 08:00» in der Zeitzone des Servers bzw. Browsers. */
export function formatBackAt(iso: string, lang: PauseLang, timeZone?: string): string {
  return new Date(iso).toLocaleString(T[lang].locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) })
}

const COLORS = {
  light: '--bg:#fafafa;--fg:#111;--muted:#555;--link:#0b57d0;--line:#e3e3e3',
  dark: '--bg:#111;--fg:#eee;--muted:#aaa;--link:#8ab4f8;--line:#2a2a2a',
}

/**
 * Die ganze Seite. theme: nur für die Vorschau (fest hell/dunkel); ohne
 * folgt sie prefers-color-scheme.
 */
export function renderPausePage(page: PausePage, o: { backAt?: string | null; theme?: 'light' | 'dark'; timeZone?: string } = {}): string {
  const lang: PauseLang = page.lang ?? 'de'
  const t = T[lang]
  const colors = o.theme
    ? `:root{color-scheme:${o.theme};${COLORS[o.theme]}}`
    : `:root{color-scheme:light dark;${COLORS.light}}\n@media (prefers-color-scheme:dark){:root{${COLORS.dark}}}`
  const extra: string[] = []
  if (o.backAt) extra.push(`<p class="meta">${escapeHtml(t.back)}: <time datetime="${escapeHtml(new Date(o.backAt).toISOString())}">${escapeHtml(formatBackAt(o.backAt, lang, o.timeZone))}</time></p>`)
  if (page.linkText && page.linkUrl) {
    const href = safeHref(page.linkUrl)
    if (href) extra.push(`<p class="meta"><a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(page.linkText)}</a></p>`)
  }
  if (page.contact) {
    const mail = safeHref(`mailto:${page.contact}`)
    if (mail) extra.push(`<p class="meta">${escapeHtml(t.contact)}: <a href="${escapeHtml(mail)}">${escapeHtml(page.contact)}</a></p>`)
  }
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(page.title)}</title>
<style>
${colors}
html,body{height:100%;margin:0}
body{display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;padding:0 16px}
main{max-width:32rem}
h1{font-size:1.375rem;font-weight:600;margin:0 0 .5rem;letter-spacing:-.01em}
p{margin:0 0 .75rem;color:var(--muted)}
p:last-child{margin-bottom:0}
strong{color:var(--fg);font-weight:600}
a{color:var(--link)}
.meta{font-size:.9375rem;padding-top:.75rem;border-top:1px solid var(--line)}
.meta+.meta{border-top:0;padding-top:0}
</style></head>
<body><main><h1>${escapeHtml(page.title)}</h1>
${renderMarkdown(page.message)}
${extra.join('\n')}
</main></body></html>
`
}

/**
 * Antwort-Header der Pause-Seite. Retry-After als HTTP-Datum (nicht in
 * Sekunden): die Caddy-Konfiguration wird einmal gebaut, ein Sekundenwert
 * veraltete. Nur gesetzt, wenn «Voraussichtlich zurück» in der Zukunft liegt.
 */
export function pauseHeaders(backAt?: string | null, now = Date.now()): Record<string, string[]> {
  const h: Record<string, string[]> = {
    'Content-Type': ['text/html; charset=utf-8'],
    'Cache-Control': ['no-store'],
    'X-Robots-Tag': ['noindex'],
    'Content-Security-Policy': [PAUSE_CSP],
    [PAUSE_STATE_HEADER]: [PAUSE_STATE_VALUE],
  }
  if (backAt && new Date(backAt).getTime() > now) h['Retry-After'] = [new Date(backAt).toUTCString()]
  return h
}

/** Was tatsächlich ausgeliefert wird: Überschreibung, sonst Vorlage. */
export function effectivePausePage(template: PausePage | null | undefined, override: PausePage | null | undefined): PausePage {
  return override ?? template ?? DEFAULT_PAUSE_PAGE
}
