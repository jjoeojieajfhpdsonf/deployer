import type { CspAnalysisDto } from '@airlock/shared'
import { parsePolicy, suggestCsp, formatPolicy } from './header-rules.js'
import { CSP_VIEW_LOGGER } from '../drivers/caddy-config.js'

/**
 * CSP-Fix: Analyse der ausgelieferten Seiten, bevor eine CSP vorgeschlagen
 * oder scharf geschaltet wird. Reine Funktionen – ohne Netz, ohne Datenbank.
 *
 * Anlass: hallo-welt hat ein Inline-<style> und ein Inline-<script>; die
 * vorgeschlagene «default-src 'self'» wurde scharf geschaltet und hat beides
 * blockiert. Das muss vorher auffallen.
 */

export interface PageAnalysis {
  path: string
  inlineScripts: number
  inlineStyles: number
  styleAttributes: number
  eventHandlers: number
  /** Externe Quellen je Direktive (Herkunft, data:, blob:) */
  external: Record<string, string[]>
  /** Weitere Seiten derselben Herkunft (Pfade) */
  links: string[]
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null
}

/** Skript-Typen, die der Browser ausführt (Datenblöcke wie JSON-LD nicht) */
const executable = (type: string | null) => !type || /^(text|application)\/(javascript|ecmascript)$|^module$/i.test(type.trim())

/** Quelle relativ zur Seite: 'self', Herkunft, 'data:' / 'blob:' – oder null (ignorieren) */
function sourceOf(raw: string, page: URL): string | null {
  const v = raw.trim()
  if (!v || v.startsWith('#')) return null
  if (/^data:/i.test(v)) return 'data:'
  if (/^blob:/i.test(v)) return 'blob:'
  if (/^(javascript|mailto|tel):/i.test(v)) return null
  try {
    const u = new URL(v, page)
    if (!/^(https?|wss?):$/.test(u.protocol)) return null
    return u.origin === page.origin ? 'self' : u.origin
  } catch {
    return null
  }
}

/** Eine Seite lesen: Inline-Code, externe Quellen, Links derselben Herkunft. */
export function analyzeHtml(html: string, pageUrl: string): PageAnalysis {
  const page = new URL(pageUrl)
  // Kommentare zählen nicht
  const doc = html.replace(/<!--[\s\S]*?-->/g, '')
  const external: Record<string, Set<string>> = {}
  const add = (directive: string, raw: string | null) => {
    if (raw === null) return
    const s = sourceOf(raw, page)
    if (!s || s === 'self') return
    ;(external[directive] ??= new Set()).add(s)
  }
  let inlineScripts = 0
  let inlineStyles = 0

  for (const m of doc.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const open = `<script ${m[1]}>`
    const src = attr(open, 'src')
    if (!executable(attr(open, 'type'))) continue
    if (src !== null) add('script-src', src)
    else if (m[2]!.trim()) inlineScripts++
  }
  for (const m of doc.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) if (m[1]!.trim()) inlineStyles++

  // Attribute in allen öffnenden Tags (ohne den Inhalt von <script> und <style>)
  const tagsOnly = doc.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (s) => s.slice(0, s.indexOf('>') + 1))
  let styleAttributes = 0
  let eventHandlers = 0
  const links = new Set<string>()
  for (const m of tagsOnly.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const name = m[1]!.toLowerCase()
    const tag = `<${name} ${m[2]}>`
    if (/\sstyle\s*=/i.test(tag)) styleAttributes++
    eventHandlers += [...tag.matchAll(/\son[a-z]+\s*=/gi)].length
    const href = attr(tag, 'href')
    if (href && /^\s*javascript:/i.test(href)) eventHandlers++
    switch (name) {
      case 'img':
        add('img-src', attr(tag, 'src'))
        for (const part of (attr(tag, 'srcset') ?? '').split(',')) add('img-src', part.trim().split(/\s+/)[0] ?? null)
        break
      case 'source': add(/\ssrcset\s*=/i.test(tag) ? 'img-src' : 'media-src', attr(tag, 'src') ?? (attr(tag, 'srcset') ?? '').split(/[\s,]/)[0] ?? null); break
      case 'video': case 'audio': add('media-src', attr(tag, 'src')); break
      case 'iframe': add('frame-src', attr(tag, 'src')); break
      case 'form': add('form-action', attr(tag, 'action')); break
      case 'link': {
        const rel = (attr(tag, 'rel') ?? '').toLowerCase()
        if (/\bstylesheet\b/.test(rel)) add('style-src', href)
        else if (/\bmanifest\b/.test(rel)) add('manifest-src', href)
        else if (/\b(icon|apple-touch-icon)\b/.test(rel)) add('img-src', href)
        break
      }
      case 'a': {
        if (!href) break
        try {
          const u = new URL(href, page)
          const last = u.pathname.split('/').pop() ?? ''
          if (u.origin === page.origin && (!last.includes('.') || /\.html?$/i.test(last))) links.add(u.pathname)
        } catch {
          /* kein Link */
        }
        break
      }
    }
  }
  return {
    path: page.pathname,
    inlineScripts, inlineStyles, styleAttributes, eventHandlers,
    external: Object.fromEntries(Object.entries(external).map(([k, v]) => [k, [...v].sort()])),
    links: [...links].filter((p) => p !== page.pathname).sort(),
  }
}

