import type { IncidentKind, IncidentSeverity, IncidentSource } from '@airlock/shared'
import { severityRank } from '@airlock/shared'

/**
 * Nacht 3, Etappe 5: Bewertung der Hinweise – reine Funktionen ohne
 * Datenbank, Docker oder Uhr (Zeit kommt als Argument), damit sie sich
 * einzeln testen lassen (rules.test.ts). Was eine Funktion zurückgibt, ist
 * ein «Hinweis» (Signal); gebündelt zu Vorfällen wird in bundle.ts.
 *
 * Grundsatz gegen Falsch-Positive: Was ein Container in seinen ersten
 * 10 Minuten tut (Programme, geschriebene Dateien), gilt als seine
 * Grundlinie. Gemeldet wird nur, was danach neu dazukommt – mit Ausnahme
 * von Krypto-Minern, die nie zur Grundlinie gehören.
 */

export interface Signal {
  /** null = Server (Anmeldung) */
  projectId: string | null
  source: IncidentSource
  kind: IncidentKind
  severity: IncidentSeverity
  /** Bündelungsschlüssel innerhalb von Projekt und Art (z. B. Dienst + Programm, Adresse) */
  key: string
  title: string
  subject: string | null
  service: string | null
  /** Neue Vorkommen seit dem letzten Mal */
  count: number
  /** Beim Anlegen eines Vorfalls stattdessen (z. B. alle Fehlversuche im Fenster) */
  initialCount?: number
  /** Beispiele: Befehlszeilen, Pfade, Ziele */
  samples: string[]
  at: Date
}

/** Ein Vorfall je Fingerabdruck, solange er nicht erledigt ist */
export const fingerprintOf = (s: Pick<Signal, 'projectId' | 'kind' | 'key'>): string => `${s.projectId ?? 'server'}|${s.kind}|${s.key}`

export const maxSeverity = (a: IncidentSeverity, b: IncidentSeverity): IncidentSeverity => (severityRank(a) >= severityRank(b) ? a : b)

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const serviceText = (service: string | null) => (service ? ` (Dienst ${service})` : '')

/* --- Prozesse (docker top) ---------------------------------------------------------- */

/** Shells: in einem Web-Container ohne Shell in der Grundlinie ein starkes Indiz */
export const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'ash', 'dash', 'zsh', 'ksh', 'mksh', 'busybox'])
/** Werkzeuge für Verbindungen nach draussen bzw. Reverse-Shells */
export const NET_TOOLS: ReadonlySet<string> = new Set(['nc', 'ncat', 'netcat', 'socat', 'curl', 'wget', 'telnet'])
/** Bekannte Krypto-Miner und ihre Tarnnamen – immer kritisch, nie Teil der Grundlinie */
export const MINER_RE = /^(xmrig.*|xmr-stak.*|minerd|cpuminer.*|ccminer|cgminer|bfgminer|ethminer|nbminer|lolminer|t-rex|teamredminer|phoenixminer|nanominer|srbminer.*|kdevtmpfsi|kinsing|kthreaddi|cryptonight|minexmr)$/i
/** Programme, die von hier gestartet werden, sind fast immer nachgeladen */
export const TMP_DIRS = ['/tmp/', '/var/tmp/', '/dev/shm/']

/**
 * Programmname aus der Spalte CMD von «docker top» (ps -ef): erstes Wort,
 * ohne Pfad, ohne «-» der Login-Shell und ohne «:» von Prozesstiteln wie
 * «nginx: master process». Kernel-Threads («[kworker]») ergeben null.
 */
export function programOf(cmd: string): string | null {
  const s = cmd.trim()
  if (!s || s.startsWith('[')) return null
  const first = s.split(/\s+/)[0]!
  const base = (first.split('/').pop() ?? '').replace(/:$/, '').replace(/^-/, '')
  return base ? base.slice(0, 64) : null
}

/** Pfad des Programms, wenn die Befehlszeile mit einem absoluten Pfad beginnt */
export const executablePath = (cmd: string): string | null => {
  const first = cmd.trim().split(/\s+/)[0] ?? ''
  return first.startsWith('/') ? first : null
}

export type ProcessClass = 'miner' | 'tmp' | 'verdaechtig' | 'neu'

