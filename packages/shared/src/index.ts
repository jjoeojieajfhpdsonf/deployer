import { z } from 'zod'

/* ------------------------------------------------------------------ *
 * Slug
 * ------------------------------------------------------------------ */

/** 1-40 Zeichen, Kleinbuchstaben, Ziffern, Bindestrich; nicht am Rand. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

/**
 * Vergeben an deployer selbst: "deployer" ist die Adresse der Oberfläche
 * (sonst hätte ein Projekt sie überdeckt – Fehler aus M1), "ext-scan" das
 * Netz für Scans externer Ziele (M6).
 */
export const RESERVED_SLUGS = ['deployer', 'ext-scan'] as const

export const slugSchema = z
  .string()
  .min(1, 'Gib einen Kurznamen an, z.B. solar-heute')
  .max(40, 'Höchstens 40 Zeichen, z.B. solar-heute')
  .regex(SLUG_RE, 'Nur Kleinbuchstaben, Ziffern und Bindestrich, nicht am Anfang oder Ende, z.B. solar-heute')
  .refine((s) => !(RESERVED_SLUGS as readonly string[]).includes(s), 'Dieser Name ist für deployer selbst reserviert; wähle einen anderen, z.B. mein-deployer')

export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[̀-ͯ]/g, '')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return base || 'projekt'
}

/* ------------------------------------------------------------------ *
 * Aufzählungen
 * ------------------------------------------------------------------ */

export const sourceTypes = ['image', 'static', 'dockerfile', 'compose', 'files'] as const
export type SourceType = (typeof sourceTypes)[number]
/** In M1 umgesetzt. */
export const sourceTypesM1 = ['image', 'static'] as const
/** Seit M3 alle Quellen. */
export const sourceTypesSupported = ['image', 'static', 'dockerfile', 'compose', 'files'] as const

export const projectStatuses = ['created', 'deploying', 'running', 'stopped', 'failed'] as const
export type ProjectStatus = (typeof projectStatuses)[number]

export const desiredStates = ['running', 'stopped'] as const
export type DesiredState = (typeof desiredStates)[number]

export const deploymentStatuses = [
  'pending', 'pulling', 'starting', 'healthchecking',
  'active', 'failed', 'superseded', 'rolled_back',
] as const
export type DeploymentStatus = (typeof deploymentStatuses)[number]

export const routeTargets = ['public', 'lan', 'tailnet'] as const
export type RouteTarget = (typeof routeTargets)[number]
/** In M1 umgesetzt. */
/** Ziele, die ohne Cloudflare-Tunnel gehen (M4: Tailnet dazu). public kommt mit M5. */
export const routeTargetsSupported = ['lan', 'tailnet'] as const

/* ------------------------------------------------------------------ *
 * Quellen
 * ------------------------------------------------------------------ */

/** Docker-Image-Referenz, z.B. ghcr.io/user/app:1.2 oder nginx:alpine */
export const imageRefSchema = z
  .string({ required_error: 'Gib einen Image-Namen an, z.B. nginx:alpine' })
  .trim()
  .min(1, 'Gib einen Image-Namen an, z.B. nginx:alpine')
  .max(255, 'Der Image-Name ist zu lang (höchstens 255 Zeichen)')
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._\-/:]*(@sha256:[a-f0-9]{64})?$/,
    'Das ist kein Image-Name. Erlaubt sind Buchstaben, Ziffern und . _ - / :, z.B. nginx:alpine oder ghcr.io/user/app:1.2',
  )

export const imageSourceSchema = z.object({
  type: z.literal('image'),
  image: imageRefSchema,
})

/**
 * Repo-URL. Hier nur die Form; welche Schemata und Ziele erlaubt sind, prüft
 * der Server (lib/git.ts), weil dafür DNS-Auflösung nötig ist.
 */
export const repoUrlSchema = z
  .string({ required_error: 'Gib die Adresse des Repos an, z.B. https://github.com/user/app.git' })
  .trim()
  .min(1, 'Gib die Adresse des Repos an, z.B. https://github.com/user/app.git')
  .max(2048, 'Die Repo-Adresse ist zu lang (höchstens 2048 Zeichen)')
  .regex(/^https?:\/\/[^\s]+$/i, 'Die Repo-Adresse muss mit https:// (oder http:// im LAN) beginnen, z.B. https://github.com/user/app.git')

