// WCAG-Kontrast der Design-Tokens, gelesen direkt aus packages/web/src/styles.css
// (:root = Hell, :root[data-theme='dark'] = Dunkel, :root[data-theme='win95'] = Windows 95).
// Läuft mit: node docs/design-cal/contrast.mjs
//
// Ziele:  Text ≥ 4.5:1 (AA) · Lesetext (ink, ink-dim) ≥ 7:1
//         Feldrahmen, Statuszeichen und Statusflächen (Punkte, Balken, Linien, Primärfläche) ≥ 3:1
// «Statusflächen» heisst hier: Elemente, die einen Zustand ohne Text tragen (Punkt, Balken,
// Diagrammlinie). Die blassen Tönungen hinter Status-Pillen tragen immer ein Wort und sind
// Gestaltung, keine Information – geprüft wird dort der Text auf der Tönung (≥ 4.5:1).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(fileURLToPath(new URL('../../packages/web/src/styles.css', import.meta.url)), 'utf8')
const block = (sel) => {
  const i = css.indexOf(sel)
  if (i < 0) throw new Error(`Block ${sel} fehlt in styles.css`)
  return css.slice(i, css.indexOf('\n}', i))
}
const tokens = (txt) => Object.fromEntries([...txt.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2].toLowerCase()]))
const light = tokens(block(':root, .theme-light {'))
const dark = { ...light, ...tokens(block(":root[data-theme='dark'], .theme-dark {")) }
// Verstecktes Theme «Windows 95»: eigene Tokens über Hell (Code-Editor bleibt hell)
const win95 = { ...light, ...tokens(block(":root[data-theme='win95'], .theme-win95 {")) }

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const L = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const cr = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

const grounds = ['bg', 'surface', 'surface-2', 'inset', 'code']
const checks = [
  // [Vordergrund, Hintergründe, Mindestwert, Art]
  ['ink', grounds, 7, 'Lesetext'],
  ['ink-dim', grounds, 7, 'Lesetext'],
  ['muted', [...grounds, 'surface-3'], 4.5, 'Text'],
  ['primary-ink', ['primary'], 4.5, 'Text auf Primär-Button'],
  // Roter gefüllter Knopf (Bestätigung): Hell weisse Schrift (= bg), Dunkel Schrift in der Grundfarbe
  // Gleiches Paar: roter Bestätigungs-Knopf und Schweregrad «kritisch» gefüllt (UI-Qualität 7)
  ['bg', ['bad'], 4.5, 'Text auf Rot (Bestätigungs-Knopf, «kritisch» gefüllt)'],
  ...['ok', 'warn', 'bad', 'info'].map((s) => [s, [...grounds, 'surface-3', `${s}-bg`], 4.5, 'Statustext und -zeichen']),
  ['field-line', ['bg', 'surface', 'inset'], 3, 'Feldrahmen'],
  ['primary', ['bg', 'surface'], 3, 'Primärfläche'],
  ['ink', ['surface-3', 'surface-2'], 3, 'Balken/Diagrammlinie'],
  ['warn', ['surface-3'], 3, 'Statusbalken'],
  ['bad', ['surface-3'], 3, 'Statusbalken'],
  ['info', ['surface-3'], 3, 'Statusbalken'],
  // Projektseite: Claude-Funke als Auslöser (Zeichen neben dem Token-Namen)
  ['claude', ['claude-bg', 'surface', 'surface-2'], 3, 'Auslöser-Zeichen'],
  // Code-Editor der Pause-Seite: Syntaxfarben auf dem Editor-Grund und der aktiven Zeile
  ...['cm-ink', 'cm-tag', 'cm-attr', 'cm-string', 'cm-number', 'cm-comment'].map((c) => [c, ['cm-bg', 'cm-active'], 4.5, 'Code im Editor']),
  ['cm-gutter', ['cm-bg'], 3, 'Zeilennummern'],
  ['cm-token', ['cm-token-bg'], 4.5, 'Platzhalter im Editor'],
]
// Nur Windows 95: weisser Titel auf der Titelleiste (Verlauf #000080 → #1084d0; der Text reicht höchstens bis 60 %)
const win95Checks = [
  ['white', ['title-from', 'title-mid'], 4.5, 'Titel in der Titelleiste'],
  ['white', ['desktop'], 4.5, 'Beschriftung der Desktop-Symbole'],
]
const w95extra = tokens(block(":root[data-theme='win95'] {"))
win95.white = '#ffffff'
win95['title-from'] = '#000080'
win95['title-mid'] = w95extra['w95-title-mid']

let fails = 0
for (const [name, t] of [['Hell', light], ['Dunkel', dark], ['Windows 95', win95]]) {
  console.log(`\n== ${name}`)
  for (const [fg, bgs, min, kind] of t === win95 ? [...checks, ...win95Checks] : checks) {
    const vals = bgs.map((b) => {
      if (!t[fg] || !t[b]) throw new Error(`Token fehlt: --${!t[fg] ? fg : b}`)
      const v = cr(t[fg], t[b])
      if (v < min) fails++
      return `${b} ${v.toFixed(2)}${v < min ? ' FAIL' : ''}`
    })
    const worst = Math.min(...bgs.map((b) => cr(t[fg], t[b])))
    console.log(`${worst >= min ? 'ok  ' : 'FAIL'} ${fg.padEnd(12)} ≥${min} ${kind}: ${vals.join(' · ')}`)
  }
}
console.log(`\n${fails === 0 ? 'Alle Kontraste erfüllt' : `${fails} unter dem Ziel`}`)
process.exit(fails ? 1 : 0)