/** Einordnung eines Programms, das nicht in der Grundlinie steht */
export function classifyProgram(program: string, cmd: string): ProcessClass {
  if (MINER_RE.test(program)) return 'miner'
  const path = executablePath(cmd)
  if (path && TMP_DIRS.some((d) => path.startsWith(d))) return 'tmp'
  if (SHELLS.has(program) || NET_TOOLS.has(program)) return 'verdaechtig'
  return 'neu'
}

export interface TopProcess { pid: string; cmd: string }

/** Spalten von «docker top» lesen (Titel unterscheiden sich je nach ps) */
export function parseTop(top: { Titles?: string[]; Processes?: string[][] } | null | undefined): TopProcess[] {
  const titles = top?.Titles ?? []
  const pidAt = titles.findIndex((t) => t.toUpperCase() === 'PID')
  const cmdAt = titles.findIndex((t) => ['CMD', 'COMMAND', 'ARGS'].includes(t.toUpperCase()))
  if (pidAt < 0 || cmdAt < 0) return []
  return (top?.Processes ?? []).map((row) => ({ pid: String(row[pidAt] ?? ''), cmd: String(row.slice(cmdAt).join(' ') ?? '') }))
}

/**
 * Programme, die der Healthcheck eines Images startet (HEALTHCHECK CMD …).
 * Sie laufen nur kurz alle paar Sekunden und fallen beim Lernen leicht durch
 * das Raster – darum gehören sie von Anfang an zur Grundlinie.
 */
export function healthcheckPrograms(test: string[] | null | undefined): string[] {
  if (!test?.length) return []
  const [mode, ...rest] = test
  if (mode === 'NONE') return []
  const out = new Set<string>()
  if (mode === 'CMD') {
    const p = programOf(rest[0] ?? '')
    if (p) out.add(p)
  } else if (mode === 'CMD-SHELL') {
    out.add('sh')
    for (const part of (rest.join(' ') || '').split(/\|\||&&|[;|]/)) {
      const p = programOf(part)
      if (p && !/^[A-Z_]+=/.test(p)) out.add(p)
    }
  }
  return [...out]
}

export interface ProcessInput {
  projectId: string
  service: string | null
  processes: TopProcess[]
  /** Programme der Grundlinie dieses Containers */
  learned: ReadonlySet<string>
  /** Vom Benutzer als normal markiert (Projekt, für diesen Dienst oder alle) */
  allowed: ReadonlySet<string>
  /** Container lernt noch (erste 10 Minuten) */
  learning: boolean
  /** Schon gezählt: «programm:pid» */
  reported: ReadonlySet<string>
  at: Date
}

export interface ProcessResult {
  /** Neu in die Grundlinie (nur beim Lernen) */
  learn: string[]
  signals: Signal[]
  /** Jetzt gezählt: «programm:pid» */
  reported: string[]
}

const PROCESS_KIND: Record<ProcessClass, { kind: IncidentKind; severity: IncidentSeverity }> = {
  miner: { kind: 'prozess_miner', severity: 'kritisch' },
  tmp: { kind: 'prozess_aus_tmp', severity: 'kritisch' },
  verdaechtig: { kind: 'prozess_verdaechtig', severity: 'hoch' },
  neu: { kind: 'prozess_neu', severity: 'mittel' },
}

function processTitle(c: ProcessClass, program: string, service: string | null): string {
  const s = serviceText(service)
  if (c === 'miner') return `Krypto-Miner läuft: ${program}${s}`
  if (c === 'tmp') return `Programm aus einem temporären Ordner: ${program}${s}`
  if (c === 'verdaechtig') return `${SHELLS.has(program) ? 'Shell gestartet' : 'Netzwerk-Werkzeug gestartet'}: ${program}${s}`
  return `Neues Programm: ${program}${s}`
}