/** Branch, Tag oder Commit. Nie mit "-" am Anfang (sonst eine Git-Option). */
export const gitRefSchema = z
  .string()
  .trim()
  .min(1, 'Gib einen Branch, Tag oder Commit an, z.B. main – oder lass das Feld leer')
  .max(255, 'Höchstens 255 Zeichen')
  .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, 'Nur Buchstaben, Ziffern und . _ / -, nicht mit - beginnend, z.B. main oder v1.2.0')
  .refine((v) => !v.includes('..'), 'Zwei Punkte hintereinander sind nicht erlaubt, z.B. v1.2.0 statt v1..2')

/** Pfad innerhalb eines Repos; ob er drin bleibt, prüft der Server am aufgelösten Pfad. */
export const repoPathSchema = z
  .string()
  .trim()
  .min(1, 'Gib einen Pfad im Repo an, z.B. Dockerfile oder app/compose.yaml')
  .max(512, 'Höchstens 512 Zeichen')
  .refine((v) => !v.includes('\0') && !v.startsWith('/') && !v.includes('\\'), 'Gib den Pfad relativ zum Repo an, ohne / am Anfang, z.B. docker/Dockerfile')

export const staticSourceSchema = z.object({
  type: z.literal('static'),
  /** Entweder ein hochgeladenes ZIP ... */
  uploadId: z.string().uuid().optional(),
  /** ... oder ein Repo, optional mit Build im Wegwerf-Container. */
  repoUrl: repoUrlSchema.optional(),
  ref: gitRefSchema.optional(),
  buildCommand: z.string().trim().min(1, 'Gib einen Befehl an, z.B. npm run build – oder lass das Feld leer').max(500, 'Höchstens 500 Zeichen').optional(),
  outputDir: repoPathSchema.optional(),
})

export const dockerfileSourceSchema = z.object({
  type: z.literal('dockerfile'),
  repoUrl: repoUrlSchema,
  ref: gitRefSchema.optional(),
  dockerfile: repoPathSchema.default('Dockerfile'),
  context: repoPathSchema.default('.'),
})

export const COMPOSE_SERVICE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/

export const composeSourceSchema = z.object({
  type: z.literal('compose'),
  /** Entweder ein Repo ... */
  repoUrl: repoUrlSchema.optional(),
  ref: gitRefSchema.optional(),
  composePath: repoPathSchema.default('compose.yaml'),
  /** ... oder eine hochgeladene compose.yaml. */
  uploadId: z.string().uuid().optional(),
  /** Dienst, der den Web-Verkehr bekommt. */
  webService: z
    .string({ required_error: 'Gib den Dienst an, der die Besucher bekommt, z.B. web' })
    .trim()
    .min(1, 'Gib den Dienst an, der die Besucher bekommt, z.B. web')
    .regex(COMPOSE_SERVICE_RE, 'So heisst der Dienst in der compose.yaml: Buchstaben, Ziffern, . _ -, z.B. web'),
})

/**
 * M3: Dateien direkt aus dem Chat, im lokalen Git-Repo des Projekts. Die Art
 * (statisch, Build, Dockerfile, Compose) wird bei jedem Deploy erkannt.
 */
export const filesSourceSchema = z.object({
  type: z.literal('files'),
  /** Bei Compose: Dienst, der den Web-Verkehr bekommt (Standard "web"). */
  webService: z.string().regex(COMPOSE_SERVICE_RE, 'Ungültiger Dienstname').optional(),
  /** Bei statischer Seite mit Build: Befehl (Standard "npm run build") und Ausgabe. */
  buildCommand: z.string().min(1).max(500).optional(),
  outputDir: repoPathSchema.optional(),
})

export const fileInputSchema = z.object({
  path: z.string().min(1).max(255),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
})
export type FileInputDto = z.infer<typeof fileInputSchema>

export const sourceSchema = z.discriminatedUnion('type', [
  imageSourceSchema,
  staticSourceSchema,
  dockerfileSourceSchema,
  composeSourceSchema,
  filesSourceSchema,
])
export type Source = z.infer<typeof sourceSchema>

/** Querbezüge, die ein einzelnes Feld nicht ausdrücken kann. */
export function sourceIssues(s: Source): { path: string[]; message: string }[] {
  const issues: { path: string[]; message: string }[] = []
  if (s.type === 'static') {
    if (!!s.uploadId === !!s.repoUrl) {
      issues.push({ path: ['source'], message: 'Eine statische Seite braucht entweder ein ZIP oder eine Repo-Adresse' })
    }
    if (s.uploadId && (s.buildCommand || s.ref)) {
      issues.push({ path: ['source', 'buildCommand'], message: 'Einen Build-Befehl gibt es nur mit Repo; beim ZIP lädst du die fertigen Dateien hoch' })
    }
  }
  if (s.type === 'compose' && !!s.uploadId === !!s.repoUrl) {
    issues.push({ path: ['source'], message: 'Compose braucht entweder eine hochgeladene compose.yaml oder eine Repo-Adresse' })
  }
  return issues
}

