import { readdir, readFile, open } from 'node:fs/promises'
import { join, relative, dirname, basename } from 'node:path'
import type { FindingInput } from './score.js'

/**
 * Abhängigkeiten im Quellcode (Stufe trivy-source). Trivy prüft Lockfiles auf
 * bekannte Schwachstellen; hier steht, was Trivy dafür braucht und was es
 * nicht sieht:
 *
 * - Manifest ohne Lockfile (package.json ohne pnpm-lock.yaml usw.): Trivy
 *   kennt die tatsächlich installierten Versionen nicht – Befund «niedrig».
 * - Zusammenfassung für die Anzeige: «Abhängigkeiten: 214 Pakete aus
 *   pnpm-lock.yaml» bzw. «keine Abhängigkeiten gefunden», damit ein leerer
 *   Lauf nie wie «alles sicher» aussieht.
 * - Statische Seiten ohne Build: Bibliotheken liegen als einzelne Dateien im
 *   Ausgabeordner (jquery-3.4.1.min.js). Trivy erkennt sie nicht (es liest
 *   nur Paket-Metadaten); ZAP meldet sie per Retire.js, aber nur, wenn eine
 *   gecrawlte Seite sie lädt. Erkannt werden sie hier, damit die Anzeige sie
 *   nennt (siehe docs/MILESTONE-6.md, offene Punkte).
 */

/** Für Manifeste: Abhängigkeits- und Build-Ordner haben eigene, fremde Manifeste. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build', '.next', '.nuxt'])
/** Für JS-Bibliotheken: gerade vendor/ und dist/ zählen (dort liegen sie bei statischen Seiten). */
const SKIP_DIRS_JS = new Set(['node_modules', '.git'])
const MAX_FILES = 20_000

