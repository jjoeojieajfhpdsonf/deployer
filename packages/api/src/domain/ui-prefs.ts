import { uiPrefsSchema, type UiPrefs } from '@airlock/shared'
import { getSetting, setSetting } from '../db/index.js'
import { audit } from './audit.js'

/**
 * Darstellung der Oberfläche (Hell/Dunkel/System), auf dem Server gespeichert,
 * damit die Wahl auf jedem Gerät gilt. Airlock hat genau ein Konto: «pro
 * Nutzer» heisst die Wahl dieses Kontos.
 *
 * M9: dazu die zuletzt gewählte Umgebung. Eine Änderung nur daran steht
 * nicht im Audit (jeder Wechsel der Umgebung wäre sonst ein Eintrag).
 */
const KEY = 'ui_prefs'
export const DEFAULT_UI_PREFS: UiPrefs = { theme: 'system' }

/** Rein: gespeicherten Text lesen; Unbekanntes oder Kaputtes fällt auf den Standard zurück. */
export function parseUiPrefs(raw: string | null): UiPrefs {
  if (!raw) return DEFAULT_UI_PREFS
  try {
    const r = uiPrefsSchema.safeParse(JSON.parse(raw))
    return r.success ? r.data : DEFAULT_UI_PREFS
  } catch {
    return DEFAULT_UI_PREFS
  }
}

export async function getUiPrefs(): Promise<UiPrefs> {
  return parseUiPrefs(await getSetting(KEY))
}

/** Teilweise ändern: fehlende Felder bleiben, wie sie sind. */
export async function setUiPrefs(input: unknown, actor: string): Promise<UiPrefs> {
  const patch = uiPrefsSchema.partial().parse(input)
  const before = await getUiPrefs()
  const prefs = uiPrefsSchema.parse({ ...before, ...patch })
  await setSetting(KEY, JSON.stringify(prefs))
  if (patch.theme !== undefined && patch.theme !== before.theme) {
    await audit({ actor, action: 'ui.prefs', targetType: 'system', targetId: 'ui', params: { theme: prefs.theme }, result: 'ok' })
  }
  return prefs
}
