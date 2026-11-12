import { ACHIEVEMENTS, achievementIds, achievementsSeenSchema, unlockIds, type AchievementDto, type AchievementId, type AchievementsDto } from '@airlock/shared'
import { db, getSetting, pool, schema, setSetting } from '../db/index.js'
import { inArray, isNull, and } from 'drizzle-orm'
import { funEnabled, getUiPrefs } from './ui-prefs.js'

/**
 * Etappe 7: Achievements im Konto.
 *
 * Die Regeln sind reine Funktionen über Fakten, die aus der Datenbank kommen
 * (Deploys, Routen, Audit, Scans, Verfügbarkeit, Freischaltungen) – nichts
 * wird geschätzt. Ist eine Regel zum ersten Mal erfüllt, steht das
 * Achievement mit dem Zeitpunkt aus den Daten in der Tabelle `achievements`
 * und bleibt dort (eine Note A bleibt erreicht, auch wenn die Note später sinkt).
 *
 * «Gesehen» (seen_at) merkt der Server: Konfetti gibt es einmal beim
 * Erreichen, nicht bei jedem Neuladen. Was beim ersten Abgleich nach dem
 * Update schon erfüllt ist, gilt als gesehen (es wurde nicht «jetzt» erreicht).
 *
 * Vorschau-Projekte (Etappe 6) zählen nirgends mit.
 */

export interface UptimeDay {
  projectId: string
  /** YYYY-MM-DD (Zürcher Tag, wie status_daily) */
  day: string
  up: number
  down: number
  paused: number
}

export interface AchievementFacts {
  /** Ende erfolgreicher Deploys (aktiv geworden) */
  successfulDeploys: Date[]
  /** Start von Deploys, die eine Person ausgelöst hat (Oberfläche oder Token, nicht «system») */
  manualDeployStarts: Date[]
  /** Zeitpunkte, zu denen ein Projekt öffentlich wurde (Routen und Audit-Einträge) */
  publicSince: Date[]
  /** Ende fertiger Scans mit Note A */
  gradeAScans: Date[]
  /** Verfügbarkeit je Projekt und Tag (status_daily, gesammelt erst seit Etappe 5) */
  uptimeDays: UptimeDay[]
  /** Letzter fertiger Scan je gescanntem Projekt mit der Zahl offener Befunde */
  latestScans: { projectId: string; finishedAt: Date; open: number }[]
  /** Gab es bei diesen Projekten je einen Befund? (Sonst ist «alle behoben» nichts wert) */
  everHadFindings: boolean
  /** Freischaltungen des Kontos */
  unlocks: readonly string[]
  /** Zeit der letzten Freischaltung (Audit ui.unlocked); null = nicht bekannt */
  lastUnlockAt: Date | null
}

export const UPTIME_DAYS = 100
const ZONE = 'Europe/Zurich'

const earliest = (ds: Date[]): Date | null => (ds.length ? new Date(Math.min(...ds.map((d) => d.getTime()))) : null)

/** Rein: Stunde in Zürich (0–23) */
export function zurichHour(d: Date): number {
  // formatToParts: «de-CH» hängt sonst «Uhr» an
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', hourCycle: 'h23' }).formatToParts(d)
  return Number(parts.find((p) => p.type === 'hour')?.value ?? NaN)
}

/** Rein: Nachtschicht = Start zwischen 00:00 und 03:59 Zürcher Zeit (04:00 zählt nicht mehr) */
export const isNightShift = (d: Date): boolean => zurichHour(d) < 4

/** Rein: heutiger Tag in Zürich als YYYY-MM-DD */
export function zurichDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000)

/**
 * Rein: Ende (Tag) der ersten Strecke von `need` aufeinanderfolgenden,
 * abgeschlossenen Tagen ohne Störung bei einem Projekt. Ein Tag zählt nur,
 * wenn er gemessen wurde (erreichbar oder Wartung) und keine gestörte Minute
 * hat; ein Tag ohne Messung bricht die Strecke (nichts erfinden). Der
 * laufende Tag zählt erst, wenn er vorbei ist.
 */
