/** Prototyp «cal»: alles unter /prototype nutzt das helle Theme (Branch design/cal-prototype). */
export const PROTO_BASE = '/prototype'

export const isPrototype = () =>
  typeof window !== 'undefined' && (window.location.pathname === PROTO_BASE || window.location.pathname.startsWith(`${PROTO_BASE}/`))

export type ProtoTheme = 'light' | 'dark'
const KEY = 'deployer.proto.theme'

/** ?theme=dark|light (für Screenshots) vor der gemerkten Wahl, sonst Hell. */
export function initialTheme(): ProtoTheme {
  const q = new URLSearchParams(window.location.search).get('theme')
  if (q === 'dark' || q === 'light') return q
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function applyTheme(t: ProtoTheme): void {
  document.documentElement.dataset.protoTheme = t
  document.documentElement.style.colorScheme = t
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* privat: nur für diese Sitzung */
  }
}
