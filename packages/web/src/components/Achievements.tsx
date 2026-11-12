import { useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import confetti from 'canvas-confetti'
import type { AchievementsDto } from '@airlock/shared'
import { api } from '../api.js'
import { fmtDate, isoOf } from '../lib/dates.js'
import { notifyOk } from '../lib/feedback.js'
import { useFunPrefs, useReducedMotion } from '../lib/fun.js'
import { useProjects } from '../lib/projects.js'
import { IconCheck } from './Icons.js'

/**
 * Etappe 7: Achievements. Der Server prüft die Regeln über die echten Daten
 * (domain/achievements.ts) und merkt sich, was schon gemeldet wurde.
 *
 * - AchievementWatcher (in der Shell): fragt nach, wenn ein Deploy fertig
 *   wird, und sonst jede Minute. Neu Erreichtes meldet er einmal: Meldung und
 *   Konfetti (nicht mit reduzierter Bewegung), danach «gesehen» auf dem
 *   Server – beim Neuladen kommt nichts zweimal.
 * - AchievementsSection: dezente Liste im Konto, mit Datum.
 *
 * Mit ausgeschalteten Spass-Funktionen: weder Liste noch Meldung noch Konfetti.
 */
export const achievementsKey = ['achievements'] as const

/**
 * Kein eigenes Polling (Anfragen-Budget, visual/anfragen.spec.ts): neu geprüft wird beim
 * Laden, wenn das Fenster wieder in den Vordergrund kommt und wenn sich in der Projektliste
 * etwas ändert, das ein Achievement auslösen kann (AchievementWatcher), sowie nach einer
 * Freischaltung (useUnlock).
 */
export function useAchievements(enabled: boolean) {
  return useQuery({ queryKey: achievementsKey, queryFn: api.achievements, enabled, staleTime: 5 * 60_000, refetchOnWindowFocus: true })
}

/**
 * Konfetti (canvas-confetti, ISC): eine eigene Leinwand, aria-hidden, nie
 * klickbar; Farben aus den Status-Tokens des Themes (kein Violett).
 * Bewegung (Emil): seltener Moment, also Freude erlaubt; einmal, rund 3 s.
 */
function celebrate(): void {
  const canvas = document.createElement('canvas')
  canvas.className = 'confetti-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  document.body.appendChild(canvas)
  const fire = confetti.create(canvas, { resize: true, useWorker: false, disableForReducedMotion: true })
  const css = getComputedStyle(document.documentElement)
  const colors = ['--ok', '--info', '--warn', '--bad', '--ink'].map((t) => css.getPropertyValue(t).trim()).filter(Boolean)
  void Promise.resolve(fire({ particleCount: 110, spread: 75, startVelocity: 42, origin: { x: 0.5, y: 0.65 }, colors, scalar: 0.9 }))
    .finally(() => { fire.reset(); canvas.remove() })
}

export function AchievementWatcher() {
  const qc = useQueryClient()
  const prefs = useFunPrefs()
  const reduced = useReducedMotion()
  const ach = useAchievements(prefs.fun)
  const projects = useProjects()
  // Ein Deploy wird fertig, ein Scan liefert eine Note, ein Projekt wird öffentlich: gleich nachsehen
  // (die Projektliste kommt über den Ereignisstrom, also ohne eigenes Polling)
  const deploySignature = useMemo(
    () => (projects.data?.projects ?? []).map((p) => [
      p?.lastDeployment?.id, p?.lastDeployment?.status, p?.security?.scanId, p?.security?.status, p?.security?.grade,
      (p?.routes ?? []).some((r) => r.target === 'public'),
    ].join(':')).join('|'),
    [projects.data],
  )
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (prefs.fun) void qc.invalidateQueries({ queryKey: achievementsKey })
  }, [deploySignature, prefs.fun, qc])

  const announced = useRef(new Set<string>())
  useEffect(() => {
    const data = ach.data
    if (!data?.enabled) return
    const fresh = data.achievements.filter((a) => a.achievedAt && !a.seen && !announced.current.has(a.id))
    if (!fresh.length) return
    fresh.forEach((a) => announced.current.add(a.id))
    for (const a of fresh) notifyOk(`Achievement: ${a.title}`, { id: `achievement-${a.id}`, description: a.description })
    if (!reduced) celebrate()
    const ids = fresh.map((a) => a.id)
    qc.setQueryData<AchievementsDto>(achievementsKey, (old) => (old ? { ...old, achievements: old.achievements.map((a) => (ids.includes(a.id) ? { ...a, seen: true } : a)) } : old))
    void api.achievementsSeen(ids).catch(() => { /* nächstes Mal wieder; die Meldung hier kam schon */ })
  }, [ach.data, reduced, qc])
  return null
}

const IconOpen = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /></svg>
)

export function AchievementsSection() {
  const prefs = useFunPrefs()
  const ach = useAchievements(prefs.fun)
  if (!prefs.fun || ach.data?.enabled === false) return null
  const list = ach.data?.achievements ?? []
  const done = list.filter((a) => a.achievedAt).length
  return (
    <section className="panel panel-pad section" aria-labelledby="ach-title">
      <h2 id="ach-title">Achievements <span className="muted findings-count">{ach.data ? `${done} von ${list.length}` : ''}</span></h2>
      {!ach.data && ach.isError && <p className="ach-off">Gerade nicht abrufbar.</p>}
      {ach.data && (
        <ul className="ach-list">
          {list.map((a) => (
            <li key={a.id} className={`ach-item ${a.achievedAt ? 'ach-done' : 'ach-open'}`}>
              <span className="ach-mark">{a.achievedAt ? <IconCheck /> : <IconOpen />}</span>
              <div>
                <div className="ach-title">{a.title}</div>
                <p className="ach-desc">{a.description}</p>
              </div>
              <span className="ach-date">
                {a.achievedAt ? <>erreicht <time dateTime={isoOf(a.achievedAt) ?? undefined}>{fmtDate(a.achievedAt)}</time></> : 'noch offen'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
