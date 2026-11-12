import { createHash } from 'node:crypto'

/**
 * Gemeinsame Regel für zusammengesetzte interne Adressen <teil>--<projekt>
 * (Korrektur nach Nacht 2): Vorschauen (<branch>--<projekt>, Etappe 6) und
 * Dienst-Adressen (<dienst>--<projekt>, Etappe 4) gehen durch dieselbe
 * Funktion, damit beide dieselben Fehler vermeiden:
 *
 *   - ein DNS-Label: Kleinbuchstaben, Ziffern, Bindestrich, nicht am Rand,
 *     höchstens 63 Zeichen
 *   - nie «--» an Stelle 3 und 4: solche Labels sind für IDN reserviert
 *     («xn--…», RFC 5890) und werden teils abgelehnt – «db--shop» wäre so eins
 *   - passt es nicht (zu lang, IDN, reserviert, belegt): Teil gekürzt plus
 *     Hash-Suffix aus dem vollen Namen. Gleicher Name ergibt immer dieselbe
 *     Adresse.
 */

/** Ein DNS-Label hat höchstens 63 Zeichen */
export const LABEL_MAX = 63
/** Trenner zwischen Teil und Projekt */
export const LABEL_SEP = '--'

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Gültiges Label und nicht IDN-reserviert? */
export function isSafeLabel(label: string): boolean {
  return label.length <= LABEL_MAX && LABEL_RE.test(label) && label.slice(2, 4) !== '--'
}

/**
 * Freier Name → Teil des Labels: Kleinbuchstaben, ä/ö/ü → ae/oe/ue, ß → ss,
 * Akzente weg, alles andere (/, _, ., Leerzeichen, Emoji …) → ein Bindestrich,
 * keine Bindestriche am Rand. Läufe von Bindestrichen werden zu einem – so
 * steht «--» im Label nur als Trenner zum Projekt.
 */
export function labelPart(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const shortHash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 6)

/**
 * <teil>--<projekt> als sicheres Label. `name` ist der volle Name (Branch,
 * Dienst) und Grundlage für Teil und Hash. null, wenn der Projekt-Kurzname
 * zu lang ist oder alle Kandidaten belegt sind.
 */
export function compositeLabel(name: string, projectSlug: string, o: {
  /** Teil, wenn der Name nichts Brauchbares hergibt (z. B. nur Emoji) */
  fallback: string
  /** Teil schon bereinigt (Vorschau: ohne refs/heads/); sonst labelPart(name) */
  part?: string
  isTaken?: (label: string) => boolean
}): string | null {
  const tail = `${LABEL_SEP}${projectSlug}`
  const room = LABEL_MAX - tail.length
  if (room < 8) return null
  const part = (o.part ?? labelPart(name)) || o.fallback
  const hashed = (seed: string) => {
    const h = shortHash(seed)
    const cut = part.slice(0, room - h.length - 1).replace(/-+$/, '')
    return `${cut || o.fallback.slice(0, 1)}-${h}`
  }
  const candidates = [part, hashed(name)]
  for (let i = 2; i < 50; i++) candidates.push(hashed(`${name}#${i}`))
  for (const c of candidates) {
    const label = `${c}${tail}`
    if (!isSafeLabel(label) || o.isTaken?.(label)) continue
    return label
  }
  return null
}
