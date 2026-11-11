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
    const obj = JSON.parse(raw) as Record<string, unknown>
    // Feld für Feld: Ein kaputter Stand der Einrichtung kostet nicht die Wahl der Darstellung
    const theme = uiPrefsSchema.shape.theme.safeParse(obj?.theme)
    const setup = uiPrefsSchema.shape.setup.safeParse(obj?.setup)
    const out: UiPrefs = { theme: theme.success ? theme.data : DEFAULT_UI_PREFS.theme }
    if (setup.success && setup.data) out.setup = setup.data
    // UI-Qualität 8: «Glocke gelesen bis» muss beim Lesen mitkommen, sonst ist nach jedem Neuladen alles wieder ungelesen
    const bell = uiPrefsSchema.shape.bellSeenAt.safeParse(obj?.bellSeenAt)
    if (bell.success && bell.data) out.bellSeenAt = bell.data
    return out
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

/**
 * Rein: «Glocke gelesen bis» nie in der Zukunft – ein Datum wie 9999 würde
 * die Glocke für immer stumm schalten.
 */
export function clampBellSeen(patch: UiPrefsPatch, now: Date): UiPrefsPatch {
  if (!patch.bellSeenAt || Date.parse(patch.bellSeenAt) <= now.getTime()) return patch
  return { ...patch, bellSeenAt: now.toISOString() }
}

export async function setUiPrefs(input: unknown, actor: string): Promise<UiPrefs> {
  const patch = clampBellSeen(uiPrefsPatchSchema.parse(input), new Date())
  const prefs = mergeUiPrefs(await getUiPrefs(), patch)
  await setSetting(KEY, JSON.stringify(prefs))
  // «Glocke gelesen» ist keine Einstellung, die jemand im Audit-Log sucht (und erzeugte bei jedem Öffnen einen Eintrag)
  const onlyBell = Object.keys(patch).every((k) => k === 'bellSeenAt')
  if (!onlyBell) await audit({ actor, action: 'ui.prefs', targetType: 'system', targetId: 'ui', params: prefs, result: 'ok' })
  return prefs
}