/** Quellen, die einen Port im Container brauchen. */
export const sourceNeedsPort = (t: SourceType) => t === 'image' || t === 'dockerfile' || t === 'compose'

/* ------------------------------------------------------------------ *
 * Env / Secrets
 * ------------------------------------------------------------------ */

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export const envEntryInputSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, 'Gib einen Namen an, z.B. DATABASE_URL')
    .max(128, 'Höchstens 128 Zeichen')
    .regex(ENV_KEY_RE, 'Nur Buchstaben, Ziffern und _, nicht mit einer Ziffer beginnend, z.B. DATABASE_URL'),
  value: z.string().max(8192, 'Der Wert ist zu lang (höchstens 8192 Zeichen)'),
  isSecret: z.boolean().default(false),
})
export type EnvEntryInput = z.infer<typeof envEntryInputSchema>

/** Was die API zurückgibt: Secrets werden nie im Klartext ausgeliefert. */
export const envEntryDtoSchema = z.object({
  key: z.string(),
  isSecret: z.boolean(),
  /** null, wenn isSecret – der Wert verlässt den Server nicht. */
  value: z.string().nullable(),
})
export type EnvEntryDto = z.infer<typeof envEntryDtoSchema>

export const putEnvSchema = z.object({ entries: z.array(envEntryInputSchema).max(200) })

/* ------------------------------------------------------------------ *
 * Projekte
 * ------------------------------------------------------------------ */

export const projectNameSchema = z
  .string({ required_error: 'Gib dem Projekt einen Namen, z.B. Solarertrag heute' })
  .trim()
  .min(1, 'Gib dem Projekt einen Namen, z.B. Solarertrag heute')
  .max(120, 'Höchstens 120 Zeichen; der Kurzname für die Adresse entsteht daraus')

export const portSchema = z
  .number({ invalid_type_error: 'Gib den Port als Zahl an, z.B. 80 oder 3000', required_error: 'Gib den Port an, z.B. 80' })
  .int('Gib den Port als ganze Zahl an, z.B. 8080')
  .min(1, 'Ports gehen von 1 bis 65535, z.B. 80 oder 3000')
  .max(65535, 'Ports gehen von 1 bis 65535, z.B. 80 oder 3000')

export const healthcheckPathSchema = z
  .string()
  .trim()
  .startsWith('/', 'Der Pfad beginnt mit /, z.B. / oder /health')
  .max(512, 'Höchstens 512 Zeichen')

/** Öffentlicher Name (M5): Form hier, Zone und Belegung prüft der Server. */
export const publicHostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Gib einen Namen an, z.B. solar oder solar.deinedomain.ch')
  .max(253, 'Höchstens 253 Zeichen')
  .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/, 'Nur Buchstaben, Ziffern, Bindestrich und Punkte, z.B. solar.deinedomain.ch')

export const createProjectSchema = z
  .object({
    name: projectNameSchema,
    slug: slugSchema.optional(),
    source: sourceSchema,
    port: portSchema.optional(),
    healthcheckPath: healthcheckPathSchema.default('/'),
    env: z.array(envEntryInputSchema).max(200).default([]),
    targets: z.array(z.enum(routeTargets)).default(['lan']),
    subdomain: slugSchema.optional(),
    cpuLimit: z.number().min(0.1).max(16).optional(),
    memoryLimitMb: z.number().int().min(64).max(32768).optional(),
    keep: z.boolean().default(false),
    deploy: z.boolean().default(true),
    /** M3: Anfangsdateien bei Quelle files. Grenzen prüft der Server. */
    files: z.array(fileInputSchema).max(2000).optional(),
  })
  .superRefine((v, ctx) => {
    if (sourceNeedsPort(v.source.type) && v.port === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['port'], message: 'Gib den Port an, auf dem die App im Container lauscht, z.B. 80 oder 3000' })
    }
    if (v.source.type === 'files' && (!v.files || v.files.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files'], message: 'Quelle files braucht mindestens eine Datei' })
    }
    if (v.source.type !== 'files' && v.files) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files'], message: 'Dateien gibt es nur bei Quelle files' })
    }
    for (const i of sourceIssues(v.source)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: i.path, message: i.message })
    }
    for (const t of v.targets) {
      if (!(routeTargetsSupported as readonly string[]).includes(t)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targets'], message: 'Öffentlich geht erst nach dem ersten Scan: intern anlegen, dann die Erreichbarkeit ändern' })
      }
    }
  })
