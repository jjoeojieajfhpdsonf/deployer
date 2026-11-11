import type { FixWay } from '@airlock/shared'
import { headerFixFor } from '@airlock/shared'

/**
 * M8, Etappe 2: Kontext für «Mit Claude lösen». Reine Funktionen: welcher
 * Weg, welche Dateien betroffen sind und wie sie vor dem Versand bereinigt
 * werden. An Claude gehen nur Befund und betroffene Dateien – nie Secrets,
 * nie Werte aus der Projekt-Env (SPEC).
 */

/** Ersetzt eine Zeile, in der Trivy ein Secret gefunden hat. */
export const SECRET_LINE_MARK = '«Airlock: Zeile entfernt, sie enthält ein Secret»'
/** Ersetzt einen Wert aus der Projekt-Env. */
export const ENV_VALUE_MARK = '«Airlock: Wert aus den Umgebungsvariablen des Projekts»'

/** Dateien, die nie an Claude gehen (Env-Dateien, Schlüssel). */
export function isWithheld(path: string): boolean {
  const base = path.split('/').pop() ?? path
  return /^\.env(\..*)?$/i.test(base) || /\.(pem|key|p12|pfx)$/i.test(base) || /^id_(rsa|ed25519|ecdsa)$/.test(base)
}

export function fixWay(
  f: { tool: string; title: string },
  o: { sourceType: string; runtimeKind: string; github: boolean },
): FixWay {
  const header = headerFixFor(f)
  // CSP-Fix: eine CSP ohne 'unsafe-inline' braucht oft ausgelagerten
  // Inline-Code – das ist eine Codeänderung (Header setzt danach Caddy)
  if (header && !(header === 'content-security-policy' && ['files', 'dockerfile', 'compose'].includes(o.sourceType))) return 'header'
  if (o.sourceType === 'files') return 'files'
  if (o.sourceType === 'image') return 'image'
  if (o.sourceType === 'dockerfile' || o.sourceType === 'compose') return o.github ? 'github' : 'repo'
  return 'none'
}

/** Datei und Zeile eines Secret-Befunds von Trivy («Secret im Code: …», Ort «pfad:zeile»). */
export function secretLocation(f: { tool: string; title: string; location: string }): { path: string; line: number } | null {
  if (f.tool !== 'trivy' || !f.title.startsWith('Secret im Code')) return null
  const m = /^(.*):(\d+)$/.exec(f.location.trim())
  return m ? { path: m[1]!.replace(/^\/+/, ''), line: Number(m[2]) } : null
}

/**
 * Welche Dateien des Repos betrifft der Befund? Aus dem Ort (erster Teil vor
 * « · », ohne Zeilennummer, ohne Herkunft einer URL) und je nach Art
 * Dockerfile/Compose bzw. Paketdateien. Höchstens 8.
 */
export function affectedPaths(f: { tool: string; title: string; location: string }, repoPaths: string[]): string[] {
  const out = new Set<string>()
  const has = (p: string) => repoPaths.includes(p)
  const bySuffix = (p: string) => {
    const clean = p.replace(/^\.?\/+/, '')
    if (!clean) return
    if (has(clean)) out.add(clean)
    else for (const r of repoPaths) if (r.endsWith(`/${clean}`) || clean.endsWith(`/${r}`)) out.add(r)
  }
  // CSP-Befund: die HTML-Seiten (dort steht der Inline-Code), index.html zuerst
  if (f.tool === 'header-check') {
    return repoPaths
      .filter((p) => /\.html?$/i.test(p) && !isWithheld(p))
      .sort((a, b) => Number(!/(^|\/)index\.html?$/i.test(a)) - Number(!/(^|\/)index\.html?$/i.test(b)) || a.localeCompare(b))
      .slice(0, 8)
  }
  const first = (f.location.split(' · ')[0] ?? '').trim()
  let path = first.replace(/:\d+$/, '')
  try {
    path = new URL(path).pathname
  } catch {
    /* kein URL */
  }
  bySuffix(path)
  const lower = `${f.title} ${f.location}`.toLowerCase()
  // Paketdateien zu einer Lock-Datei
  for (const p of [...out]) {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : ''
    if (/package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$/.test(p) && has(`${dir}package.json`)) out.add(`${dir}package.json`)
    if (/requirements.*\.txt$|poetry\.lock$/.test(p) && has(`${dir}pyproject.toml`)) out.add(`${dir}pyproject.toml`)
  }
  // Betriebssystem-Pakete, Container-Einstellungen: Dockerfile und Compose
  if (f.tool === 'trivy' && (out.size === 0 || /root|privileged|healthcheck|dockerfile|user/.test(lower))) {
    for (const r of repoPaths) if (/(^|\/)(Dockerfile|Containerfile)$|(^|\/)(docker-)?compose\.ya?ml$/.test(r)) out.add(r)
  }
  return [...out].filter((p) => !isWithheld(p)).slice(0, 8)
}

/**
 * Inhalt bereinigen: Zeilen mit Secrets ersetzen, Werte aus der Projekt-Env
 * (ab 4 Zeichen) ersetzen. Gibt an, wie viel ersetzt wurde.
 */
