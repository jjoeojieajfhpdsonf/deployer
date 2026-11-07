/**
 * Benachrichtigungen: Ereignisse, Standard-Kanäle (SPEC) und Texte.
 * Reine Funktionen. Nachrichten enthalten nie Secrets: Sie bestehen aus
 * Projektnamen, Adressen, Befund-Titeln und Zahlen, und redact() entfernt
 * zusätzlich jeden Wert, der einem Secret eines Projekts gleicht.
 */

export const notifyEvents = [
  'deploy_failed',
  'finding_critical',
  'finding_high',
  'project_public',
  'external_verification_lost',
  'infra_problem',
  'expiry',
  'weekly_summary',
] as const
export type NotifyEvent = (typeof notifyEvents)[number]

export type Channel = 'push' | 'email'
export type Matrix = Record<NotifyEvent, Record<Channel, boolean>>

/** Standard laut SPEC; "expiry" (aus M3) per E-Mail, weil nicht dringend. */
export const DEFAULT_MATRIX: Matrix = {
  deploy_failed: { push: true, email: false },
  finding_critical: { push: true, email: true },
  finding_high: { push: false, email: true },
  project_public: { push: true, email: false },
  external_verification_lost: { push: false, email: true },
  infra_problem: { push: true, email: true },
  expiry: { push: false, email: true },
  weekly_summary: { push: false, email: true },
}

export const EVENT_LABEL: Record<NotifyEvent, string> = {
  deploy_failed: 'Deploy fehlgeschlagen',
  finding_critical: 'Neuer kritischer Befund',
  finding_high: 'Neuer hoher Befund',
  project_public: 'Projekt wurde öffentlich geschaltet',
  external_verification_lost: 'Besitznachweis einer externen Domain verloren',
  infra_problem: 'Tunnel oder Zertifikat mit Problem',
  expiry: 'Chat-Projekt läuft ab oder wurde gestoppt',
  weekly_summary: 'Wöchentliche Zusammenfassung',
}

export interface Message {
  title: string
  body: string
  /** ntfy-Priorität 1–5 */
  priority: number
}

export function mergeMatrix(stored: unknown): Matrix {
  const out = structuredClone(DEFAULT_MATRIX)
  if (stored && typeof stored === 'object') {
    for (const e of notifyEvents) {
      const v = (stored as Record<string, unknown>)[e] as Partial<Record<Channel, unknown>> | undefined
      if (v && typeof v === 'object') {
        if (typeof v.push === 'boolean') out[e].push = v.push
        if (typeof v.email === 'boolean') out[e].email = v.email
      }
    }
  }
  return out
}

/** Ersetzt jedes Vorkommen eines Secrets (ab 4 Zeichen) durch "***". */
export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets.filter((x) => x && x.length >= 4).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join('***')
  }
  return out
}

const PRIORITY: Record<NotifyEvent, number> = {
  deploy_failed: 4,
  finding_critical: 5,
  finding_high: 4,
  project_public: 4,
  external_verification_lost: 3,
  infra_problem: 5,
  expiry: 3,
  weekly_summary: 2,
}

export function renderMessage(event: NotifyEvent, data: Record<string, unknown>): Message {
  const s = (k: string) => String(data[k] ?? '')
  switch (event) {
    case 'deploy_failed':
      return { title: `Deploy fehlgeschlagen: ${s('project')}`, body: `${s('error')}\nDie vorherige Fassung läuft weiter.${data.url ? `\n${s('url')}` : ''}`, priority: PRIORITY[event] }
    case 'finding_critical':
    case 'finding_high': {
      const list = (data.findings as { title: string; location: string }[] | undefined) ?? []
      const word = event === 'finding_critical' ? 'kritische' : 'hohe'
      return {
        title: `${list.length} neue ${word} Befunde: ${s('target')}`,
        body: `${list.slice(0, 5).map((f) => `• ${f.title} (${f.location})`).join('\n')}${list.length > 5 ? `\n… und ${list.length - 5} weitere` : ''}\nScore ${s('score')} (${s('grade')})`,
        priority: PRIORITY[event],
      }
    }
    case 'project_public':
      return { title: `Öffentlich: ${s('project')}`, body: `${s('project')} ist jetzt öffentlich erreichbar unter ${s('url')}${data.actor ? ` (veranlasst von ${s('actor')})` : ''}.`, priority: PRIORITY[event] }
    case 'external_verification_lost':
      return { title: `Besitznachweis verloren: ${s('hostname')}`, body: `Der TXT-Eintrag für ${s('hostname')} fehlt. Die Domain wird nicht mehr gescannt, bis der Nachweis wieder stimmt.`, priority: PRIORITY[event] }
    case 'infra_problem':
      return { title: `Problem: ${s('what')}`, body: s('detail'), priority: PRIORITY[event] }
    case 'expiry':
      return { title: `${s('project')} ${data.stopped ? 'wurde gestoppt' : `läuft am ${s('date')} ab`}`, body: data.stopped ? `Das Chat-Projekt wurde nach ${s('days')} Tagen ohne Änderung gestoppt. Starten mit einem Klick oder per MCP (start).` : `Ohne Änderung wird das Chat-Projekt am ${s('date')} gestoppt. «Behalten» schaltet den Ablauf ab.`, priority: PRIORITY[event] }
    case 'weekly_summary':
      return { title: 'deployer: Wochenübersicht', body: s('text'), priority: PRIORITY[event] }
  }
}