/** Prozesse eines Containers gegen seine Grundlinie */
export function evaluateProcesses(i: ProcessInput): ProcessResult {
  const learn = new Set<string>()
  const reported: string[] = []
  const hits = new Map<string, { c: ProcessClass; pids: number; samples: string[] }>()
  for (const p of i.processes) {
    const program = programOf(p.cmd)
    if (!program) continue
    const c = classifyProgram(program, p.cmd)
    const known = i.learned.has(program) || i.allowed.has(program)
    if (c !== 'miner') {
      if (i.learning) {
        if (!i.learned.has(program)) learn.add(program)
        continue
      }
      if (known) continue
    }
    const tag = `${program}:${p.pid}`
    if (i.reported.has(tag)) continue
    reported.push(tag)
    const h = hits.get(program) ?? { c, pids: 0, samples: [] }
    h.pids++
    if (h.samples.length < 5) h.samples.push(clip(p.cmd))
    hits.set(program, h)
  }
  const signals: Signal[] = [...hits].map(([program, h]) => ({
    projectId: i.projectId,
    source: 'prozess',
    ...PROCESS_KIND[h.c],
    key: `${i.service ?? ''}|${program}`,
    title: processTitle(h.c, program, i.service),
    subject: program,
    service: i.service,
    count: h.pids,
    samples: h.samples,
    at: i.at,
  }))
  return { learn: [...learn], signals, reported }
}

/* --- Dateien im Container (docker diff) ------------------------------------------------ */

/** Docker: 0 = geändert, 1 = neu, 2 = gelöscht */
export interface FsChange { path: string; kind: 0 | 1 | 2 }

/** Ändert sich im Betrieb ständig und sagt nichts (Laufzeit, Caches, Logs) */
export const NOISE_PREFIXES = [
  '/proc/', '/sys/', '/dev/', '/run/', '/var/run/', '/var/cache/', '/var/log/', '/var/lib/nginx/', '/var/lib/apt/lists/',
  '/root/.cache/', '/root/.npm/', '/root/.config/', '/home/node/.npm/', '/home/node/.cache/', '/.npm/', '/.cache/',
  '/var/lib/postgresql/', '/var/lib/mysql/', '/data/', '/tmp/', '/var/tmp/',
]
/** Hier liegen Programme */
export const BIN_DIRS = ['/bin/', '/sbin/', '/usr/bin/', '/usr/sbin/', '/usr/local/bin/', '/usr/local/sbin/', '/usr/libexec/']
/** Übliche Webroots in Images (nginx, Apache, Caddy, PHP) */
export const WEBROOT_PREFIXES = ['/usr/share/nginx/html/', '/usr/local/apache2/htdocs/', '/var/www/', '/srv/http/', '/usr/share/caddy/', '/srv/www/']
/** Dateien, deren Änderung auf Festsetzen hindeutet (Benutzer, Rechte, Autostart, Vorladen) */
export const SENSITIVE = [
  '/etc/passwd', '/etc/shadow', '/etc/group', '/etc/gshadow', '/etc/sudoers', '/etc/sudoers.d/', '/etc/crontab', '/etc/cron.',
  '/etc/ld.so.preload', '/etc/profile', '/etc/profile.d/', '/etc/ssh/', '/etc/init.d/', '/etc/rc.local', '/root/.ssh/',
  '/etc/bash.bashrc', '/root/.bashrc', '/root/.profile', '/var/spool/cron/',
]
/** Diese Orte gelten erst als Änderung, wenn sie nicht schon in der Grundlinie stehen */
const SYSTEM_PREFIXES = ['/etc/', '/usr/', '/lib/', '/lib64/', '/opt/']

const under = (path: string, prefixes: readonly string[]) => prefixes.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p))
export const dirOf = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf('/')))

/**
 * Nur die echten Änderungen: Docker meldet jeden Elternordner einer neuen
 * Datei als «geändert» – die fallen weg, ebenso Laufzeit-Orte und Caches.
 */
export function meaningfulChanges(changes: readonly FsChange[]): FsChange[] {
  return leaves(changes).filter((c) => c.path.startsWith('/') && !under(`${c.path}/`, NOISE_PREFIXES) && !under(c.path, NOISE_PREFIXES))
}

/** Nur Blätter: ein Ordner mit geänderten oder neuen Einträgen darin sagt nichts Zusätzliches */
function leaves(changes: readonly FsChange[]): FsChange[] {
  const paths = changes.map((c) => c.path).sort()
  const isParent = (p: string) => {
    // sortiert: ein Kind steht direkt hinter dem Elternordner (oder später mit gleichem Präfix)
    const prefix = `${p}/`
    let lo = 0
    let hi = paths.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (paths[mid]! < prefix) lo = mid + 1
      else hi = mid
    }
    return lo < paths.length && paths[lo]!.startsWith(prefix)
  }
  return changes.filter((c) => !isParent(c.path))
}