export type CreateProjectInput = z.infer<typeof createProjectSchema>

export const updateProjectSchema = z.object({
  name: projectNameSchema.optional(),
  port: portSchema.optional(),
  healthcheckPath: healthcheckPathSchema.optional(),
  cpuLimit: z.number().min(0.1).max(16).optional(),
  memoryLimitMb: z.number().int().min(64).max(32768).optional(),
  keep: z.boolean().optional(),
  source: sourceSchema.optional(),
}).superRefine((v, ctx) => {
  if (!v.source) return
  for (const i of sourceIssues(v.source)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: i.path, message: i.message })
  }
})

export const rollbackSchema = z.object({ deploymentId: z.string().uuid().optional() })

export const putRoutesSchema = z.object({
  targets: z.array(z.enum(routeTargets)).min(0),
  subdomain: slugSchema.optional(),
  // M5: öffentlicher Name – Subdomain der Standard-Domain oder voller Hostname
  publicSubdomain: slugSchema.optional(),
  publicHostname: publicHostnameSchema.optional(),
  accessProtected: z.boolean().optional(),
})

export const deploySchema = z.object({ ref: z.string().max(255).optional() })

export interface RouteDto {
  /** Erstes Ziel; alle Ziele dieses Namens in targets (LAN und Tailnet teilen sich ihn). */
  target: RouteTarget
  targets?: RouteTarget[]
  /** M5: öffentliche Route hinter Cloudflare Access */
  accessProtected?: boolean
  hostname: string
  /** Zusätzliche Namen, über die dieselbe Route erreichbar ist (nip.io). */
  aliases: string[]
  urls: string[]
}

export interface DeploymentDto {
  id: string
  projectId: string
  version: string | null
  sourceRef: string | null
  status: DeploymentStatus
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
  isActive: boolean
  durationMs: number | null
  /** M2 */
  trigger: 'deploy' | 'rollback'
  rollbackOf: string | null
  /** Lässt sich auf diese Fassung zurückrollen (Artefakt noch vorhanden, nicht aktiv)? */
  canRollback: boolean
}

export interface ProjectDto {
  id: string
  name: string
  slug: string
  sourceType: SourceType
  source: Source | null
  port: number | null
  healthcheckPath: string
  status: ProjectStatus
  desiredState: DesiredState
  keep: boolean
  cpuLimit: number
  memoryLimitMb: number
  createdAt: string
  updatedAt: string
  routes: RouteDto[]
  activeDeployment: DeploymentDto | null
  /** Läuft der Container als root? Nur Hinweis, kein Fehler (siehe Plan). */
  runsAsRoot: boolean | null
  /** M3: wie das Projekt zur Laufzeit behandelt wird (bei files: die erkannte Art). */
  runtimeKind: 'image' | 'dockerfile' | 'static' | 'compose'
  /** M3, nur Quelle files: als was die aktive Fassung erkannt wurde. */
  filesKind: 'compose' | 'dockerfile' | 'static-build' | 'static' | null
  lastChangeAt: string
  /** M3: wann ein Chat-Projekt ohne Änderung gestoppt wird; null = läuft nicht ab. */
  expiresAt: string | null
  /** M6: letzter Scan in Kurzform. */
  security: {
    scanId: string
    status: 'queued' | 'running' | 'done' | 'failed'
    score: number | null
    grade: 'A' | 'B' | 'C' | 'D' | null
    finishedAt: string | null
    /** Offene Befunde des letzten Scans nach Schwere */
    open: Record<'critical' | 'high' | 'medium' | 'low', number>
  } | null
  /** Letzter Deploy-Versuch, auch laufend oder gescheitert (für Übersicht und Banner) */
  lastDeployment: DeploymentDto | null
}

export interface FindingDto {
  id: string
  tool: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  title: string
  location: string
  description: string
  fix: string
  status: 'open' | 'accepted' | 'fixed'
  acceptReason: string | null
}

