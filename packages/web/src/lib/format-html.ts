/**
 * «Formatieren» im HTML-Editor der Pause-Seite: einfache Einrückung je
 * Verschachtelung, ein Block-Element pro Zeile. Kein voller Parser – Inhalt
 * von <style> wird zeilenweise eingerückt, <pre> und <textarea> bleiben
 * unverändert. Inline-Elemente (a, strong, span …) bleiben im Fluss.
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', '!doctype'])
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'img', 'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g'])
const RAW = new Set(['style', 'pre', 'textarea', 'script'])

export function formatHtml(src: string, indent = '  '): string {
  const out: string[] = []
  let depth = 0
  let line = ''
  const flush = () => {
    const t = line.trim()
    if (t) out.push(indent.repeat(Math.max(0, depth)) + t)
    line = ''
  }
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z!][\w:-]*)[^>]*>|[^<]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const tok = m[0]
    const name = (m[1] ?? '').toLowerCase()
    if (!name || tok.startsWith('<!--')) {
      // Text oder Kommentar: Leerraum zusammenfassen, im Fluss lassen
      const text = tok.replace(/\s+/g, ' ')
      if (text.trim()) line += text
      continue
    }
    const closing = tok.startsWith('</')
    const inline = INLINE.has(name)
    if (inline) { line += tok; continue }
    if (RAW.has(name) && !closing) {
      // Rohinhalt bis zum schliessenden Tag übernehmen
      const end = src.toLowerCase().indexOf(`</${name}`, re.lastIndex)
      const body = end < 0 ? src.slice(re.lastIndex) : src.slice(re.lastIndex, end)
      flush()
      out.push(indent.repeat(depth) + tok.trim())
      if (name === 'style') {
        const rows = body.split('\n').map((r) => r.trim()).filter(Boolean)
        for (const r of rows) out.push(indent.repeat(depth + 1) + r)
      } else if (body) {
        out.push(body.replace(/^\n|\n$/g, ''))
      }
      if (end >= 0) {
        const close = src.slice(end).match(/^<\/[^>]*>/)?.[0] ?? `</${name}>`
        out.push(indent.repeat(depth) + close)
        re.lastIndex = end + close.length
      } else {
        re.lastIndex = src.length
      }
      continue
    }
    if (closing) {
      flush()
      depth--
      out.push(indent.repeat(Math.max(0, depth)) + tok.trim())
    } else {
      flush()
      out.push(indent.repeat(depth) + tok.trim())
      if (!VOID.has(name) && !tok.endsWith('/>')) depth++
    }
  }
  flush()
  // Kurze Block-Elemente mit nur Text wieder auf eine Zeile ziehen: <h1>\n  Titel\n</h1> → <h1>Titel</h1>
  const joined: string[] = []
  for (let i = 0; i < out.length; i++) {
    const a = out[i]!
    const b = out[i + 1]
    const c = out[i + 2]
    const open = a.trim().match(/^<([a-z][\w-]*)\b[^>]*>$/i)
    if (open && b !== undefined && c !== undefined && !b.trim().startsWith('<') && c.trim() === `</${open[1]}>` && (a + b + c).trim().length < 110) {
      joined.push(`${a}${b.trim()}${c.trim()}`)
      i += 2
      continue
    }
    joined.push(a)
  }
  return `${joined.join('\n')}\n`
}