/**
 * Neue Dateien, deren Rechte Airlock nachsehen soll (ausführbar?). Zuerst
 * Orte, an die Angreifer gern ablegen; höchstens limit.
 */
export function execCandidates(changes: readonly FsChange[], known: (path: string) => boolean, limit = 30): string[] {
  const added = changes.filter((c) => c.kind === 1 && !known(c.path)).map((c) => c.path)
  const rank = (p: string) => (/^\/(tmp|var\/tmp|dev\/shm|root|home)\//.test(p) ? 0 : under(p, WEBROOT_PREFIXES) ? 1 : 2)
  return added.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, limit)
}

/** Alle neuen Dateien, auch an lauten Orten – für die Prüfung auf ausführbar */
export function addedFiles(changes: readonly FsChange[]): FsChange[] {
  return leaves(changes).filter((c) => c.kind === 1 && c.path.startsWith('/') && !/^\/(proc|sys|dev\/(?!shm\/))/.test(c.path))
}

export interface FileInput {
  projectId: string
  service: string | null
  /** Ausgabe von docker diff */
  changes: FsChange[]
  /** Grundlinie: Pfade, die der Container beim Lernen geändert hat */
  learned: ReadonlySet<string>
  learning: boolean
  /** Als normal markiert: Pfade bzw. Ordner (mit «/» am Ende) des Projekts */
  allowed: readonly string[]
  /** Schon gemeldet */
  reported: ReadonlySet<string>
  /** Ergebnis der Rechte-Prüfung: Pfad → ausführbar */
  exec: ReadonlyMap<string, boolean>
  at: Date
}

export interface FileResult {
  learn: string[]
  signals: Signal[]
  reported: string[]
}

type FileClass = 'datei_ausfuehrbar' | 'datei_programm' | 'datei_webroot' | 'datei_system'

const FILE_TITLE: Record<FileClass, string> = {
  datei_ausfuehrbar: 'Neue ausführbare Datei',
  datei_programm: 'Programm-Ordner geändert',
  datei_webroot: 'Dateien im Webroot geändert',
  datei_system: 'Systemdateien geändert',
}

const KIND_WORD = { 0: 'geändert', 1: 'neu', 2: 'gelöscht' } as const

/** Einordnung einer Änderung; null = unauffällig */
export function classifyChange(c: FsChange, exec: boolean, inLearnedDir: boolean): { cls: FileClass; severity: IncidentSeverity } | null {
  if (exec && c.kind !== 2) return { cls: 'datei_ausfuehrbar', severity: 'hoch' }
  if (under(c.path, BIN_DIRS)) return { cls: 'datei_programm', severity: 'hoch' }
  if (under(c.path, SENSITIVE)) return { cls: 'datei_system', severity: 'hoch' }
  if (inLearnedDir) return null
  if (under(c.path, WEBROOT_PREFIXES)) return { cls: 'datei_webroot', severity: 'hoch' }
  if (under(c.path, SYSTEM_PREFIXES)) return { cls: 'datei_system', severity: 'mittel' }
  return null
}

/** Dateien eines Containers gegen seine Grundlinie */
export function evaluateFiles(i: FileInput): FileResult {
  const changes = meaningfulChanges(i.changes)
  // Ausführbare Dateien in /tmp usw. zählen trotz «laut»
  const seen = new Set(changes.map((c) => c.path))
  const execAdded = addedFiles(i.changes).filter((c) => i.exec.get(c.path) === true && !seen.has(c.path))
  const all = [...changes, ...execAdded]
  if (i.learning) return { learn: all.map((c) => c.path).filter((p) => !i.learned.has(p)), signals: [], reported: [] }
  const learnedDirs = new Set([...i.learned].map(dirOf))
  const allowed = (p: string) => i.allowed.some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a))
  const groups = new Map<FileClass, { severity: IncidentSeverity; paths: string[] }>()
  const reported: string[] = []
  for (const c of all) {
    if (i.learned.has(c.path) || i.reported.has(c.path) || allowed(c.path)) continue
    const r = classifyChange(c, i.exec.get(c.path) === true, learnedDirs.has(dirOf(c.path)))
    if (!r) continue
    reported.push(c.path)
    const g = groups.get(r.cls) ?? { severity: r.severity, paths: [] }
    g.severity = maxSeverity(g.severity, r.severity)
    g.paths.push(`${c.path} (${KIND_WORD[c.kind]})`)
    groups.set(r.cls, g)
  }
  const signals: Signal[] = [...groups].map(([cls, g]) => ({
    projectId: i.projectId,
    source: 'datei',
    kind: cls,
    severity: g.severity,
    key: i.service ?? '',
    title: `${FILE_TITLE[cls]}${serviceText(i.service)}`,
    subject: g.paths.length === 1 ? g.paths[0]!.replace(/ \(\w+\)$/, '') : null,
    service: i.service,
    count: g.paths.length,
    samples: g.paths.slice(0, 20),
    at: i.at,
  }))
  return { learn: [], signals, reported }
}

