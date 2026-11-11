import { uiPrefsPatchSchema, uiPrefsSchema, type UiPrefs, type UiPrefsPatch } from '@airlock/shared'
import { getSetting, setSetting } from '../db/index.js'
import { audit } from './audit.js'

/**
 * Darstellung der Oberfläche (Hell/Dunkel/System), auf dem Server gespeichert,
 * damit die Wahl auf jedem Gerät gilt. Airlock hat genau ein Konto: «pro
 * Nutzer» heisst die Wahl dieses Kontos.
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

/**
 * Rein: Änderung mit dem Bestand zusammenführen. Ein Theme-Wechsel darf den
 * Stand der Einrichtung nicht löschen (und umgekehrt).
 */
export function mergeUiPrefs(current: UiPrefs, patch: UiPrefsPatch): UiPrefs {
  return uiPrefsSchema.parse({ ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) })
}

export async function setUiPrefs(input: unknown, actor: string): Promise<UiPrefs> {
  const prefs = mergeUiPrefs(await getUiPrefs(), uiPrefsPatchSchema.parse(input))
  await setSetting(KEY, JSON.stringify(prefs))
  await audit({ actor, action: 'ui.prefs', targetType: 'system', targetId: 'ui', params: prefs, result: 'ok' })
  return prefs
}