/** Manifest → Lockfiles, die Trivy dafür liest. */
const LOCKS: { manifest: string; locks: string[]; hasDeps: (text: string) => boolean; howTo: string }[] = [
  {
    manifest: 'package.json',
    locks: ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'],
    hasDeps: (t) => {
      try {
        const j = JSON.parse(t) as Record<string, Record<string, string> | undefined>
        return ['dependencies', 'devDependencies', 'optionalDependencies'].some((k) => Object.keys(j[k] ?? {}).length > 0)
      } catch {
        return false
      }
    },
    howTo: 'npm install, pnpm install oder yarn ausführen und das erzeugte Lockfile mitliefern.',
  },
  {
    manifest: 'pyproject.toml',
    locks: ['poetry.lock', 'uv.lock', 'pdm.lock', 'requirements.txt', 'Pipfile.lock'],
    hasDeps: (t) => /^\s*dependencies\s*=\s*\[\s*["']/m.test(t) || /^\[tool\.poetry\.dependencies\]/m.test(t),
    howTo: 'poetry lock, uv lock oder pip freeze > requirements.txt ausführen und die Datei mitliefern.',
  },
  { manifest: 'Pipfile', locks: ['Pipfile.lock'], hasDeps: () => true, howTo: 'pipenv lock ausführen und Pipfile.lock mitliefern.' },
  { manifest: 'go.mod', locks: ['go.sum'], hasDeps: (t) => /^\s*require\b/m.test(t), howTo: 'go mod tidy ausführen und go.sum mitliefern.' },
  { manifest: 'Cargo.toml', locks: ['Cargo.lock'], hasDeps: (t) => /^\[(dev-)?dependencies\]/m.test(t), howTo: 'cargo generate-lockfile ausführen und Cargo.lock mitliefern.' },
  { manifest: 'composer.json', locks: ['composer.lock'], hasDeps: (t) => /"require"\s*:\s*\{\s*"/.test(t), howTo: 'composer update ausführen und composer.lock mitliefern.' },
  { manifest: 'Gemfile', locks: ['Gemfile.lock'], hasDeps: (t) => /^\s*gem\s+['"]/m.test(t), howTo: 'bundle lock ausführen und Gemfile.lock mitliefern.' },
]

/** Alle Dateien unter dir (relativ), ohne Abhängigkeits- und Build-Ordner. */
export async function listFiles(dir: string, skip: Set<string> = SKIP_DIRS): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string) => {
    if (out.length >= MAX_FILES) return
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (!skip.has(e.name)) await walk(p)
      } else if (e.isFile()) {
        out.push(relative(dir, p))
      }
    }
  }
  await walk(dir)
  return out.sort()
}

/** Manifeste mit Abhängigkeiten, neben denen kein passendes Lockfile liegt. */
export async function missingLockfiles(dir: string, files?: string[]): Promise<FindingInput[]> {
  const all = files ?? (await listFiles(dir))
  const present = new Set(all)
  const out: FindingInput[] = []
  for (const f of all) {
    const rule = LOCKS.find((l) => l.manifest === basename(f))
    if (!rule) continue
    const d = dirname(f)
    const sibling = (name: string) => (d === '.' ? name : join(d, name))
    if (rule.locks.some((l) => present.has(sibling(l)))) continue
    const text = await readFile(join(dir, f), 'utf8').catch(() => '')
    if (!rule.hasDeps(text)) continue
    out.push({
      tool: 'trivy',
      severity: 'low',
      title: 'Ohne Lockfile keine verlässliche Prüfung der Abhängigkeiten',
      location: f,
      key: `nolock:${f}`,
      description: `${f} nennt Abhängigkeiten, aber daneben liegt kein Lockfile (${rule.locks.join(', ')}). Ohne Lockfile sind die installierten Versionen unbekannt; bekannte Schwachstellen darin bleiben unentdeckt, und jeder Build kann andere Versionen ziehen.`,
      fix: rule.howTo,
    })
  }
  return out
}

/* --- Zusammenfassung aus dem Trivy-Bericht ------------------------------------- */

interface TrivyDoc { Results?: { Target?: string; Class?: string; Type?: string; Packages?: unknown[] | null }[] }

/**
 * «Abhängigkeiten: 214 Pakete aus pnpm-lock.yaml» – braucht --list-all-pkgs.
 * Mehrere Lockfiles werden aufgezählt; ohne eines: «keine Abhängigkeiten
 * gefunden».
 */
export function depsSummary(json: unknown): string {
  const parts = ((json as TrivyDoc).Results ?? [])
    .filter((r) => r.Class === 'lang-pkgs' && r.Target)
    .map((r) => ({ target: r.Target!, n: r.Packages?.length ?? 0 }))
  if (parts.length === 0) return 'keine Abhängigkeiten gefunden (kein Lockfile im Quellcode)'
  const fmt = (n: number) => `${n.toLocaleString('de-CH')} ${n === 1 ? 'Paket' : 'Pakete'}`
  if (parts.length === 1) return `Abhängigkeiten: ${fmt(parts[0]!.n)} aus ${parts[0]!.target}`
  const total = parts.reduce((s, p) => s + p.n, 0)
  const list = parts.slice(0, 3).map((p) => `${p.n} aus ${p.target}`).join(', ')
  return `Abhängigkeiten: ${fmt(total)} (${list}${parts.length > 3 ? ` und ${parts.length - 3} weitere Lockfiles` : ''})`
}

/* --- JS-Bibliotheken im Ausgabeordner ------------------------------------------- */

export interface JsLib { name: string; version: string; file: string }

const LIB_NAMES = ['jquery', 'jquery-ui', 'bootstrap', 'angular', 'angularjs', 'lodash', 'underscore', 'moment', 'vue', 'react', 'react-dom', 'handlebars', 'knockout', 'dompurify', 'd3', 'backbone', 'ember', 'prototype', 'mootools', 'swfobject', 'jquery-migrate', 'select2', 'datatables', 'chart', 'axios']

/** Aus dem Dateinamen: jquery-3.4.1.min.js, bootstrap.4.3.1.js, lodash@4.17.20.js */
function fromFileName(file: string): JsLib | null {
  const m = /^([a-z][a-z0-9.-]*?)[-.@]v?(\d+\.\d+(?:\.\d+)?)(?:[.-](?:min|slim|slim\.min|bundle|bundle\.min|esm|umd))*\.js$/i.exec(basename(file))
  if (!m) return null
  const name = m[1]!.toLowerCase()
  if (!LIB_NAMES.includes(name)) return null
  return { name, version: m[2]!, file }
}

/** Aus dem Kopfkommentar: «/*! jQuery v3.4.1», «Bootstrap v4.3.1», «@license Lodash 4.17.20» */
const BANNERS: [RegExp, string][] = [
  [/jQuery UI - v(\d+\.\d+\.\d+)/, 'jquery-ui'],
  [/jQuery Migrate v?(\d+\.\d+\.\d+)/, 'jquery-migrate'],
  [/jQuery (?:JavaScript Library )?v(\d+\.\d+\.\d+)/, 'jquery'],
  [/Bootstrap v(\d+\.\d+\.\d+)/, 'bootstrap'],
  [/@license (?:AngularJS )?v?(\d+\.\d+\.\d+)[\s\S]{0,40}angularjs?\.org/i, 'angularjs'],
  [/Lodash (?:<https:\/\/lodash\.com\/> )?(?:\(Custom Build\) )?v?(\d+\.\d+\.\d+)|lodash\.com[\s\S]{0,80}?@license[\s\S]{0,40}?(\d+\.\d+\.\d+)/i, 'lodash'],
  [/Underscore\.js (\d+\.\d+\.\d+)/, 'underscore'],
  [/moment\.js[\s\S]{0,40}?version : (\d+\.\d+\.\d+)|^\/\/! moment\.js[\s\S]{0,20}?(\d+\.\d+\.\d+)/m, 'moment'],
  [/Vue\.js v(\d+\.\d+\.\d+)/, 'vue'],
  [/Handlebars v?(\d+\.\d+\.\d+)|handlebars v(\d+\.\d+\.\d+)/i, 'handlebars'],
  [/DOMPurify (\d+\.\d+\.\d+)/, 'dompurify'],
]

export function fromBanner(head: string, file: string): JsLib | null {
  for (const [re, name] of BANNERS) {
    const m = re.exec(head)
    const version = m?.slice(1).find(Boolean)
    if (version) return { name, version, file }
  }
  return null
}

async function readHead(path: string, bytes = 600): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

/** Bekannte JS-Bibliotheken als Einzeldateien (Name, Version, Datei), ohne Doppelte. */
export async function detectJsLibs(dir: string, files?: string[]): Promise<JsLib[]> {
  const all = (files ?? (await listFiles(dir, SKIP_DIRS_JS))).filter((f) => f.endsWith('.js'))
  const found = new Map<string, JsLib>()
  for (const f of all.slice(0, 2_000)) {
    const lib = fromFileName(f) ?? fromBanner(await readHead(join(dir, f)).catch(() => ''), f)
    if (lib && !found.has(`${lib.name}@${lib.version}`)) found.set(`${lib.name}@${lib.version}`, lib)
  }
  return [...found.values()]
}

/** Text für die Anzeige der Stufe: was abgedeckt wurde. */
export function sourceChecked(summary: string, libs: JsLib[], missing: number): string {
  const parts = [summary]
  if (missing > 0) parts.push(`${missing} ${missing === 1 ? 'Manifest' : 'Manifeste'} ohne Lockfile`)
  if (libs.length) {
    const list = libs.slice(0, 4).map((l) => `${l.name} ${l.version}`).join(', ')
    parts.push(`JS-Bibliotheken im Ausgabeordner: ${list}${libs.length > 4 ? ` und ${libs.length - 4} weitere` : ''} (Versionen prüft ZAP, sofern eine Seite sie lädt)`)
  }
  return parts.join(' · ')
}
