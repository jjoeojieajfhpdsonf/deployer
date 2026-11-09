// Fasst referenz/styles.json zusammen: je Bauteil die häufigsten Werte.
import { readFileSync } from 'node:fs'

const s = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const top = (arr, key, n = 4) => {
  const m = new Map()
  for (const x of arr) m.set(x[key], (m.get(x[key]) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([v, c]) => `${v} (${c}×)`).join(' | ')
}
console.log('page', JSON.stringify(s.page))
for (const k of ['cards', 'buttons', 'badges', 'h1', 'h2', 'h3', 'body']) {
  const a = s[k]
  console.log(`\n## ${k} (${a.length})`)
  for (const f of ['radius', 'shadow', 'border', 'padding', 'gap', 'bg', 'color', 'font', 'size', 'weight', 'ls', 'lh', 'h']) console.log(`${f}: ${top(a, f)}`)
}
