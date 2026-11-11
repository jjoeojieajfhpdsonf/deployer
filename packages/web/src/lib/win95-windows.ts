/**
 * Fensterzustände im Theme «Windows 95» – rein, ohne DOM (getestet).
 *
 * Wie im Original:
 * - _  minimiert in die Taskleiste; das Fenster merkt sich, ob es maximiert war
 * - □  maximiert; im maximierten Fenster stellt derselbe Knopf wieder her
 * - ✕  schliesst (Karten: bis zum Neuladen oder «Fenster wieder öffnen» im Startmenü)
 * - Taskleisten-Knopf: minimiertes Fenster kommt zurück (maximiert, wenn es das war);
 *   ein offenes Fenster wird minimiert
 * - Doppelklick auf die Titelleiste: maximieren bzw. wiederherstellen
 */

export type WinState = 'normal' | 'min' | 'max' | 'closed'
export type WinAction = 'min' | 'max' | 'close' | 'restore' | 'taskbar' | 'titlebar'
export interface Win { state: WinState; wasMax: boolean }

export const NORMAL: Win = { state: 'normal', wasMax: false }

export function nextWin(w: Win, a: WinAction): Win {
  switch (a) {
    case 'min':
      return w.state === 'closed' ? w : { state: 'min', wasMax: w.state === 'max' || (w.state === 'min' && w.wasMax) }
    case 'max':
    case 'titlebar':
      if (w.state === 'closed' || w.state === 'min') return w
      return w.state === 'max' ? { state: 'normal', wasMax: false } : { state: 'max', wasMax: false }
    case 'close':
      return { state: 'closed', wasMax: false }
    case 'restore':
      return NORMAL
    case 'taskbar':
      if (w.state === 'min') return { state: w.wasMax ? 'max' : 'normal', wasMax: false }
      if (w.state === 'closed') return w
      return nextWin(w, 'min')
  }
}
