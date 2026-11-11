/**
 * UI-Qualität 2: Warum ist ein Deploy gescheitert – in einem Satz, mit dem
 * man etwas anfangen kann, und mit der passenden Aktion. Eine Funktion für
 * Oberfläche (Fehlerbox) und MCP-Ergebnis von `deploy`, damit beide dasselbe
 * sagen. Grundlage: Fehlermeldung des Deployments und Deploy-Log (inklusive
 * der letzten Container-Ausgabe, die die Pipeline bei einem gescheiterten
 * Healthcheck anhängt). Was sich nicht zuordnen lässt: letzte Zeilen und
 * «Mit Claude lösen».
 */

export type FailureKind =
  | 'aborted'
  | 'image_missing'
  | 'policy'
  | 'source'
  | 'build_npm'
  | 'build_pip'
  | 'build'
  | 'oom'
  | 'env_missing'
  | 'port_mismatch'
  | 'listen_localhost'
  | 'exited'
  | 'health_http_4xx'
  | 'health_http_5xx'
  | 'health_refused'
  | 'health'
  | 'port_missing'
  | 'unknown'

/** Einstellung des Containers, die eine Aktion ändert */
export type ContainerField = 'port' | 'healthcheckPath' | 'memoryLimitMb'

export type FailureAction =
  /** Variable anlegen bzw. ändern (Name aus dem Log) */
  | { kind: 'add_env'; name: string; exists: boolean; label: string }
  /** Einstellung setzen; mit value in einem Schritt, ohne value mit Eingabefeld */
  | { kind: 'set_field'; field: ContainerField; value: number | string | null; label: string }
  /** Auftrag für Claude zum Kopieren */
  | { kind: 'claude'; label: string }
  /** Quelle ändern (Image, Repo) */
  | { kind: 'change_source'; label: string }
  | { kind: 'redeploy'; label: string }

export interface FailureExplanation {
  kind: FailureKind
  title: string
  cause: string
  action: FailureAction
  /** Die Zeilen, auf die es ankommt (Container-Ausgabe oder Ende des Logs), Zeit auf hh:mm:ss gekürzt */
  lines: string[]
  /** Woher die Zeilen stammen */
  linesFrom: 'container' | 'build' | 'deploy'
  exitCode: number | null
}

export interface FailureInput {
  message: string | null
  log: string
  port: number | null
  healthcheckPath?: string | null
  image?: string | null
  memoryLimitMb?: number | null
  /** Namen der gesetzten Umgebungsvariablen (zum Zeitpunkt des Deploys) */
  envKeys?: string[]
  /** Art der Quelle (image, dockerfile, compose, files, static) */
  sourceType?: string | null
  /** Fehlercode der Pipeline (AppError.code), z. B. policy_violation */
  errorCode?: string | null
}

const STAMP = /^\[(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z\] /
const CLAUDE: FailureAction = { kind: 'claude', label: 'Mit Claude lösen' }

/** Zeilen des Deploy-Logs; Folgezeilen ohne Zeitstempel gehören zur Zeile davor (z. B. Container-Ausgabe). */
interface Entry { head: string; body: string[] }

function entries(log: string): Entry[] {
  const out: Entry[] = []
  for (const raw of log.replace(/\s+$/, '').split('\n')) {
    if (STAMP.test(raw) || out.length === 0) out.push({ head: raw.replace(STAMP, ''), body: [] })
    else out[out.length - 1]!.body.push(raw)
  }
  return out
}

/** Letzte Container-Ausgabe, die die Pipeline nach einem gescheiterten Healthcheck anhängt */
function containerOutput(es: Entry[]): string[] {
  for (let i = es.length - 1; i >= 0; i--) {
    if (/^Letzte (?:Container-Ausgabe|Ausgabe von .+):$/.test(es[i]!.head)) return es[i]!.body.filter((l) => l.trim() !== '')
  }
  return []
}

/** Letzte n Zeilen, Zeitstempel auf die Uhrzeit gekürzt. */
export function logTail(log: string, n = 15): string[] {
  return log
    .replace(/\s+$/, '')
    .split('\n')
    .filter((l) => l !== '')
    .slice(-n)
    .map((l) => l.replace(STAMP, '$2  '))
}

const has = (s: string, ...needles: (string | RegExp)[]) =>
  needles.some((n) => (typeof n === 'string' ? s.toLowerCase().includes(n.toLowerCase()) : n.test(s)))

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,}$/
/** Hinweise und Warnungen sind kein Abbruchgrund («NODE_ENV is not set, defaulting to …») */
const NOT_FATAL = /\b(?:default(?:s|ing)?|warn(?:ing)?|using|fallback|optional)\b/i

