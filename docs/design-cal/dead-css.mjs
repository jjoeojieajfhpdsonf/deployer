// Tote CSS-Klassen finden: jede Klasse aus packages/web/src/styles.css muss im Quelltext
// (TSX/TS) vorkommen – als Wort oder als zusammengesetzter Name (`status-${s}` deckt
// status-running, status-failed … ab). Läuft mit: node docs/design-cal/dead-css.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../../packages/web/', import.meta.url))
const css = readFileSync(join(web, 'src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const classes = [...new Set([...css.matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)].map((m) => m[1]))]
  .filter((c) => !/^\d/.test(c))

const files = []
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(tsx?|html)$/.test(f)) files.push(p)
  }
}
walk(join(web, 'src'))
const src = files.map((f) => readFileSync(f, 'utf8')).join('\n') + readFileSync(join(web, 'index.html'), 'utf8')

const word = (c) => new RegExp(`(^|[^\\w-])${c.replace(/[-]/g, '\\-')}($|[^\\w-])`).test(src)
// Zusammengesetzt: ein Präfix der Klasse steht vor einem ${…}-Platzhalter oder einer Verkettung
const composed = (c) => {
  const parts = c.split('-')
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join('-') + '-'
    if (src.includes(`${prefix}\${`) || src.includes(`'${prefix}' +`) || src.includes(`\`${prefix}\${`)) return true
  }
  return false
}

const dead = classes.filter((c) => !word(c) && !composed(c)).sort()
console.log(`${classes.length} Klassen in styles.css, ${dead.length} ohne Verwendung im Quelltext`)
for (const c of dead) console.log(`  .${c}`)
process.exit(dead.length ? 1 : 0)
