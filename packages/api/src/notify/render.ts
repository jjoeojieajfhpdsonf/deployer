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
  // Meilenstein Backup, Etappe 2
  'backup_failed',
  'backup_stale',
  // Antwort 11: Caddy sieht Docker-Gateway-Adressen statt der Geräte (IP-Filter greift dann nicht)
  'gateway_warning',
  // Nacht 3, Etappe 3: Platte ab 90 % belegt (höchstens einmal pro Tag)
  'disk_space',
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
  // Ohne Backup fällt es erst auf, wenn man es braucht: beide Kanäle
  backup_failed: { push: true, email: true },
  backup_stale: { push: true, email: true },
  gateway_warning: { push: false, email: true },
  // Volle Platte stoppt Deploys und kann Datenbanken beschädigen: beide Kanäle
  disk_space: { push: true, email: true },
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
  backup_failed: 'Backup fehlgeschlagen',
  backup_stale: 'Seit über 48 Stunden kein erfolgreiches Backup',
  gateway_warning: 'Anfragen kommen über das Docker-Gateway',
  disk_space: 'Platte zu 90 % oder mehr belegt',
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
  backup_failed: 4,
  backup_stale: 4,
  gateway_warning: 3,
  disk_space: 4,
}

export function renderMessage(event: NotifyEvent, data: Record<string, unknown>): Message {
  const s = (k: string) => String(data[k] ?? '')
  switch (event) {
    case 'deploy_failed':
      return { title: `Deploy fehlgeschlagen: ${s('project')}`, body: `${s('error')}\nDie vorherige Fassung läuft weiter.${data.url ? `\n${s('url')}` : ''}`, priority: PRIORITY[event] }
    case 'finding_critical':
    case 'finding_high': {
      const list = (data.findings as { title: string; location: string }[] | undefined) ?? []
      const one = list.length === 1
      const word = event === 'finding_critical' ? (one ? 'neuer kritischer Befund' : 'neue kritische Befunde') : (one ? 'neuer hoher Befund' : 'neue hohe Befunde')
      return {
        title: `${list.length} ${word}: ${s('target')}`,
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
      return { title: 'Airlock: Wochenübersicht', body: s('text'), priority: PRIORITY[event] }
    case 'backup_failed':
      return {
        title: 'Backup fehlgeschlagen',
        body: `${data.trigger === 'manual' ? 'Die von Hand gestartete' : 'Die nächtliche'} Sicherung${data.target ? ` nach ${s('target')}` : ''} ist gescheitert:\n${s('error')}${data.lastSuccess ? `\nLetztes erfolgreiches Backup: ${s('lastSuccess')}` : '\nEs gibt noch kein erfolgreiches Backup.'}`,
        priority: PRIORITY[event],
      }
    case 'backup_stale':
      return {
        title: 'Seit über 48 Stunden kein Backup',
        body: `${data.lastSuccess ? `Das letzte erfolgreiche Backup ist vom ${s('lastSuccess')}.` : 'Es gibt noch kein erfolgreiches Backup.'}${data.lastError ? `\nLetzter Fehler: ${s('lastError')}` : ''}\nPrüfen unter Server › Backup.`,
        priority: PRIORITY[event],
      }
    case 'gateway_warning':
      return {
        title: 'Anfragen über das Docker-Gateway',
        body: `In den letzten 30 Minuten kamen ${s('fromGateway')} von ${s('total')} fremden Anfragen auf Airlock von ${s('ips')}. Caddy sieht dann nicht das Gerät, der IP-Filter greift nicht. Einzelheiten unter Server › Übersicht.`,
        priority: PRIORITY[event],
      }
    case 'disk_space':
      return {
        title: `Platte zu ${s('percent')} % belegt`,
        body: `Auf dem Server sind ${s('used')} von ${s('total')} belegt.${data.blocked ? ' Airlock nimmt keine Deploys mehr an (ab 95 %); Rollbacks gehen weiter.' : ' Ab 95 % nimmt Airlock keine Deploys mehr an.'}${data.reclaimable ? ` Das Aufräumen würde etwa ${s('reclaimable')} freigeben.` : ''}\nAufräumen unter Server › Speicher.`,
        priority: data.blocked ? 5 : PRIORITY[event],
      }
  }
}
