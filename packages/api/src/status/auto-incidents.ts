import { STATUS_AUTO_DOWN_MS } from '@airlock/shared'

/**
 * Etappe 5: automatische Störungen – rein, ohne Datenbank.
 *
 * Jede Minute kommt je Projekt auf der Statusseite eine Beobachtung. Ist ein
 * Projekt seit mindestens 5 Minuten ununterbrochen gestört und gibt es noch
 * keine offene automatische Störung dafür, wird eine angelegt. Läuft es
 * wieder, bekommt die offene automatische Störung das Update «behoben».
 * Absichtlich angehalten (gestoppt, öffentlich pausiert) ist keine Störung.
 */

export type Observed = 'up' | 'down' | 'paused' | 'unknown'

export interface Observation {
  projectId: string
  name: string
  state: Observed
}

export interface AutoPlan {
  /** Neuer Stand «gestört seit» je Projekt (ms) */
  downSince: Map<string, number>
  create: { projectId: string; name: string; since: number }[]
  resolve: { incidentId: string; projectId: string; name: string }[]
}

export function planAutoIncidents(o: {
  now: number
  observations: readonly Observation[]
  downSince: ReadonlyMap<string, number>
  /** Offene automatische Störungen (je Projekt höchstens eine) */
  openAuto: readonly { id: string; projectId: string }[]
  thresholdMs?: number
}): AutoPlan {
  const threshold = o.thresholdMs ?? STATUS_AUTO_DOWN_MS
  const downSince = new Map<string, number>()
  const plan: AutoPlan = { downSince, create: [], resolve: [] }
  const open = new Map(o.openAuto.map((i) => [i.projectId, i.id]))
  for (const ob of o.observations) {
    if (ob.state === 'down') {
      const since = o.downSince.get(ob.projectId) ?? o.now
      downSince.set(ob.projectId, since)
      if (o.now - since >= threshold && !open.has(ob.projectId)) plan.create.push({ projectId: ob.projectId, name: ob.name, since })
    } else if (ob.state === 'up') {
      const id = open.get(ob.projectId)
      if (id) plan.resolve.push({ incidentId: id, projectId: ob.projectId, name: ob.name })
    }
  }
  return plan
}

/** Texte der automatischen Einträge (keine Fehlertexte, keine Adressen) */
export const autoIncidentText = {
  title: (name: string) => `${name} nicht erreichbar`,
  body: (name: string) => `${name} ist seit mehr als 5 Minuten nicht erreichbar (automatisch erkannt).`,
  resolved: (name: string) => `${name} ist wieder erreichbar.`,
}