export interface ScanReportDto {
  scan: {
    id: string
    status: 'queued' | 'running' | 'done' | 'failed'
    level: 'standard' | 'active'
    startedAt: string
    finishedAt: string | null
    score: number | null
    grade: 'A' | 'B' | 'C' | 'D' | null
    error: string | null
    stages: Record<string, { ran: boolean; note?: string; findings?: number; failed?: boolean }>
  }
  counts: Record<'critical' | 'high' | 'medium' | 'low', number>
  top: { id: string; severity: string; title: string; location: string; fix: string }[]
  findings: FindingDto[]
}

/* ------------------------------------------------------------------ *
 * System
 * ------------------------------------------------------------------ */

export interface SystemStatusDto {
  version: string
  checks: { name: string; ok: boolean; detail: string }[]
  diskFreeBytes: number | null
  ipFilterEnabled: boolean
  /** null = noch keine Basisdomain festgelegt; die Adressen sind dann nip.io-Namen. */
  baseDomain: string | null
  serverLanIp: string | null
  nipioEnabled: boolean
  /** Kopierfertiger Block für /etc/hosts; null ohne Basisdomain (nicht nötig). */
  hostsBlock: string | null
  /** M4: HTTPS und Tailnet. null-Felder = nicht eingerichtet. */
  tls: {
    mode: 'off' | 'cloudflare'
    acmeCa: 'production' | 'staging'
    cert: { ok: boolean; subject: string | null; issuer: string | null; validTo: string | null; daysLeft: number | null; error: string | null; problem: string | null } | null
    tailscaleIp: string | null
  }
  /** Übersicht: Name des Servers, Auslastung, Scans in der Warteschlange */
  server: {
    name: string
    cpuPercent: number | null
    memUsedBytes: number | null
    memTotalBytes: number | null
    diskUsedBytes: number | null
    diskTotalBytes: number | null
  }
  scanQueue: number
  /** M5: Cloudflare Tunnel */
  publicTunnel: { configured: boolean; status: string | null; connections: number }
  /** Namen, die der Browser selbst prüfen soll: Weg -> URL */
  reachability: { way: 'dns' | 'nipio' | 'hosts'; label: string; url: string | null }[]
}

export interface AuditEventDto {
  id: string
  at: string
  actor: string
  action: string
  targetType: string | null
  targetId: string | null
  paramsMasked: unknown
  result: 'ok' | 'error'
  error: string | null
}

/* ------------------------------------------------------------------ *
 * Fehlerformat (einheitlich, siehe Plan)
 * ------------------------------------------------------------------ */

export interface ApiError {
  error: { code: string; message: string; details?: unknown }
}

export const loginSchema = z.object({ password: z.string().min(1, 'Gib das Passwort ein').max(512, 'Höchstens 512 Zeichen') })

/* ------------------------------------------------------------------ *
 * Formulare: dieselben Regeln in der Oberfläche und in der API
 * ------------------------------------------------------------------ */

export const tokenNameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Gib dem Token einen Namen, z.B. Claude Desktop – daran erkennst du es im Audit-Log')
    .max(80, 'Höchstens 80 Zeichen'),
})

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
/** Namen, die nie öffentlich auflösen oder deployer selbst gehören. */
export const RESERVED_HOST_SUFFIXES = ['localhost', 'local', 'internal', 'invalid', 'test', 'example', 'lan', 'home.arpa', 'nip.io']

/**
 * Externes Ziel (M6): Form des Hostnamens. Ob er unter der internen
 * Basisdomain liegt und auf öffentliche Adressen zeigt, prüft der Server.
 */
export const externalHostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((h) => h.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, ''))
  .superRefine((h, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })
    if (!h) return fail('Gib den Hostnamen deiner Website an, z.B. www.meine-domain.ch')
    if (h.length > 253) return fail('Der Hostname ist zu lang (höchstens 253 Zeichen)')
    if (IPV4.test(h) || h.includes(':')) return fail('Gib einen Hostnamen statt einer IP-Adresse an, z.B. www.meine-domain.ch')
    const labels = h.split('.')
    if (labels.length < 2) return fail('Der Hostname braucht eine Domain mit Endung, z.B. www.meine-domain.ch')
    if (!labels.every((l) => HOST_LABEL.test(l))) return fail('Nur Buchstaben, Ziffern, Bindestrich und Punkte, z.B. www.meine-domain.ch')
    const tld = labels[labels.length - 1]!
    if (!/^[a-z]{2,63}$/.test(tld) && !tld.startsWith('xn--')) return fail(`«.${tld}» ist keine Domain-Endung; z.B. .ch oder .com`)
    for (const r of RESERVED_HOST_SUFFIXES) {
      if (h === r || h.endsWith(`.${r}`)) return fail(`«${h}» ist kein öffentlicher Name. Externe Ziele sind eigene Websites im Internet, z.B. www.meine-domain.ch`)
    }
  })