/** Mehrere Seiten zusammenfassen. */
export function mergeAnalyses(pages: PageAnalysis[]): Omit<CspAnalysisDto, 'conflicts' | 'error'> {
  const external: Record<string, Set<string>> = {}
  for (const p of pages) for (const [d, list] of Object.entries(p.external)) for (const s of list) (external[d] ??= new Set()).add(s)
  const sum = (k: 'inlineScripts' | 'inlineStyles' | 'styleAttributes' | 'eventHandlers') => pages.reduce((n, p) => n + p[k], 0)
  return {
    pages: pages.map((p) => p.path),
    inlineScripts: sum('inlineScripts'),
    inlineStyles: sum('inlineStyles'),
    styleAttributes: sum('styleAttributes'),
    eventHandlers: sum('eventHandlers'),
    external: Object.fromEntries(Object.entries(external).map(([k, v]) => [k, [...v].sort()])),
  }
}

/* --- Konflikte einer Regel mit dem, was die Seiten brauchen ----------------------- */

/** Quellenliste einer Direktive, mit dem Rückfall auf default-src wie im Browser */
function sourcesFor(m: Map<string, string[]>, directive: string): string[] | null {
  const chain: Record<string, string[]> = {
    'script-src-elem': ['script-src-elem', 'script-src', 'default-src'],
    'script-src-attr': ['script-src-attr', 'script-src', 'default-src'],
    'style-src-elem': ['style-src-elem', 'style-src', 'default-src'],
    'style-src-attr': ['style-src-attr', 'style-src', 'default-src'],
    'form-action': ['form-action'],
  }
  for (const d of chain[directive] ?? [directive, 'default-src']) {
    const v = m.get(d)
    if (v) return v.map((s) => s.toLowerCase())
  }
  return null // nicht eingeschränkt
}

const allowsInline = (src: string[] | null) =>
  src === null || (src.includes("'unsafe-inline'") && !src.some((s) => s.startsWith("'nonce-") || s.startsWith("'sha")))