/**
 * Name einer fehlenden Umgebungsvariable aus der Container-Ausgabe, sonst
 * null. Von unten nach oben: Der Abbruch steht am Ende, frühere Zeilen sind
 * oft nur Warnungen.
 */
export function missingEnvVar(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!
    if (NOT_FATAL.test(l)) continue
    // Python: KeyError nur, wenn der Traceback davor die Umgebung liest (os.environ['X'], getenv)
    const keyError = /KeyError:\s*['"]([A-Z][A-Z0-9_]+)['"]/.exec(l)?.[1]
    const fromEnviron = keyError && lines.slice(Math.max(0, i - 6), i).some((x) => /\benviron\b|getenv/.test(x)) ? keyError : undefined
    const hits = [
      // «Missing required environment variable: DATABASE_URL», «missing env var "X"»
      /(?:missing|required|undefined|unset)\s+(?:required\s+)?env(?:ironment)?[\s_-]*var(?:iable)?s?\s*[:=]?\s*["'`]?([A-Z][A-Z0-9_]+)/i.exec(l)?.[1],
      // «Environment variable DATABASE_URL is not set / is required / must be set»
      /env(?:ironment)?[\s_-]*var(?:iable)?\s+["'`]?([A-Z][A-Z0-9_]+)["'`]?\s+(?:is\s+)?(?:not\s+set|not\s+defined|missing|required|undefined|must\s+be\s+(?:set|defined|provided))/i.exec(l)?.[1],
      // «DATABASE_URL is not set», «DATABASE_URL must be set» (Name in Grossbuchstaben)
      /\b([A-Z][A-Z0-9]*_[A-Z0-9_]+|[A-Z]{3,})\s+(?:is\s+)?(?:not\s+set|must\s+be\s+(?:set|defined|provided)|is\s+(?:required|missing|undefined))\b/.exec(l)?.[1],
      // Python: os.environ['SECRET_KEY'] → KeyError: 'SECRET_KEY'
      fromEnviron,
    ].find((n): n is string => !!n && ENV_NAME.test(n))
    if (hits) return hits
    // envalid u. a.: «Missing environment variables:» und darunter die Namen
    if (/missing environment variables?:?\s*$/i.test(l)) {
      const next = /^\s*["'`]?([A-Z][A-Z0-9_]+)/.exec(lines[i + 1] ?? '')?.[1]
      if (next && ENV_NAME.test(next)) return next
    }
  }
  return null
}

/** Verbindungen zu anderen Diensten («Connected to Redis at redis:6379») sind nicht der eigene Port */
const OUTBOUND = /\b(?:connect(?:ed|ing)?|database|redis|postgres(?:ql)?|mongo(?:db)?|mysql|mariadb|amqp|rabbitmq|kafka|smtp|db)\b/i

/**
 * Worauf die App laut eigener Ausgabe lauscht, sonst null. Zeilen mit
 * «listen» haben Vorrang; Uhrzeiten («started at 12:30:45») und
 * Verbindungen zu anderen Diensten zählen nicht.
 */
export function listeningOn(lines: string[]): { host: string | null; port: number } | null {
  const re = /\b(?:listening|listen|running|started|serving|ready|available|server)\b[^\n]*?\b(?:on|at)\s+(?:port\s+)?(?:(?:https?:\/\/)?(\[[^\]]+\]|[\w.-]+):)?(\d{2,5})(?![\d:.])/i
  const pick = (only: (l: string) => boolean) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!
      if (!only(l) || OUTBOUND.test(l)) continue
      const m = re.exec(l)
      if (!m) continue
      const port = Number(m[2])
      if (port >= 80 && port < 65536) return { host: m[1] ?? null, port }
    }
    return null
  }
  return pick((l) => /listen/i.test(l)) ?? pick(() => true)
}

