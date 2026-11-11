import { uiPrefsPatchSchema, uiPrefsSchema, type UiPrefs, type UiPrefsPatch } from '@airlock/shared'
import { getSetting, setSetting } from '../db/index.js'
import { audit } from './audit.js'
import { badRequest } from '../lib/errors.js'

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
    const obj = JSON.parse(raw) as Record<string, unknown>
    // Feld für Feld: Ein kaputter Stand der Einrichtung kostet nicht die Wahl der Darstellung
    const theme = uiPrefsSchema.shape.theme.safeParse(obj?.theme)
    const setup = uiPrefsSchema.shape.setup.safeParse(obj?.setup)
    const unlocked = obj?.win95Unlocked === true
    // «Windows 95» nur mit Freischaltung; sonst gilt der Standard
    const out: UiPrefs = { theme: theme.success && (theme.data !== 'win95' || unlocked) ? theme.data : DEFAULT_UI_PREFS.theme }
    if (unlocked) out.win95Unlocked = true
    if (setup.success && setup.data) out.setup = setup.data
    // UI-Qualität 8: «Glocke gelesen bis» muss beim Lesen mitkommen, sonst ist nach jedem Neuladen alles wieder ungelesen
    const bell = uiPrefsSchema.shape.bellSeenAt.safeParse(obj?.bellSeenAt)
    if (bell.success && bell.data) out.bellSeenAt = bell.data
    // M9: zuletzt gewählte Umgebung
    const env = uiPrefsSchema.shape.lastEnvironment.safeParse(obj?.lastEnvironment)
    if (env.success && env.data) out.lastEnvironment = env.data
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
  const merged = uiPrefsSchema.parse({ ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) })
  // Die Freischaltung bleibt: «false» nimmt sie nicht zurück (und fällt aus dem Stand)
  if (current.win95Unlocked) merged.win95Unlocked = true
  else if (!merged.win95Unlocked) delete merged.win95Unlocked
  if (merged.theme === 'win95' && !merged.win95Unlocked) throw badRequest('«Windows 95» ist noch nicht freigeschaltet.')
  return merged
}

/**
 * Rein: «Glocke gelesen bis» nie in der Zukunft – ein Datum wie 9999 würde
 * die Glocke für immer stumm schalten.
 */
export function clampBellSeen(patch: UiPrefsPatch, now: Date): UiPrefsPatch {
  if (!patch.bellSeenAt || Date.parse(patch.bellSeenAt) <= now.getTime()) return patch
  return { ...patch, bellSeenAt: now.toISOString() }
}

/** Teilweise ändern: fehlende Felder bleiben, wie sie sind. */
export async function setUiPrefs(input: unknown, actor: string): Promise<UiPrefs> {
  const patch = clampBellSeen(uiPrefsPatchSchema.parse(input), new Date())
  const before = await getUiPrefs()
  const prefs = mergeUiPrefs(before, patch)
  await setSetting(KEY, JSON.stringify(prefs))
  // Ins Audit nur ein Theme-Wechsel (M9); «Glocke gelesen», Einrichtung und
  // zuletzt gewählte Umgebung sucht niemand im Audit-Log
  if (patch.theme !== undefined && patch.theme !== before.theme) {
    await audit({ actor, action: 'ui.prefs', targetType: 'system', targetId: 'ui', params: { theme: prefs.theme }, result: 'ok' })
  }
  if (prefs.win95Unlocked && !before.win95Unlocked) {
    await audit({ actor, action: 'ui.win95_unlocked', targetType: 'system', targetId: 'ui', params: {}, result: 'ok' })
  }
  return prefs
}