/** «Als normal markieren» für Dateien: Ordner der Beispiele (ausführbare Dateien genau), nie zu weit oben */
export function normalFileEntries(kind: IncidentKind, samples: readonly string[]): string[] {
  const out = new Set<string>()
  for (const s of samples) {
    const path = s.replace(/ \((neu|geändert|gelöscht)\)$/, '')
    if (!path.startsWith('/')) continue
    if (kind === 'datei_ausfuehrbar' || kind === 'datei_programm') { out.add(path); continue }
    const dir = dirOf(path)
    // «/etc/» oder «/usr/» als Ganzes freizugeben wäre zu viel: mindestens zwei Ebenen
    if (dir.split('/').filter(Boolean).length < 2) out.add(path)
    else out.add(`${dir}/`)
  }
  return [...out]
}

/* --- Statische Seiten: ausgelieferte Dateien gegen das Artefakt ------------------------ */

export interface ManifestDiff { added: string[]; changed: string[]; removed: string[] }

/** Datei → SHA-256; was weicht ab? */
export function diffManifest(expected: Readonly<Record<string, string>>, actual: Readonly<Record<string, string>>): ManifestDiff {
  const added: string[] = []
  const changed: string[] = []
  const removed: string[] = []
  for (const [p, h] of Object.entries(actual)) {
    if (!(p in expected)) added.push(p)
    else if (expected[p] !== h) changed.push(p)
  }
  for (const p of Object.keys(expected)) if (!(p in actual)) removed.push(p)
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() }
}

export function evaluateSite(projectId: string, d: ManifestDiff, reported: ReadonlySet<string>, at: Date): { signal: Signal | null; reported: string[] } {
  const items = [
    ...d.added.map((p) => [p, 'neu'] as const),
    ...d.changed.map((p) => [p, 'geändert'] as const),
    ...d.removed.map((p) => [p, 'gelöscht'] as const),
  ].filter(([p, w]) => !reported.has(`${w}:${p}`))
  if (!items.length) return { signal: null, reported: [] }
  return {
    signal: {
      projectId, source: 'datei', kind: 'datei_seite', severity: 'hoch', key: 'seite',
      title: 'Ausgelieferte Dateien weichen vom Artefakt ab',
      subject: items.length === 1 ? items[0]![0] : null,
      service: null,
      count: items.length,
      samples: items.slice(0, 20).map(([p, w]) => `${p} (${w})`),
      at,
    },
    reported: items.map(([p, w]) => `${w}:${p}`),
  }
}

/* --- Anmeldung ------------------------------------------------------------------------ */

export interface LoginEvent {
  id: number
  at: Date
  action: string
  result: 'ok' | 'error'
  ip: string | null
  /** auth.lockout: «ip» oder «user» */
  scope?: string | null
  reason?: string | null
}

/** Ab so vielen Fehlversuchen einer Adresse in 15 Minuten */
export const LOGIN_FAILURES_MIN = 5
export const LOGIN_FAILURES_HIGH = 20
export const LOGIN_WINDOW_MS = 15 * 60_000

/**
 * Fehlversuche und Sperren. events = Einträge der letzten 15 Minuten
 * (auth.login mit Fehler, auth.lockout); neu ist, was nach cursor kam.
 */