/** Einträge der Build-Phase: alles vor dem Start des Containers */
function buildEntries(es: Entry[]): Entry[] {
  const end = es.findIndex((e) => /^--- (?:starting|healthchecking) ---$|^Healthcheck gegen |^Letzte (?:Container-Ausgabe|Ausgabe von )/.test(e.head))
  return end < 0 ? es : es.slice(0, end)
}

/** Satz ohne doppelten Punkt am Ende */
const clause = (s: string) => s.replace(/[.\s]+$/, '')

const LOCAL_ONLY = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export function explainFailure(i: FailureInput): FailureExplanation {
  const msg = (i.message ?? '').trim()
  const es = entries(i.log)
  const out = containerOutput(es)
  const tail = logTail(i.log, 15).filter((l) => !/FEHLGESCHLAGEN:/.test(l))
  const exit = /Container beendet: Exit-Code (\d+)(.*)$/m.exec(i.log)
  const exitCode = exit ? Number(exit[1]) : null
  const oom = has(i.log, 'OOMKilled')
  const port = i.port ?? null
  const path = i.healthcheckPath || '/'
  const base = { exitCode }
  const fromContainer = out.length ? { lines: out.slice(-15), linesFrom: 'container' as const } : { lines: tail, linesFrom: 'deploy' as const }
  const fromBuild = { lines: tail, linesFrom: 'build' as const }
  const fromDeploy = { lines: tail, linesFrom: 'deploy' as const }

  if (has(msg, 'Abgebrochen durch Neustart')) {
    return { ...base, ...fromDeploy, kind: 'aborted', title: 'Deploy unterbrochen', cause: 'Airlock wurde während des Deploys neu gestartet. An der Quelle liegt es nicht; ein neuer Deploy sollte durchgehen.', action: { kind: 'redeploy', label: 'Erneut deployen' } }
  }
  // Image: nur die Fehlermeldung (der Pull), nie die Ausgabe der App («unauthorized: invalid api key»)
  if (has(msg, 'pull access denied', 'error from registry: denied', 'manifest unknown', 'not found: manifest', 'repository does not exist', /unauthorized: /i)) {
    const denied = has(msg, 'denied', 'unauthorized')
    if (i.sourceType && i.sourceType !== 'image') {
      // Basis-Image im Dockerfile (FROM) bzw. in der compose.yaml – zu ändern im Code, nicht in Airlock
      return {
        ...base, ...fromBuild, kind: 'image_missing',
        title: denied ? 'Zugriff auf ein Basis-Image verweigert' : 'Basis-Image nicht gefunden',
        cause: `Ein Image aus dem Dockerfile (FROM) oder der compose.yaml ${denied ? 'ist privat oder existiert so nicht' : 'gibt es so nicht – meist ist der Name oder der Tag falsch'}. Das lässt sich nur in der Quelle ändern.`,
        action: CLAUDE,
      }
    }
    return {
      ...base, ...fromDeploy, kind: 'image_missing',
      title: denied ? 'Zugriff auf das Image verweigert' : 'Image nicht gefunden',
      cause: denied
        ? `Die Registry gibt ${i.image ? `«${i.image}»` : 'das Image'} nicht heraus. Entweder gibt es das Image so nicht, oder es ist privat – private Images unterstützt Airlock nicht.`
        : `Die Registry kennt ${i.image ? `«${i.image}»` : 'das Image'} nicht. Meist ist der Name oder der Tag falsch geschrieben.`,
      action: { kind: 'change_source', label: 'Image ändern' },
    }
  }
  if (i.errorCode === 'policy_violation') {
    return { ...base, ...fromDeploy, kind: 'policy', title: 'Von der Container-Richtlinie gestoppt', cause: `${clause(msg)}.`, action: { kind: 'change_source', label: 'Quelle ändern' } }
  }
  if (has(msg, 'port setzen')) {
    return { ...base, ...fromDeploy, kind: 'port_missing', title: 'Port fehlt', cause: `${clause(msg.replace(/\s*\(port setzen\)\s*$/, ''))}. Ohne Port weiss Airlock nicht, wohin die Anfragen gehen.`, action: { kind: 'set_field', field: 'port', value: null, label: 'Port setzen' } }
  }
  // Build: npm/pnpm/yarn, pip, sonst allgemein. Nur Zeilen der Build-Phase – ein «npm start», das
  // beim Starten abstürzt, schreibt auch «npm error», ist aber kein Build-Fehler.
  const healthFailed = has(msg, 'Healthcheck nicht bestanden')
  const buildLines = healthFailed ? [] : buildEntries(es).map((e) => e.head)
  const npmLine = buildLines.find((l) => /\b(?:npm (?:ERR!|error)|ERR_PNPM_\w+|error Command failed)/.test(l) && !/npm (?:ERR!|error) (?:code|errno|path|command|signal|A complete log|\s*$)/.test(l))
  const pipLine = buildLines.find((l) => /ERROR: (?:Could not find a version|No matching distribution|Failed building wheel|Could not build wheels)|error: subprocess-exited-with-error/.test(l))
  const buildFailed = !healthFailed && has(msg, 'build', 'Dockerfile', 'returned a non-zero code', 'exit code')
  if (buildFailed || npmLine || pipLine) {
    if (npmLine) {
      const detail = clause(npmLine.replace(/^.*?\b(?:npm (?:ERR!|error)|error)\s*/, '').trim())
      return { ...base, ...fromBuild, kind: 'build_npm', title: 'npm-Build gescheitert', cause: `Beim Installieren oder Bauen mit npm ist ein Fehler aufgetreten${detail ? `: «${detail}»` : ''}.`, action: CLAUDE }
    }
    if (pipLine) {
      const detail = clause(pipLine.replace(/^.*?ERROR:\s*/, '').trim())
      return { ...base, ...fromBuild, kind: 'build_pip', title: 'pip-Installation gescheitert', cause: `pip konnte die Abhängigkeiten nicht installieren: «${detail}». Oft ist eine Version zu neu oder für diese Python-Version nicht verfügbar.`, action: CLAUDE }
    }
    if (buildFailed) {
      return { ...base, ...fromBuild, kind: 'build', title: 'Build gescheitert', cause: `Der Build ist abgebrochen: ${clause(msg.replace(/^Build fehlgeschlagen:\s*/, ''))}.`, action: CLAUDE }
    }
  }
  if (has(msg, /\bgit\b/i, 'clone', 'Repository', 'Branch', 'Commit nicht')) {
    return { ...base, ...fromDeploy, kind: 'source', title: 'Quelle nicht abrufbar', cause: `${clause(msg)}.`, action: { kind: 'change_source', label: 'Quelle ändern' } }
  }

  if (has(msg, 'Healthcheck nicht bestanden')) {
    if (oom) {
      return {
        ...base, ...fromContainer, kind: 'oom', title: 'Zu wenig Arbeitsspeicher',
        cause: `Docker hat den Container beendet, weil er mehr RAM brauchte als erlaubt${i.memoryLimitMb ? ` (Grenze ${i.memoryLimitMb.toLocaleString('de-CH')} MB)` : ''}.`,
        action: { kind: 'set_field', field: 'memoryLimitMb', value: null, label: 'Grenze erhöhen' },
      }
    }
    // Nur die Container-Ausgabe: Build-Zeilen sind keine Laufzeitfehler
    const env = missingEnvVar(out)
    if (env) {
      const t = envTexts(env, (i.envKeys ?? []).includes(env))
      return { ...base, ...fromContainer, kind: 'env_missing', ...t }
    }
    const listen = listeningOn(out)
    if (listen && port !== null && listen.port !== port) {
      return {
        ...base, ...fromContainer, kind: 'port_mismatch', title: `App lauscht auf Port ${listen.port}`,
        cause: `Laut ihrer Ausgabe lauscht die App auf Port ${listen.port}, Airlock fragt aber auf Port ${port} nach.`,
        action: { kind: 'set_field', field: 'port', value: listen.port, label: `Port ändern auf ${listen.port}` },
      }
    }
    if (listen && listen.host && LOCAL_ONLY.has(listen.host)) {
      return {
        ...base, ...fromContainer, kind: 'listen_localhost', title: 'App lauscht nur innerhalb des Containers',
        cause: `Die App lauscht auf ${listen.host}:${listen.port} und ist damit von aussen nicht erreichbar. Sie muss auf 0.0.0.0 lauschen.`,
        action: CLAUDE,
      }
    }
    if (exitCode !== null) {
      return {
        ...base, ...fromContainer, kind: 'exited', title: `Container hat sich beendet (Exit-Code ${exitCode})`,
        cause: exitCode === 137
          ? 'Der Container wurde von aussen beendet (Exit-Code 137) – meist, weil er zu viel Arbeitsspeicher brauchte. Die letzten Zeilen seiner Ausgabe stehen darunter.'
          : 'Der Container hat sich kurz nach dem Start beendet. Die Ursache steht meist in den letzten Zeilen seiner Ausgabe.',
        action: CLAUDE,
      }
    }
    const why = /Healthcheck nach \d+ Versuchen nicht bestanden \(([^)]*)\)/.exec(i.log)?.[1] ?? ''
    const http = /HTTP (\d{3})/.exec(why)?.[1]
    if (http?.startsWith('4')) {
      return {
        ...base, ...fromContainer, kind: 'health_http_4xx', title: 'Healthcheck-Pfad liefert einen Fehler',
        cause: `Die App läuft, aber ${path} antwortet mit HTTP ${http}. Der Healthcheck-Pfad muss mit 2xx oder 3xx antworten.`,
        action: { kind: 'set_field', field: 'healthcheckPath', value: null, label: 'Healthcheck-Pfad ändern' },
      }
    }
    if (http?.startsWith('5')) {
      return { ...base, ...fromContainer, kind: 'health_http_5xx', title: 'App startet mit Fehler', cause: `Die App antwortet auf ${path} mit HTTP ${http}. Sie läuft, kommt aber nicht richtig hoch.`, action: CLAUDE }
    }
    if (has(why, 'ECONNREFUSED')) {
      return {
        ...base, ...fromContainer, kind: 'health_refused', title: 'App antwortet nicht auf dem Port',
        cause: `Der Container läuft, aber auf Port ${port ?? '–'} nimmt niemand Verbindungen an. Meist lauscht die App auf einem anderen Port oder nur auf 127.0.0.1.`,
        action: { kind: 'set_field', field: 'port', value: null, label: 'Port ändern' },
      }
    }
    return { ...base, ...fromContainer, kind: 'health', title: 'Healthcheck nicht bestanden', cause: `Auf Port ${port ?? '–'} unter ${path} kam innerhalb von 60 Sekunden keine gültige Antwort${why ? ` (${why})` : ''}.`, action: CLAUDE }
  }

  return { ...base, ...fromDeploy, kind: 'unknown', title: 'Deploy fehlgeschlagen', cause: msg ? `${clause(msg)}.` : 'Keine Fehlermeldung gespeichert.', action: CLAUDE }
}