export function maskContent(content: string, o: { secretLines?: number[]; envValues?: string[] }): { content: string; maskedLines: number; maskedValues: number } {
  const lines = content.split('\n')
  let maskedLines = 0
  for (const n of o.secretLines ?? []) {
    if (n >= 1 && n <= lines.length) {
      lines[n - 1] = SECRET_LINE_MARK
      maskedLines++
    }
  }
  let text = lines.join('\n')
  let maskedValues = 0
  const values = [...new Set((o.envValues ?? []).filter((v) => v.length >= 4))].sort((a, b) => b.length - a.length)
  for (const v of values) {
    const parts = text.split(v)
    if (parts.length > 1) {
      maskedValues += parts.length - 1
      text = parts.join(ENV_VALUE_MARK)
    }
  }
  return { content: text, maskedLines, maskedValues }
}

/** Ein Vorschlag darf keine Platzhalter aus get_fix_context zurückschreiben. */
export function containsMask(content: string): boolean {
  return content.includes(SECRET_LINE_MARK) || content.includes(ENV_VALUE_MARK)
}

/** Erklärung je Weg (für get_fix_context und die Oberfläche). */
export function wayExplanation(way: FixWay): string {
  switch (way) {
    case 'header':
      return 'Ein fehlender Security-Header: Caddy ergänzt ihn ohne Codeänderung (set_security_header bzw. «Header setzen»).'
    case 'files':
      return 'Chat-Projekt: Die Änderung wird als Vorschlag mit Diff angelegt (propose_fix). Erst nach Zustimmung entsteht eine neue Version, Airlock deployt und scannt nach.'
    case 'github':
      return 'Repo mit verbundener GitHub App: Der Vorschlag wird als Branch airlock/fix-… mit Pull Request angelegt; nach dem Merge deployt Airlock und scannt nach.'
    case 'repo':
      return 'Git-Repo ohne Verbindung zu Airlock: Die Änderung gehört ins Repo, auf einen eigenen Branch. Airlock deployt nach dem nächsten Deploy und scannt nach.'
    case 'image':
      return 'Fertiges Image: Airlock kann nichts daran ändern. Abhilfe ist eine neuere Image-Version, in der das Paket aktualisiert ist.'
    case 'none':
      return 'Für diese Quelle gibt es keinen Weg zum Code (etwa ein Upload). Neue Fassung hochladen oder den Befund mit Begründung akzeptieren.'
  }
}

/* --- Fertige Images: neuere Tags derselben Linie ------------------------------- */

/** «1.21.6-alpine3.15» -> Zahlen [1,21,6], Linie «-alpine» (ohne Ziffern der Variante). */
export function parseTag(tag: string): { nums: number[]; flavor: string; prefix: string } | null {
  const m = /^(v?)(\d+(?:\.\d+)*)(.*)$/.exec(tag)
  if (!m) return null
  return { prefix: m[1]!, nums: m[2]!.split('.').map(Number), flavor: m[3]!.replace(/[\d.]+/g, '') }
}

/** Variante ohne die Version davor: «1.27-alpine3.20» -> «-alpine3.20» */
const suffixOf = (tag: string) => /^v?\d+(?:\.\d+)*(.*)$/.exec(tag)?.[1] ?? ''

const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d
  }
  return 0
}

/**
 * Neuere Tags in derselben Linie (gleiche Variante, gleiche Zahl an
 * Stellen): die neueste derselben Hauptversion zuerst, dann die neueste
 * überhaupt. Vorabversionen (rc, beta) fallen weg.
 */
export function tagCandidates(current: string, tags: string[]): string[] {
  const cur = parseTag(current)
  if (!cur) return []
  const same = tags
    .filter((t) => !/(rc|beta|alpha|dev|nightly)/i.test(t))
    .map((t) => ({ t, p: parseTag(t) }))
    .filter((x): x is { t: string; p: NonNullable<ReturnType<typeof parseTag>> } =>
      Boolean(x.p && x.p.flavor === cur.flavor && x.p.prefix === cur.prefix && x.p.nums.length === cur.nums.length && cmp(x.p.nums, cur.nums) > 0))
    // Neueste zuerst; bei gleicher Version die mit genau derselben Variante
    // («1.27-alpine» vor «1.27-alpine3.20», wenn das aktuelle «-alpine» heisst)
    .sort((a, b) => cmp(b.p.nums, a.p.nums) || Number(suffixOf(b.t) === suffixOf(current)) - Number(suffixOf(a.t) === suffixOf(current)))
  const sameMajor = same.find((x) => x.p.nums[0] === cur.nums[0])
  const newest = same[0]
  return [...new Set([sameMajor?.t, newest?.t].filter((t): t is string => Boolean(t)))]
}

/** «pkg auf 1.2.3 bzw. 1.2.4 oder neuer …» aus der Behebung eines Trivy-Befunds. */
export function fixedInFrom(f: { tool: string; title: string; fix: string }): string | null {
  if (f.tool !== 'trivy' || !/bekannte Schwachstelle/.test(f.title)) return null
  const m = /^(\S+) auf (.+?) oder neuer/.exec(f.fix)
  return m ? `${m[1]} ${m[2]}` : null
}