export function evaluateLogins(events: readonly LoginEvent[], cursor: number, at: Date): Signal[] {
  const out: Signal[] = []
  const failures = new Map<string, LoginEvent[]>()
  for (const e of events) {
    if (e.action !== 'auth.login' || e.result !== 'error' || !e.ip) continue
    if (at.getTime() - e.at.getTime() > LOGIN_WINDOW_MS) continue
    failures.set(e.ip, [...(failures.get(e.ip) ?? []), e])
  }
  for (const [ip, list] of failures) {
    const fresh = list.filter((e) => e.id > cursor)
    if (list.length < LOGIN_FAILURES_MIN || !fresh.length) continue
    const reasons = new Map<string, number>()
    for (const e of list) {
      const r = e.reason === 'locked' ? 'während der Sperre' : e.reason === 'totp' ? 'falscher Code' : e.reason === 'recovery' ? 'falscher Wiederherstellungscode' : e.reason === 'passkey' ? 'Passkey abgelehnt' : 'falsches Passwort'
      reasons.set(r, (reasons.get(r) ?? 0) + 1)
    }
    out.push({
      projectId: null, source: 'anmeldung', kind: 'login_fehlversuche',
      severity: list.length >= LOGIN_FAILURES_HIGH ? 'hoch' : 'mittel',
      key: ip, title: `Viele Fehlversuche von ${ip}`, subject: ip, service: null,
      count: fresh.length, initialCount: list.length,
      samples: [...reasons].map(([r, n]) => `${r} (${n}×)`),
      at,
    })
  }
  for (const e of events) {
    if (e.action !== 'auth.lockout' || e.id <= cursor) continue
    const user = e.scope === 'user'
    out.push({
      projectId: null, source: 'anmeldung', kind: 'login_sperre',
      severity: user ? 'hoch' : 'mittel',
      key: user ? 'konto' : e.ip ?? '?',
      title: user ? 'Anmeldung mit Passwort für alle gesperrt' : `Adresse ${e.ip ?? '?'} gesperrt`,
      subject: e.ip, service: null, count: 1,
      samples: [`${e.ip ?? '?'} um ${e.at.toISOString()}`],
      at,
    })
  }
  return out
}

export interface SessionSeen { device: string; access: string; ip: string | null; at: Date }

/**
 * Neues Gerät bzw. neuer Zugang: neue Sitzungen gegen die bekannten (letzte
 * 30 Tage). Ohne bekannte Sitzung (erste Anmeldung) wird nichts gemeldet.
 */
export function evaluateSessions(fresh: readonly SessionSeen[], known: readonly SessionSeen[], at: Date): Signal[] {
  if (!known.length) return []
  const devices = new Set(known.map((k) => k.device))
  const accesses = new Set(known.map((k) => k.access))
  const out = new Map<string, Signal>()
  for (const s of fresh) {
    const newDevice = !devices.has(s.device)
    const newAccess = !accesses.has(s.access)
    devices.add(s.device)
    accesses.add(s.access)
    if (!newDevice && !newAccess) continue
    const kind: IncidentKind = newDevice ? 'login_neues_geraet' : 'login_neuer_zugang'
    const key = newDevice ? s.device : s.access
    const prev = out.get(`${kind}|${key}`)
    if (prev) { prev.count++; continue }
    out.set(`${kind}|${key}`, {
      projectId: null, source: 'anmeldung', kind,
      severity: newDevice ? 'hoch' : 'mittel',
      key,
      title: newDevice ? `Anmeldung von neuem Gerät: ${s.device}` : `Anmeldung über neuen Zugang: ${ACCESS_WORD[s.access] ?? s.access}`,
      subject: s.ip, service: null, count: 1,
      samples: [`${s.device}, ${ACCESS_WORD[s.access] ?? s.access}${s.ip ? `, ${s.ip}` : ''}`],
      at,
    })
  }
  return [...out.values()]
}

const ACCESS_WORD: Record<string, string> = { lan: 'Heimnetz', tailnet: 'Tailnet', gateway: 'Docker-Gateway', server: 'Server selbst', unknown: 'unbekannt' }

/* --- Netz: gesperrte Ausgangsversuche (Etappe 4) --------------------------------------- */

export interface EgressRow { projectId: string; destination: string; port: number; protocol: string; count: number; toServer: boolean }

/** Ab so vielen verschiedenen Zielen in einer Abholung sieht es nach Abtasten aus */
export const EGRESS_SCAN_TARGETS = 10