/**
 * Titel, Satz und Aktion für eine fehlende bzw. abgelehnte Variable – geteilt
 * von der Deploy-Fehlerbox und «Container läuft nicht» (gleiche Worte).
 */
export function envTexts(name: string, exists: boolean): { title: string; cause: string; action: FailureAction } {
  return exists
    ? { title: `Variable ${name} wird nicht akzeptiert`, cause: `Die App meldet ${name} als fehlend oder ungültig, obwohl die Variable gesetzt ist. Stimmt der Wert?`, action: { kind: 'add_env', name, exists, label: `${name} ändern` } }
    : { title: `Variable ${name} fehlt`, cause: `Die App braucht die Umgebungsvariable ${name} und startet ohne sie nicht.`, action: { kind: 'add_env', name, exists, label: `${name} hinzufügen` } }
}

/** Was Claude als Nächstes tun kann – in Worten, weil das MCP-Ergebnis keine Knöpfe hat */
export function failureNextStep(e: FailureExplanation): string {
  const a = e.action
  switch (a.kind) {
    case 'add_env': return a.exists
      ? `Wert der Umgebungsvariable ${a.name} in Airlock prüfen (Projekt › Einstellungen › Umgebung), dann neu deployen.`
      : `Umgebungsvariable ${a.name} in Airlock anlegen (Projekt › Einstellungen › Umgebung), dann neu deployen.`
    case 'set_field': {
      const what = a.field === 'port' ? 'Port' : a.field === 'healthcheckPath' ? 'Healthcheck-Pfad' : 'RAM-Grenze'
      return a.value !== null
        ? `${what} des Projekts in Airlock auf ${a.value} ändern (Fehlerbox der Projektseite), dann neu deployen.`
        : `${what} des Projekts in Airlock anpassen (Fehlerbox der Projektseite), dann neu deployen.`
    }
    case 'change_source': return 'Quelle des Projekts prüfen und korrigieren (Image-Name, Tag, Repo).'
    case 'redeploy': return 'Neu deployen (deploy).'
    case 'claude': return e.kind.startsWith('build')
      ? 'Den Build-Fehler im Code bzw. in den Abhängigkeiten beheben, dann neu deployen.'
      : 'Die Ursache aus den Zeilen ablesen und im Code beheben, dann neu deployen.'
  }
}