export function uptimeStreakEnd(days: readonly UptimeDay[], today: string, need = UPTIME_DAYS): string | null {
  const byProject = new Map<string, UptimeDay[]>()
  for (const d of days) {
    if (d.day >= today) continue
    byProject.set(d.projectId, [...(byProject.get(d.projectId) ?? []), d])
  }
  let best: string | null = null
  for (const list of byProject.values()) {
    const sorted = [...list].sort((a, b) => a.day.localeCompare(b.day))
    let run = 0
    let prev: number | null = null
    for (const d of sorted) {
      const good = d.down === 0 && d.up + d.paused > 0
      const n = dayNumber(d.day)
      run = good ? (prev !== null && n === prev + 1 ? run + 1 : 1) : 0
      prev = good ? n : null
      if (run >= need) {
        if (best === null || d.day < best) best = d.day
        break
      }
    }
  }
  return best
}

/** Rein: Zeitpunkt, an dem jedes Achievement erfüllt ist (null = nicht erfüllt). */
export function evaluateAchievements(f: AchievementFacts, now: Date): Record<AchievementId, Date | null> {
  const streak = uptimeStreakEnd(f.uptimeDays, zurichDay(now))
  const scanned = f.latestScans
  const allFixed = f.everHadFindings && scanned.length > 0 && scanned.every((s) => s.open === 0)
  const secrets = unlockIds.every((id) => f.unlocks.includes(id))
  return {
    first_deploy: earliest(f.successfulDeploys),
    first_public: earliest(f.publicSince),
    grade_a: earliest(f.gradeAScans),
    // Mittag UTC des Tages: das Datum stimmt in Zürich
    uptime_100: streak ? new Date(`${streak}T12:00:00Z`) : null,
    // Der Scan, mit dem der letzte offene Befund weg war
    all_fixed: allFixed ? new Date(Math.max(...scanned.map((s) => s.finishedAt.getTime()))) : null,
    night_shift: earliest(f.manualDeployStarts.filter(isNightShift)),
    secrets: secrets ? f.lastUnlockAt ?? now : null,
  }
}

export interface StoredAchievement { id: string; achievedAt: Date; seenAt: Date | null }

/**
 * Rein: was neu in die Tabelle kommt. Schon gespeicherte bleiben (auch wenn
 * die Regel nicht mehr gilt). first: erster Abgleich nach dem Update – alles
 * als gesehen eintragen (kein Konfetti für Altes).
 */
export function newAchievements(evaluated: Record<AchievementId, Date | null>, stored: readonly StoredAchievement[], now: Date, first: boolean): StoredAchievement[] {
  const have = new Set(stored.map((s) => s.id))
  return achievementIds
    .filter((id) => !have.has(id) && evaluated[id])
    .map((id) => ({ id, achievedAt: evaluated[id]!, seenAt: first ? now : null }))
}

/** Rein: Liste für die Oberfläche in fester Reihenfolge */
export function achievementList(stored: readonly StoredAchievement[]): AchievementDto[] {
  return achievementIds.map((id) => {
    const s = stored.find((x) => x.id === id)
    return { id, ...ACHIEVEMENTS[id], achievedAt: s ? s.achievedAt.toISOString() : null, seen: Boolean(s?.seenAt) }
  })
}

/* --- Daten ------------------------------------------------------------------ */

const dates = (rows: { at: Date | string | null }[]) => rows.filter((r) => r.at).map((r) => new Date(r.at as Date))