export const egressTarget = (r: Pick<EgressRow, 'destination' | 'port'>) => (r.port ? `${r.destination}:${r.port}` : r.destination)

/** Ziele aus den Beispielen eines Netz-Vorfalls: «192.168.0.12:445/tcp (3×)» → «192.168.0.12:445» (für «als normal») */
export function egressTargetsOf(samples: readonly string[]): string[] {
  return [...new Set(samples.map((s) => s.split('/')[0]!.split(' ')[0]!).filter((t) => /^[0-9a-f.:[\]]+$/i.test(t)))]
}

export function evaluateEgress(rows: readonly EgressRow[], allowed: (projectId: string) => ReadonlySet<string>, at: Date): Signal[] {
  const byProject = new Map<string, EgressRow[]>()
  for (const r of rows) {
    if (allowed(r.projectId).has(egressTarget(r))) continue
    byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r])
  }
  return [...byProject].map(([projectId, list]) => {
    const targets = new Map<string, number>()
    for (const r of list) targets.set(`${egressTarget(r)}/${r.protocol}${r.toServer ? ' (Server)' : ''}`, (targets.get(`${egressTarget(r)}/${r.protocol}${r.toServer ? ' (Server)' : ''}`) ?? 0) + r.count)
    const distinct = new Set(list.map(egressTarget)).size
    return {
      projectId, source: 'netz', kind: 'netz_gesperrt',
      severity: distinct >= EGRESS_SCAN_TARGETS ? 'hoch' : 'mittel',
      key: 'ausgang',
      title: distinct >= EGRESS_SCAN_TARGETS ? `Gesperrte Versuche zu ${distinct} Zielen (Abtasten?)` : 'Gesperrte Verbindungsversuche nach draussen',
      subject: distinct === 1 ? egressTarget(list[0]!) : null,
      service: null,
      count: list.reduce((a, r) => a + r.count, 0),
      samples: [...targets].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([t, n]) => `${t} (${n}×)`),
      at,
    } satisfies Signal
  })
}

/* --- Web: Scanner-Muster in den Besucher-Logs ------------------------------------------- */

/**
 * Pfade, nach denen Scanner suchen (Admin-Oberflächen, Geheimnisse,
 * Versionsverwaltung, bekannte Lücken). Eigene kleine Liste – auf main
 * gibt es inzwischen eine in packages/shared (beim Zusammenführen vereinen).
 */
export const SCANNER_PATTERNS: readonly RegExp[] = [
  /^\/wp-(admin|login\.php|content\/plugins|includes)/i, /\/xmlrpc\.php$/i, /\/wp-config\.php/i,
  /\/\.git(\/|$)/i, /\/\.svn(\/|$)/i, /\/\.hg(\/|$)/i,
  /\/\.env(\.|$)/i, /\/\.aws\//i, /\/\.ssh\//i, /\/\.htpasswd$/i, /\/\.DS_Store$/i,
  /\/(phpmyadmin|pma|myadmin|adminer)(\/|\.php|$)/i, /\/vendor\/phpunit\//i, /\/cgi-bin\//i,
  /\/(server-status|server-info)$/i, /\/actuator(\/|$)/i, /\/boaform\//i, /\/HNAP1/i, /\/(shell|cmd|eval-stdin)\.php/i,
  /\/(backup|db|dump|database)\.(sql|zip|tar\.gz|tgz|bak)$/i, /\/config\.(php\.bak|json\.bak|yml)$/i, /\/\.vscode\//i,
  /\/(owa|ecp)\//i, /\/(solr|jenkins|manager\/html)(\/|$)/i, /\.(asp|aspx|jsp|cgi)$/i,
]

export const isScannerPath = (path: string): boolean => SCANNER_PATTERNS.some((r) => r.test(path.split('?')[0] ?? path))

/** Ab so vielen Scanner-Treffern bzw. 4xx-Antworten in einer Stunde gilt es als Scan */
export const WEB_SCAN_HITS = 5
export const WEB_SCAN_4XX = 200

interface WebBucket { hour: number; scanner: number; errors: number; sources: Set<string>; paths: Map<string, number>; reported: number }

