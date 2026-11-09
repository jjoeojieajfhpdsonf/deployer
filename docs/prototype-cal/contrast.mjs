// WCAG-Kontrast der Prototyp-Farben. Ziel: Text ≥ 4.5 (AA), lesbarer Fliesstext ≥ 7, Nicht-Text ≥ 3.
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const L = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const cr = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

const themes = {
  light: {
    grounds: { bg: '#f6f6f7', surface: '#ffffff', 'surface-2': '#f1f1f3', 'surface-3': '#e8e8eb', code: '#f3f3f5' },
    text: { ink: ['#111113', 7], 'ink-dim': ['#3d3d42', 7], muted: ['#64646b', 4.5] },
    status: { ok: '#13753a', warn: '#8a5300', bad: '#c0281a', info: '#1d58c2' },
    tint: { ok: '#eaf6ee', warn: '#fcf3e2', bad: '#fdeeec', info: '#ecf2fd' },
    line: { 'field-line (Rahmen von Feldern)': ['#8a8a92', 3] },
    primary: { fill: '#111113', label: '#ffffff' },
  },
  dark: {
    grounds: { bg: '#0a0a0b', surface: '#141415', 'surface-2': '#1c1c1e', 'surface-3': '#26262a', code: '#0f0f10' },
    text: { ink: ['#f2f2f3', 7], 'ink-dim': ['#c4c4c8', 7], muted: ['#9b9ba2', 4.5] },
    status: { ok: '#4fc985', warn: '#e8b04e', bad: '#f47a70', info: '#7eaaf5' },
    tint: { ok: '#10241a', warn: '#2a2010', bad: '#2d1615', info: '#121d31' },
    line: { 'field-line (Rahmen von Feldern)': ['#6c6c74', 3] },
    primary: { fill: '#f2f2f3', label: '#111113' },
  },
}

let fails = 0
for (const [name, t] of Object.entries(themes)) {
  console.log(`\n== ${name}`)
  for (const [k, [c, min]] of Object.entries(t.text)) {
    for (const [g, gc] of Object.entries(t.grounds)) {
      const v = cr(c, gc); const ok = v >= min; if (!ok) fails++
      if (!ok || g === 'surface' || g === 'bg') console.log(`${ok ? 'ok ' : 'FAIL'} ${k} auf ${g}: ${v.toFixed(2)} (≥${min})`)
    }
  }
  for (const [k, c] of Object.entries(t.status)) {
    const rows = [...Object.entries(t.grounds).map(([g, gc]) => [g, gc]), [`${k}-bg`, t.tint[k]]]
    const vals = rows.map(([g, gc]) => { const v = cr(c, gc); if (v < 4.5) fails++; return `${g} ${v.toFixed(2)}${v < 4.5 ? ' FAIL' : ''}` })
    console.log(`${k}: ${vals.join(' · ')}`)
  }
  for (const [k, [c, min]] of Object.entries(t.line)) {
    for (const g of ['bg', 'surface']) { const v = cr(c, t.grounds[g]); if (v < min) fails++; console.log(`${v >= min ? 'ok ' : 'FAIL'} ${k} auf ${g}: ${v.toFixed(2)} (≥${min})`) }
  }
  const p = cr(t.primary.fill, t.primary.label); if (p < 4.5) fails++
  console.log(`Primärbutton Beschriftung: ${p.toFixed(2)}; Fläche gegen bg: ${cr(t.primary.fill, t.grounds.bg).toFixed(2)}`)
}
console.log(`\n${fails} unter dem Ziel`)
process.exit(fails ? 1 : 0)
