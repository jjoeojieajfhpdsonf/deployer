/**
 * Unified Diff für Vorschläge (M8). Rein, ohne git: Zeilen per LCS, Hunks
 * mit drei Zeilen Kontext. Für die kleinen Dateien eines Chat-Projekts
 * genügt O(n·m); sehr grosse Dateien werden als Ganzes ersetzt.
 */

const CONTEXT = 3
const MAX_CELLS = 4_000_000

type Op = { k: ' ' | '-' | '+'; line: string; a: number; b: number }

const splitLines = (s: string) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'))

function ops(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  if (n * m > MAX_CELLS) {
    return [...a.map((line, i) => ({ k: '-' as const, line, a: i, b: 0 })), ...b.map((line, j) => ({ k: '+' as const, line, a: n, b: j }))]
  }
  // L[i][j] = Länge der LCS von a[i..] und b[j..]
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!)
  }
  const out: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push({ k: ' ', line: a[i]!, a: i++, b: j++ })
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push({ k: '-', line: a[i]!, a: i++, b: j })
    else out.push({ k: '+', line: b[j]!, a: i, b: j++ })
  }
  while (i < n) out.push({ k: '-', line: a[i]!, a: i++, b: j })
  while (j < m) out.push({ k: '+', line: b[j]!, a: i, b: j++ })
  return out
}

/** Diff einer Datei; leer, wenn gleich. oldText null: neue Datei, newText null: gelöscht. */
export function unifiedDiff(path: string, oldText: string | null, newText: string | null): string {
  const a = splitLines(oldText ?? '')
  const b = splitLines(newText ?? '')
  if (oldText !== null && newText !== null && oldText === newText) return ''
  const all = ops(a, b)
  const changed = all.map((o, idx) => (o.k !== ' ' ? idx : -1)).filter((x) => x >= 0)
  if (!changed.length) return ''
  // Hunks: geänderte Zeilen mit Kontext zusammenfassen
  const hunks: [number, number][] = []
  for (const c of changed) {
    const s = Math.max(0, c - CONTEXT)
    const e = Math.min(all.length - 1, c + CONTEXT)
    const last = hunks[hunks.length - 1]
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e)
    else hunks.push([s, e])
  }
  const head = [`--- ${oldText === null ? '/dev/null' : `a/${path}`}`, `+++ ${newText === null ? '/dev/null' : `b/${path}`}`]
  const body = hunks.map(([s, e]) => {
    const part = all.slice(s, e + 1)
    const aLines = part.filter((o) => o.k !== '+').length
    const bLines = part.filter((o) => o.k !== '-').length
    const aStart = aLines ? part.find((o) => o.k !== '+')!.a + 1 : part[0]!.a
    const bStart = bLines ? part.find((o) => o.k !== '-')!.b + 1 : part[0]!.b
    return [`@@ -${aStart},${aLines} +${bStart},${bLines} @@`, ...part.map((o) => `${o.k}${o.line}`)].join('\n')
  })
  return [...head, ...body].join('\n')
}
