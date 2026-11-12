import {
  themeUnlocked,
  unlockIds,
  unlockIdSchema,
  unlockRequestSchema,
  uiPrefsPatchSchema,
  uiPrefsSchema,
  type ThemePref,
  type UiPrefs,
  type UiPrefsPatch,
  type UnlockId,
} from '@airlock/shared'
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
 *
 * Freischaltungen (Easter Eggs): Liste `unlocks` bekannter Kennungen. Sie
 * kommt nur über unlockUi dazu und geht nie weg. Altes Format
 * `win95Unlocked: true` wird beim Lesen zu `unlocks: ['win95']` (und beim
 * nächsten Speichern im neuen Format geschrieben).
 */
const KEY = 'ui_prefs'
export const DEFAULT_UI_PREFS: UiPrefs = { theme: 'system' }

/** Rein: gespeicherten Text lesen; Unbekanntes oder Kaputtes fällt auf den Standard zurück. */
export function parseUiPrefs(raw: string | null): UiPrefs {
  if (!raw) return DEFAULT_UI_PREFS
  try {
    const obj = JSON.parse(raw) as Record<string, unknown> | null
    // Feld für Feld: Ein kaputter Stand der Einrichtung kostet nicht die Wahl der Darstellung
    const theme = uiPrefsSchema.shape.theme.safeParse(obj?.theme)
    const setup = uiPrefsSchema.shape.setup.safeParse(obj?.setup)
    const unlocks = readUnlocks(obj)
    // Freischaltpflichtige Themes («Windows 95») nur mit Freischaltung; sonst gilt der Standard
    const out: UiPrefs = { theme: theme.success && themeUnlocked(theme.data, unlocks) ? theme.data : DEFAULT_UI_PREFS.theme }
    if (unlocks.length) out.unlocks = unlocks
    if (setup.success && setup.data) out.setup = setup.data
    // UI-Qualität 8: «Glocke gelesen bis» muss beim Lesen mitkommen, sonst ist nach jedem Neuladen alles wieder ungelesen
    const bell = uiPrefsSchema.shape.bellSeenAt.safeParse(obj?.bellSeenAt)
    if (bell.success && bell.data) out.bellSeenAt = bell.data
    // M9: zuletzt gewählte Umgebung
    const env = uiPrefsSchema.shape.lastEnvironment.safeParse(obj?.lastEnvironment)
    if (env.success && env.data) out.lastEnvironment = env.data
    // Etappe 7: Spass-Funktionen, Matrix-Regen, Disketti (nur gültige Werte; fehlt = Standard)
    for (const k of ['fun', 'matrix', 'disketti'] as const) {
      const v = uiPrefsSchema.shape[k].safeParse(obj?.[k])
      if (v.success && v.data !== undefined) out[k] = v.data
    }
    return out
  } catch {
    return DEFAULT_UI_PREFS
  }
}

/** Rein: Liste in fester Reihenfolge (wie unlockIds), ohne Doppelte und ohne Unbekanntes. */
export function normalizeUnlocks(ids: readonly unknown[]): UnlockId[] {
  return unlockIds.filter((id) => ids.includes(id))
}

/**
 * Rein: Freischaltungen aus dem gespeicherten Stand. Einzelne unbekannte
 * Kennungen fallen weg (z. B. nach dem Zurückgehen auf eine ältere Version),
 * der Rest bleibt. Altes Format: `win95Unlocked: true` → 'win95'.
 */
function readUnlocks(obj: Record<string, unknown> | null): UnlockId[] {
  const list: unknown[] = Array.isArray(obj?.unlocks) ? obj.unlocks.filter((id) => unlockIdSchema.safeParse(id).success) : []
  if (obj?.win95Unlocked === true) list.push('win95')
  return normalizeUnlocks(list)
}

export async function getUiPrefs(): Promise<UiPrefs> {
  return parseUiPrefs(await getSetting(KEY))
}

const THEME_NAME: Partial<Record<ThemePref, string>> = { win95: 'Windows 95', terminal: 'Terminal' }

/** Etappe 7: Spass-Funktionen an? (fehlt = an) */
export const funEnabled = (p: UiPrefs): boolean => p.fun !== false

function assertThemeUnlocked(theme: ThemePref, unlocks: readonly string[] | undefined): void {
  if (!themeUnlocked(theme, unlocks)) throw badRequest(`«${THEME_NAME[theme] ?? theme}» ist noch nicht freigeschaltet.`)
}

/**
 * Rein: Änderung mit dem Bestand zusammenführen. Ein Theme-Wechsel darf den
 * Stand der Einrichtung nicht löschen (und umgekehrt). Freischaltungen kommen
 * nicht über den Patch (dessen Schema kennt «unlocks» nicht); der Bestand bleibt.
 */
export function mergeUiPrefs(current: UiPrefs, patch: UiPrefsPatch): UiPrefs {
  const changes = Object.entries(patch).filter(([k, v]) => v !== undefined && k !== 'unlocks')
  const merged = uiPrefsSchema.parse({ ...current, ...Object.fromEntries(changes) })
  delete merged.unlocks
  if (current.unlocks?.length) merged.unlocks = normalizeUnlocks(current.unlocks)
  assertThemeUnlocked(merged.theme, merged.unlocks)
  return merged
}

/**
 * Rein: eine Freischaltung hinzufügen. Idempotent: Ist sie schon da, bleibt
 * die Liste gleich.
 */
export function addUnlock(current: UiPrefs, id: UnlockId): UiPrefs {
  return { ...current, unlocks: normalizeUnlocks([...(current.unlocks ?? []), id]) }
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
  // Etappe 7: Spass-Funktionen an/aus steht im Audit und schaltet das Spiel auf der
  // 404-Seite der internen Adressen (Caddy) mit
  if (funEnabled(prefs) !== funEnabled(before)) {
    await audit({ actor, action: 'ui.prefs', targetType: 'system', targetId: 'ui', params: { fun: funEnabled(prefs) }, result: 'ok' })
    const { reconcileCaddy } = await import('./routes.js')
    await reconcileCaddy().catch(() => { /* nächster Abgleich holt es nach */ })
  }
  return prefs
}

/**
 * Freischalten (POST /auth/unlocks): eine Kennung hinzufügen, idempotent.
 * Nur das erste Freischalten wird gespeichert und steht im Audit
 * (`ui.unlocked`, Kennung in params.id).
 */
export async function unlockUi(input: unknown, actor: string): Promise<UiPrefs> {
  const { id } = unlockRequestSchema.parse(input)
  const before = await getUiPrefs()
  if (before.unlocks?.includes(id)) return before
  const prefs = addUnlock(before, id)
  await setSetting(KEY, JSON.stringify(prefs))
  await audit({ actor, action: 'ui.unlocked', targetType: 'system', targetId: 'ui', params: { id }, result: 'ok' })
  return prefs
}