export const addExternalTargetSchema = z.object({ hostname: externalHostnameSchema })

export const PASSWORD_MIN = 12

export const passwordChangeSchema = z.object({
  current: z.string().min(1, 'Gib dein bisheriges Passwort ein').max(500, 'Höchstens 500 Zeichen'),
  next: z
    .string()
    .min(PASSWORD_MIN, `Das neue Passwort braucht mindestens ${PASSWORD_MIN} Zeichen – ein Satz aus vier Wörtern ist leicht zu merken`)
    .max(500, 'Höchstens 500 Zeichen'),
})

/** Formular mit Wiederholung; die API kennt nur current und next. */
export const passwordChangeFormSchema = passwordChangeSchema
  .extend({ repeat: z.string() })
  .superRefine((v, ctx) => {
    if (v.repeat !== v.next) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repeat'], message: 'Die Wiederholung stimmt nicht mit dem neuen Passwort überein' })
    if (v.next && v.next === v.current) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['next'], message: 'Das neue Passwort ist dasselbe wie das bisherige; wähle ein anderes' })
  })

export const acceptFindingSchema = z.object({
  status: z.literal('accepted'),
  reason: z
    .string()
    .trim()
    .min(3, 'Begründe kurz, warum der Befund bleiben darf, z.B. «nur im LAN erreichbar»')
    .max(1000, 'Höchstens 1000 Zeichen'),
})

const emailList = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+(\s*,\s*[^\s@,]+@[^\s@,]+\.[^\s@,]+)*$/

export const ntfySettingsSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, 'Gib die Adresse des ntfy-Servers an, z.B. https://ntfy.sh')
    .max(500, 'Höchstens 500 Zeichen')
    .regex(/^https?:\/\/\S+$/i, 'Die Adresse beginnt mit https:// oder http://, z.B. https://ntfy.sh'),
  topic: z
    .string()
    .trim()
    .min(1, 'Gib das Topic an, auf das du in der ntfy-App hörst, z.B. deployer-joel')
    .max(64, 'Höchstens 64 Zeichen')
    .regex(/^[A-Za-z0-9_-]+$/, 'Nur Buchstaben, Ziffern, _ und -, z.B. deployer-joel'),
  token: z.string().max(500, 'Höchstens 500 Zeichen').nullable().optional(),
})

export const emailSettingsSchema = z.object({
  host: z
    .string()
    .trim()
    .min(1, 'Gib den SMTP-Server an, z.B. smtp.mail.ch')
    .max(253, 'Höchstens 253 Zeichen')
    .regex(/^[A-Za-z0-9.-]+$/, 'Nur den Servernamen, ohne smtp:// davor, z.B. smtp.mail.ch'),
  port: portSchema,
  secure: z.boolean(),
  user: z.string().max(200, 'Höchstens 200 Zeichen').nullable().optional(),
  password: z.string().max(500, 'Höchstens 500 Zeichen').nullable().optional(),
  from: z
    .string()
    .trim()
    .min(1, 'Gib die Absender-Adresse an, z.B. deployer@meine-domain.ch')
    .max(200, 'Höchstens 200 Zeichen')
    .regex(emailList, 'Das ist keine E-Mail-Adresse, z.B. deployer@meine-domain.ch'),
  to: z
    .string()
    .trim()
    .min(1, 'Gib an, wer die Nachrichten bekommt, z.B. joel@meine-domain.ch')
    .max(500, 'Höchstens 500 Zeichen')
    .regex(emailList, 'Eine oder mehrere E-Mail-Adressen, mit Komma getrennt, z.B. joel@meine-domain.ch'),
})

/** Benachrichtigungen im Formular: null = Abschnitt aus. */
export const notifySettingsFormSchema = z.object({
  ntfy: ntfySettingsSchema.nullable(),
  email: emailSettingsSchema.nullable(),
})

/**
 * Öffentlicher Name im Formular: leer (= Kurzname), nur Subdomain oder voller
 * Hostname – dieselben Regeln wie publicSubdomain/publicHostname der API.
 */
export const publicNameFormSchema = z.object({
  name: z.string().superRefine((raw, ctx) => {
    const v = raw.trim().toLowerCase()
    if (!v) return
    const r = v.includes('.') ? publicHostnameSchema.safeParse(v) : slugSchema.safeParse(v)
    if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: r.error.issues[0]?.message ?? 'Ungültiger Name' })
  }),
})

