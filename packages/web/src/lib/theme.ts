import type { ThemePref } from '@airlock/shared'

/**
 * Darstellung Hell/Dunkel. Die Wahl liegt auf dem Server (Profilmenü, gilt
 * auf jedem Gerät); localStorage hält nur eine Kopie, damit index.html sie
 * vor dem ersten Bild setzen kann und nichts aufblitzt. «system» folgt
 * prefers-color-scheme und wechselt mit, wenn das Gerät umschaltet.
 */
export const THEME_KEY = 'airlock.theme'
/** Schlüssel vor der Umbenennung; wird beim Lesen einmalig übernommen. */
const OLD_THEME_KEY = 'deployer.theme'

const media = () => (typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null)

export type ResolvedTheme = 'light' | 'dark' | 'win95'

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === 'light' || pref === 'dark' || pref === 'win95') return pref
  return media()?.matches ? 'dark' : 'light'
}

export function readLocalTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY) ?? localStorage.getItem(OLD_THEME_KEY)
    return v === 'light' || v === 'dark' || v === 'system' || v === 'win95' ? v : 'system'
  } catch {
    return 'system'
  }
}

let current: ThemePref = 'system'
let listening = false
const listeners = new Set<() => void>()

/** Für useSyncExternalStore: Taskleiste und Fenster-Knöpfe erscheinen nur bei «Windows 95». */
export const subscribeTheme = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export const currentTheme = (): ResolvedTheme => resolveTheme(current)

const THEME_COLOR: Record<ResolvedTheme, string> = { light: '#ffffff', dark: '#0a0a0b', win95: '#008080' }

function paint(): void {
  const t = resolveTheme(current)
  const root = document.documentElement
  root.dataset.theme = t
  // Windows 95 ist ein helles Schema (Formularfelder, Rollbalken)
  root.style.colorScheme = t === 'dark' ? 'dark' : 'light'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[t])
  listeners.forEach((fn) => fn())
}

/** Wahl anwenden (ohne Übergang – ein Farbwechsel aller Flächen hat keinen Zweck) und lokal merken. */
export function applyTheme(pref: ThemePref): void {
  current = pref
  try {
    localStorage.setItem(THEME_KEY, pref)
  } catch {
    /* privat: nur für diese Sitzung */
  }
  paint()
  const m = media()
  if (m && !listening) {
    m.addEventListener('change', () => { if (current === 'system') paint() })
    listening = true
  }
}

export const THEME_LABEL: Record<ThemePref, string> = { light: 'Hell', dark: 'Dunkel', system: 'Wie das Gerät', win95: 'Windows 95' }
