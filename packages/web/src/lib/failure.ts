import type { ProjectDto } from '@deployer/shared'

/**
 * Übersetzt, warum ein Deploy gescheitert ist, in einen Satz, mit dem man
 * etwas anfangen kann. Grundlage sind die Fehlermeldung und das Deploy-Log;
 * was sich nicht zuordnen lässt, bleibt die Originalmeldung.
 */
export interface Failure {
  title: string
  cause: string
  /** Wo man es behebt */
  fix: 'settings' | 'env' | 'source' | 'redeploy'
}

const has = (s: string, ...needles: (string | RegExp)[]) =>
  needles.some((n) => (typeof n === 'string' ? s.toLowerCase().includes(n.toLowerCase()) : n.test(s)))

export function explainDeployFailure(p: ProjectDto, message: string | null, log: string): Failure {
  const msg = message ?? ''
  const all = `${msg}\n${log}`
  const image = (p.source as { image?: string } | null)?.image

  if (has(msg, 'pull access denied', 'error from registry: denied', 'unauthorized', 'manifest unknown', 'not found: manifest', 'repository does not exist')) {
    return {
      title: 'Image liess sich nicht laden',
      cause: `Die Registry hat ${image ? `«${image}»` : 'das Image'} nicht herausgegeben: Es existiert nicht, der Tag ist falsch, oder das Image ist privat. Private Images unterstützt der deployer nicht.`,
      fix: 'source',
    }
  }
  if (has(msg, 'Healthcheck nicht bestanden')) {
    const m = /Healthcheck nach \d+ Versuchen nicht bestanden \(([^)]*)\)/.exec(log)
    const why = m?.[1] ?? ''
    const port = p.port ?? '–'
    const path = p.healthcheckPath ?? '/'
    if (has(why, 'ECONNREFUSED')) {
      return { title: 'App antwortet nicht auf dem Port', cause: `Der Container ist gestartet, aber auf Port ${port} nimmt niemand Verbindungen an. Meist lauscht die App auf einem anderen Port oder nur auf 127.0.0.1 statt 0.0.0.0.`, fix: 'settings' }
    }
    if (has(why, 'ENOTFOUND', 'EAI_AGAIN')) {
      return { title: 'Container hat sich beendet', cause: 'Der Container hat sich kurz nach dem Start wieder beendet, bevor der Healthcheck ihn erreichen konnte. Die Ursache steht meist in den letzten Zeilen der Ausgabe.', fix: 'env' }
    }
    const http = /HTTP (\d{3})/.exec(why)
    if (http && http[1]!.startsWith('4')) {
      return { title: 'Healthcheck-Pfad liefert einen Fehler', cause: `Die App läuft, aber ${path} antwortet mit HTTP ${http[1]}. Stimmt der Healthcheck-Pfad? Er muss mit 2xx oder 3xx antworten.`, fix: 'settings' }
    }
    if (http && http[1]!.startsWith('5')) {
      return { title: 'App startet mit Fehler', cause: `Die App antwortet auf ${path} mit HTTP ${http[1]}. Sie läuft, kommt aber nicht richtig hoch – oft fehlt eine Umgebungsvariable oder eine Datenbank.`, fix: 'env' }
    }
    return { title: 'Healthcheck nicht bestanden', cause: `Auf Port ${port} unter ${path} kam innerhalb von 60 Sekunden keine gültige Antwort${why ? ` (${why})` : ''}.`, fix: 'settings' }
  }
  if (has(msg, 'policy', 'Richtlinie') || has(all, 'policy_violation')) {
    return { title: 'Von der Container-Richtlinie gestoppt', cause: msg, fix: 'source' }
  }
  if (has(msg, 'build', 'Dockerfile', 'returned a non-zero code')) {
    return { title: 'Build gescheitert', cause: `Der Build ist abgebrochen: ${msg}. Die Zeilen darunter zeigen den letzten Schritt.`, fix: 'source' }
  }
  if (has(msg, 'git', 'clone', 'Repository')) {
    return { title: 'Quelle nicht abrufbar', cause: msg, fix: 'source' }
  }
  return { title: 'Deploy fehlgeschlagen', cause: msg || 'Keine Fehlermeldung gespeichert.', fix: 'redeploy' }
}

/** Letzte n Zeilen, Zeitstempel auf die Uhrzeit gekürzt. */
export function logTail(log: string, n = 15): string[] {
  return log
    .replace(/\s+$/, '')
    .split('\n')
    .slice(-n)
    .map((l) => l.replace(/^\[\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})\.\d+Z\] /, '$1  '))
}