/**
 * Zählt je Projekt und Stunde (im Arbeitsspeicher, ohne IP zu speichern –
 * Absender nur gezählt). drain() liefert die Hinweise seit dem letzten Mal,
 * sobald eine Stunde die Schwelle überschritten hat. Rein bis auf den
 * eigenen Zustand (testbar).
 */
export class WebScanCounter {
  private buckets = new Map<string, WebBucket>()

  add(projectId: string, a: { at: number; path: string; status: number; source: string }): void {
    const hour = Math.floor(a.at / 3_600_000)
    let b = this.buckets.get(projectId)
    if (!b || b.hour !== hour) {
      b = { hour, scanner: 0, errors: 0, sources: new Set(), paths: new Map(), reported: 0 }
      this.buckets.set(projectId, b)
    }
    const scanner = isScannerPath(a.path)
    if (!scanner && (a.status < 400 || a.status >= 500)) return
    if (scanner) {
      b.scanner++
      const p = (a.path.split('?')[0] ?? a.path).slice(0, 120)
      if (b.paths.size < 200 || b.paths.has(p)) b.paths.set(p, (b.paths.get(p) ?? 0) + 1)
    } else b.errors++
    if (b.sources.size < 10_000) b.sources.add(a.source)
  }

  drain(at: Date): Signal[] {
    const out: Signal[] = []
    for (const [projectId, b] of this.buckets) {
      const total = b.scanner + b.errors
      if (b.scanner < WEB_SCAN_HITS && b.errors < WEB_SCAN_4XX) continue
      const fresh = total - b.reported
      if (fresh <= 0) continue
      const first = b.reported === 0
      b.reported = total
      out.push({
        projectId, source: 'web', kind: 'web_scan', severity: 'niedrig', key: 'scan',
        title: 'Scan von aussen (Scanner-Pfade, 4xx)',
        subject: null, service: null,
        count: fresh, ...(first ? { initialCount: total } : {}),
        samples: [
          `${b.scanner} Scanner-Pfade, ${b.errors} weitere 4xx, ${b.sources.size} ${b.sources.size === 1 ? 'Absender' : 'Absender'} in dieser Stunde`,
          ...[...b.paths].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([p, n]) => `${p} (${n}×)`),
        ],
        at,
      })
    }
    // Alte Stunden vergessen
    const now = Math.floor(at.getTime() / 3_600_000)
    for (const [id, b] of this.buckets) if (b.hour < now - 1) this.buckets.delete(id)
    return out
  }
}

/* --- Container: unerwartete Neustarts, Speichergrenze ------------------------------------ */

export interface ContainerSeen { restartCount: number; startedAt: string | null; oomFor: string | null }
export interface ContainerNow { restartCount: number; startedAt: string | null; running: boolean; oomKilled: boolean; finishedAt: string | null }

/**
 * Docker zählt RestartCount nur bei Neustarts durch die Restart-Policy (Absturz),
 * nicht bei Start von Hand, Deploy oder Neustart des Servers. OOMKilled gilt für
 * das letzte Ende; gemeldet wird jedes Ende einmal.
 */
export function evaluateContainer(projectId: string, service: string | null, prev: ContainerSeen | null, cur: ContainerNow, at: Date): { signals: Signal[]; next: ContainerSeen } {
  const next: ContainerSeen = { restartCount: cur.restartCount, startedAt: cur.startedAt, oomFor: prev?.oomFor ?? null }
  const signals: Signal[] = []
  if (!prev) return { signals, next }
  const restarts = cur.restartCount - prev.restartCount
  if (restarts > 0) {
    signals.push({
      projectId, source: 'container', kind: 'container_neustart', severity: 'mittel', key: service ?? '',
      title: `Container neu gestartet nach Absturz${serviceText(service)}`, subject: null, service,
      count: restarts, samples: [`Neustart Nr. ${cur.restartCount}${cur.startedAt ? ` um ${cur.startedAt}` : ''}`], at,
    })
  }
  const end = cur.finishedAt ?? cur.startedAt
  if (cur.oomKilled && end && prev.oomFor !== end) {
    next.oomFor = end
    signals.push({
      projectId, source: 'container', kind: 'container_oom', severity: 'mittel', key: service ?? '',
      title: `Container wegen Speichergrenze beendet${serviceText(service)}`, subject: null, service,
      count: 1, samples: [`beendet ${end}`], at,
    })
  }
  return { signals, next }
}
