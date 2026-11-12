/**
 * Easter Egg «Windows 95»: zwei Wege zur Freischaltung, beide als reine
 * Funktionen (ohne DOM), damit sie getestet werden können.
 *
 * - Konami-Code ↑↑↓↓←→←→ B A, irgendwo getippt (nicht in Eingabefeldern)
 * - 7 Klicks auf die Versionsnummer unten links, jeder höchstens 1.5 s nach dem vorigen
 */

export const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'] as const

/** Taste vereinheitlichen: Buchstaben klein (B mit Umschalt oder Feststelltaste zählt auch) */
const norm = (key: string) => (key.length === 1 ? key.toLowerCase() : key)

/**
 * Nächster Stand nach einer Taste: wie viele Tasten der Folge bisher stimmen.
 * Eine falsche Taste setzt zurück – zählt aber selbst als Anfang, wenn sie
 * einer ist (↑↑↑↓… klappt also).
 */
export function konamiStep(progress: number, key: string): number {
  const k = norm(key)
  if (KONAMI[progress] === k) return progress + 1
  // Längstes Ende der bisherigen Eingabe plus dieser Taste, das ein Anfang der Folge ist
  const typed = [...KONAMI.slice(0, progress), k]
  for (let start = 1; start < typed.length; start++) {
    const tail = typed.slice(start)
    if (tail.every((t, i) => KONAMI[i] === t)) return tail.length
  }
  return 0
}

/** Ganze Folge erkannt? */
export const konamiDone = (progress: number) => progress >= KONAMI.length

/** Erkennt den Code in einer Tastenfolge (für Tests und zum Nachprüfen). */
export function containsKonami(keys: readonly string[]): boolean {
  let p = 0
  for (const k of keys) {
    p = konamiStep(p, k)
    if (konamiDone(p)) return true
  }
  return false
}

export const VERSION_CLICKS = 7
export const VERSION_CLICK_GAP_MS = 1500

/** Nächster Stand der Klick-Serie auf die Version (Zahl der Klicks und Zeit des letzten). */
export function versionClick(state: { count: number; last: number }, now: number): { count: number; last: number } {
  const count = now - state.last <= VERSION_CLICK_GAP_MS ? state.count + 1 : 1
  return { count, last: now }
}

/**
 * Etappe 7 – Theme «Terminal»: «sudo» in der Befehlspalette (⌘K). Zählt das
 * Wort allein oder als Anfang eines Befehls («sudo deploy»), egal ob gross
 * oder klein und mit Leerzeichen rundherum; nicht als Teil eines Worts
 * («sudoku», «pseudo»).
 */
export function isSudo(query: string): boolean {
  return /^sudo(\s|$)/i.test(query.trim())
}