function allowsSource(src: string[] | null, source: string): boolean {
  if (src === null) return true
  if (src.includes("'none'") && src.length === 1) return false
  if (src.includes('*') && !['data:', 'blob:'].includes(source)) return true
  if (src.includes(source.toLowerCase())) return true
  if (source === 'data:' || source === 'blob:') return false
  try {
    const u = new URL(source)
    if (src.includes(u.protocol)) return true
    return src.some((s) => {
      const w = /^(?:(https?|wss?):\/\/)?\*\.(.+)$/.exec(s)
      return Boolean(w && u.hostname.endsWith(`.${w[2]}`) && (!w[1] || `${w[1]}:` === u.protocol))
    })
  } catch {
    return false
  }
}

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`

/** Was eine Regel von den Seiten blockieren würde, als Sätze. */
export function conflictsFor(policy: string, a: Omit<CspAnalysisDto, 'conflicts' | 'error'>): string[] {
  const m = parsePolicy(policy)
  const out: string[] = []
  if (a.inlineScripts && !allowsInline(sourcesFor(m, 'script-src-elem'))) out.push(`${n(a.inlineScripts, 'Inline-Skript', 'Inline-Skripte')} (<script> ohne src)`)
  if (a.inlineStyles && !allowsInline(sourcesFor(m, 'style-src-elem'))) out.push(`${n(a.inlineStyles, 'Inline-Style', 'Inline-Styles')} (<style>)`)
  if (a.styleAttributes && !allowsInline(sourcesFor(m, 'style-src-attr'))) out.push(`${n(a.styleAttributes, 'style-Attribut', 'style-Attribute')}`)
  if (a.eventHandlers && !allowsInline(sourcesFor(m, 'script-src-attr'))) out.push(`${n(a.eventHandlers, 'Ereignis-Attribut', 'Ereignis-Attribute')} (onclick= …, javascript:)`)
  for (const [d, list] of Object.entries(a.external)) {
    const directive = d === 'script-src' ? 'script-src-elem' : d === 'style-src' ? 'style-src-elem' : d
    const blocked = list.filter((s) => !allowsSource(sourcesFor(m, directive), s))
    if (blocked.length) out.push(`${d}: ${blocked.join(', ')}`)
  }
  return out
}

/** Kurzer Warnsatz, z.B. «Diese CSP blockiert 1 Inline-Skript und 1 Inline-Style – zuerst auslagern.» */
export function conflictSummary(a: Omit<CspAnalysisDto, 'conflicts' | 'error'>, policy: string): string | null {
  const m = parsePolicy(policy)
  const inline: string[] = []
  if (a.inlineScripts && !allowsInline(sourcesFor(m, 'script-src-elem'))) inline.push(n(a.inlineScripts, 'Inline-Skript', 'Inline-Skripte'))
  if (a.inlineStyles && !allowsInline(sourcesFor(m, 'style-src-elem'))) inline.push(n(a.inlineStyles, 'Inline-Style', 'Inline-Styles'))
  if (a.styleAttributes && !allowsInline(sourcesFor(m, 'style-src-attr'))) inline.push(n(a.styleAttributes, 'style-Attribut', 'style-Attribute'))
  if (a.eventHandlers && !allowsInline(sourcesFor(m, 'script-src-attr'))) inline.push(n(a.eventHandlers, 'Ereignis-Attribut', 'Ereignis-Attribute'))
  if (!inline.length) return null
  const list = inline.length === 1 ? inline[0] : `${inline.slice(0, -1).join(', ')} und ${inline[inline.length - 1]}`
  return `Diese CSP blockiert ${list} – zuerst auslagern.`
}

/**
 * Vorschlag: Ausgangsregel bzw. Vorschlag aus den Meldungen, ergänzt um die
 * externen Quellen der Seiten. Inline-Code wird nicht erlaubt (kein
 * 'unsafe-inline'), sondern über conflictSummary gemeldet.
 */
export function suggestWithAnalysis(base: string, a: Omit<CspAnalysisDto, 'conflicts' | 'error'>): string {
  const violations = Object.entries(a.external).flatMap(([directive, list]) => list.map((blocked) => ({ directive, blocked })))
  return violations.length ? suggestCsp(base, violations).policy : formatPolicy(parsePolicy(base))
}

/* --- Funktionsprüfung im Headless-Browser --------------------------------------- */

/**
 * Shell im Browser-Container (zenika/alpine-chrome): jede Seite einzeln
 * laden, die Konsole (mit CSP-Verstössen) in eine Datei. Adressen und Proxy
 * kommen über die Umgebung (CHECK_URLS, CHECK_PROXY), nie in den Befehl.
 */
export const CHROME_SCRIPT =
  ': > /tmp/chrome.log; for u in $CHECK_URLS; do echo "### PAGE $u" >> /tmp/chrome.log; ' +
  'chromium-browser --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run ' +
  '--proxy-server="$CHECK_PROXY" --proxy-bypass-list="<-loopback>" --enable-logging=stderr --log-level=0 ' +
  // Kennung wie alle eigenen Prüfungen (lib/probe-ua.ts)
  '--user-agent="airlock-probe (browser)" ' +
  '--virtual-time-budget=4000 --dump-dom "$u" > /dev/null 2>> /tmp/chrome.log; done'

/**
 * Ausgabe von Chromium (--enable-logging=stderr) lesen. Jede Seite beginnt
 * mit einer Zeile «### PAGE <url>». Zurück: Verstösse als kurze Sätze.
 */
export function parseChromeCsp(log: string): { pages: string[]; violations: string[] } {
  const pages: string[] = []
  const violations: string[] = []
  let page = ''
  for (const line of log.split('\n')) {
    const p = /^### PAGE (\S+)/.exec(line)
    if (p) {
      try {
        page = new URL(p[1]!).pathname
      } catch {
        page = p[1]!
      }
      pages.push(page)
      continue
    }
    if (!/Content Security Policy/.test(line) || !/Refused to/.test(line) || /\[Report Only\]/.test(line)) continue
    const what = /Refused to (apply inline style|execute inline script|execute inline event handler|load the (?:script|stylesheet|image|font|media)|connect to|frame|load)[^"]*?(?:'([^']+)')?\s+because/.exec(line)
    const directive = /directive: "([a-z-]+)/.exec(line)?.[1] ?? 'csp'
    const kind = !what ? 'Ressource'
      : what[1] === 'apply inline style' ? 'Inline-Style'
      : what[1] === 'execute inline script' ? 'Inline-Skript'
      : what[1] === 'execute inline event handler' ? 'Ereignis-Attribut'
      : `${what[1]!.replace('load the ', '')}${what[2] ? ` ${what[2]}` : ''}`
    violations.push(`${kind} (${directive}) auf ${page || '/'}`)
  }
  return { pages, violations: [...new Set(violations)] }
}

/* --- Aufrufe im Report-Only ---------------------------------------------------- */


/**
 * Seitenaufrufe aus Caddys Zugriffs-Log zählen: GET, Status unter 400, ein
 * Seitenpfad (kein Asset, nicht /.well-known/), für die Namen des Projekts.
 */
export function countPageViews(log: string, o: { hosts: string[]; sinceMs: number; logger?: string }): number {
  const logger = `http.log.access.${o.logger ?? CSP_VIEW_LOGGER}`
  const hosts = new Set(o.hosts.map((h) => h.toLowerCase()))
  let count = 0
  for (const raw of log.split('\n')) {
    const l = raw.trim()
    if (!l.startsWith('{') || !l.includes(logger)) continue
    try {
      const j = JSON.parse(l) as { ts?: number; logger?: string; status?: number; request?: { method?: string; host?: string; uri?: string } }
      if (j.logger !== logger) continue
      const at = typeof j.ts === 'number' ? (j.ts > 1e12 ? j.ts : j.ts * 1000) : 0
      if (at < o.sinceMs) continue
      if (j.request?.method !== 'GET' || (j.status ?? 0) >= 400) continue
      if (!hosts.has((j.request.host ?? '').toLowerCase().replace(/:\d+$/, ''))) continue
      const path = (j.request.uri ?? '/').split('?')[0]!
      const last = path.split('/').pop() ?? ''
      if (path.startsWith('/.well-known/')) continue
      if (last.includes('.') && !/\.html?$/i.test(last)) continue
      count++
    } catch {
      /* keine JSON-Zeile */
    }
  }
  return count
}

/** Mindestzahl an Aufrufen im Report-Only ohne Verstoss, bevor scharf geschaltet werden darf */
export const VIEWS_NEEDED = 20

/**
 * Darf eine CSP scharf werden? Ja, wenn die Analyse der Seiten keinen
 * Konflikt findet ODER Report-Only mit genau diesem Wert mindestens
 * VIEWS_NEEDED Aufrufe ohne Verstoss gesehen hat.
 */
export function readinessFrom(o: { enforced: boolean; analysisError: string | null; conflicts: string[]; views: number | null; violationsSince: number }): { ok: boolean; reason: string } {
  if (o.enforced) return { ok: true, reason: 'Die CSP ist scharf geschaltet.' }
  const viewText = o.views === null
    ? 'Aufrufe nicht zählbar (Caddy-Log nicht lesbar)'
    : `${o.views} von ${VIEWS_NEEDED} Aufrufen im Report-Only${o.violationsSince ? `, ${o.violationsSince === 1 ? '1 Verstoss' : `${o.violationsSince} Verstösse`} gemeldet` : ' ohne Verstoss'}`
  if (!o.analysisError && o.conflicts.length === 0) return { ok: true, reason: `Die Analyse der Seiten findet keinen Konflikt mit dieser Regel (${viewText}).` }
  if (o.views !== null && o.views >= VIEWS_NEEDED && o.violationsSince === 0) return { ok: true, reason: `${viewText}.` }
  const why = o.analysisError ? `Analyse nicht möglich (${o.analysisError})` : `Die Regel würde blockieren: ${o.conflicts.join('; ')}`
  return { ok: false, reason: `${why}. ${viewText}.` }
}