/** Auftrag für Claude zu einem gescheiterten Deploy (zum Kopieren) */
export function deployFixPrompt(o: { projectName: string; slug: string; sourceType: string; explanation: FailureExplanation }): string {
  const e = o.explanation
  const how =
    o.sourceType === 'files'
      ? 'Behebe die Ursache in den Dateien des Projekts mit update_files; Airlock deployt danach neu.'
      : o.sourceType === 'image'
        ? 'Das Projekt läuft aus einem fertigen Image. Sag mir, was am Image oder an den Einstellungen in Airlock zu ändern ist.'
        : 'Das Projekt kommt aus einem Git-Repo: Ändere es im Repo auf einem eigenen Branch, nie direkt auf dem Standard-Branch, und deploye danach mit deploy.'
  return [
    `Der letzte Deploy des Airlock-Projekts «${o.projectName}» (${o.slug}) ist gescheitert: ${e.title}.`,
    e.cause,
    e.lines.length ? `Letzte Zeilen (${{ container: 'Container-Ausgabe', build: 'Build-Log', deploy: 'Deploy-Log' }[e.linesFrom]}):\n${e.lines.join('\n')}` : '',
    `Weitere Angaben holst du dir mit dem Airlock-MCP: get_project und get_logs mit project "${o.slug}".`,
    how,
    'Erkläre kurz, was die Ursache war.',
  ].filter(Boolean).join('\n')
}