export async function gatherFacts(): Promise<AchievementFacts> {
  const q = async <T extends Record<string, unknown>>(text: string) => (await pool.query<T>(text)).rows
  const notPreview = `p.preview_of IS NULL`
  const [deploys, manual, publicRoutes, publicAudit, gradeA, uptime, latest, ever, unlockAudit, prefs] = await Promise.all([
    q<{ at: Date }>(`SELECT d.finished_at AS at FROM deployments d JOIN projects p ON p.id = d.project_id
      WHERE ${notPreview} AND d.finished_at IS NOT NULL AND d.status IN ('active','superseded','rolled_back') ORDER BY d.finished_at LIMIT 1`),
    q<{ at: Date }>(`SELECT d.started_at AS at FROM deployments d JOIN projects p ON p.id = d.project_id
      WHERE ${notPreview} AND (d.actor LIKE 'ui:%' OR d.actor LIKE 'token:%')`),
    q<{ at: Date }>(`SELECT min(r.created_at) AS at FROM routes r JOIN projects p ON p.id = r.project_id WHERE ${notPreview} AND r.target = 'public'`),
    // Auch Projekte, die inzwischen wieder intern oder gelöscht sind: das Audit weiss es
    q<{ at: Date }>(`SELECT min(at) AS at FROM audit_events WHERE result = 'ok' AND (
      action = 'public.request.approve' OR (action = 'project.routes.set' AND params_masked -> 'targets' ? 'public'))`),
    q<{ at: Date }>(`SELECT min(s.finished_at) AS at FROM scan_runs s JOIN projects p ON p.id = s.project_id
      WHERE ${notPreview} AND s.status = 'done' AND s.grade = 'A' AND s.finished_at IS NOT NULL`),
    q<{ project_id: string; day: string; up_minutes: number; down_minutes: number; paused_minutes: number }>(
      `SELECT sd.project_id, sd.day::text AS day, sd.up_minutes, sd.down_minutes, sd.paused_minutes FROM status_daily sd
       JOIN projects p ON p.id = sd.project_id WHERE ${notPreview}`),
    q<{ project_id: string; finished_at: Date; open: string }>(
      `SELECT DISTINCT ON (s.project_id) s.project_id, s.finished_at,
         (SELECT count(*) FROM findings f WHERE f.scan_run_id = s.id AND f.status = 'open') AS open
       FROM scan_runs s JOIN projects p ON p.id = s.project_id
       WHERE ${notPreview} AND s.status = 'done' AND s.finished_at IS NOT NULL
       ORDER BY s.project_id, s.finished_at DESC`),
    q<{ n: string }>(`SELECT count(*) AS n FROM findings f JOIN scan_runs s ON s.id = f.scan_run_id JOIN projects p ON p.id = s.project_id WHERE ${notPreview}`),
    q<{ at: Date }>(`SELECT max(at) AS at FROM audit_events WHERE action = 'ui.unlocked' AND result = 'ok'`),
    getUiPrefs(),
  ])
  return {
    successfulDeploys: dates(deploys),
    manualDeployStarts: dates(manual),
    publicSince: [...dates(publicRoutes), ...dates(publicAudit)],
    gradeAScans: dates(gradeA),
    uptimeDays: uptime.map((r) => ({ projectId: r.project_id, day: r.day, up: r.up_minutes, down: r.down_minutes, paused: r.paused_minutes })),
    latestScans: latest.map((r) => ({ projectId: r.project_id, finishedAt: new Date(r.finished_at), open: Number(r.open) })),
    everHadFindings: Number(ever[0]?.n ?? 0) > 0,
    unlocks: prefs.unlocks ?? [],
    lastUnlockAt: dates(unlockAudit)[0] ?? null,
  }
}

const STARTED_KEY = 'achievements_started'

/** Regeln prüfen, Neues eintragen, Liste zurück. Aus: leere Liste, nichts wird geprüft. */
export async function syncAchievements(now = new Date()): Promise<AchievementsDto> {
  const prefs = await getUiPrefs()
  if (!funEnabled(prefs)) return { achievements: [], enabled: false }
  const first = !(await getSetting(STARTED_KEY))
  const stored = await db.select().from(schema.achievements)
  const fresh = newAchievements(evaluateAchievements(await gatherFacts(), now), stored, now, first)
  if (fresh.length) await db.insert(schema.achievements).values(fresh).onConflictDoNothing()
  if (first) await setSetting(STARTED_KEY, now.toISOString())
  return { achievements: achievementList([...stored, ...fresh]), enabled: true }
}

/** Gemeldet (Konfetti gezeigt): nicht noch einmal */
export async function markAchievementsSeen(input: unknown): Promise<{ ok: true }> {
  const { ids } = achievementsSeenSchema.parse(input)
  await db.update(schema.achievements).set({ seenAt: new Date() })
    .where(and(inArray(schema.achievements.id, ids), isNull(schema.achievements.seenAt)))
  return { ok: true }
}
