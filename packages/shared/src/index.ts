import { z } from 'zod'

/* ------------------------------------------------------------------ *
 * Slug
 * ------------------------------------------------------------------ */

/** 1-40 Zeichen, Kleinbuchstaben, Ziffern, Bindestrich; nicht am Rand. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

export const slugSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(SLUG_RE, 'Nur a-z, 0-9 und Bindestrich; nicht am Anfang oder Ende')

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
/** Seit M2 umgesetzt; `files` kommt mit M3. */
export const sourceTypesSupported = ['image', 'static', 'dockerfile', 'compose'] as const

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
export const routeTargetsM1 = ['lan'] as const

/* ------------------------------------------------------------------ *
 * Quellen
 * ------------------------------------------------------------------ */

/** Docker-Image-Referenz, z.B. ghcr.io/user/app:1.2 oder nginx:alpine */
export const imageRefSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._\-/:]*(@sha256:[a-f0-9]{64})?$/,
    'Keine gültige Image-Referenz',
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
  .string()
  .min(1)
  .max(2048)
  .regex(/^https?:\/\/[^\s]+$/i, 'Nur https:// oder http:// Repo-URLs')

/** Branch, Tag oder Commit. Nie mit "-" am Anfang (sonst eine Git-Option). */
export const gitRefSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, 'Ungültiger Branch, Tag oder Commit')
  .refine((v) => !v.includes('..'), 'Ungültiger Branch, Tag oder Commit')

/** Pfad innerhalb eines Repos; ob er drin bleibt, prüft der Server am aufgelösten Pfad. */
export const repoPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => !v.includes('\0') && !v.startsWith('/') && !v.includes('\\'), 'Nur relative Pfade im Repo')

export const staticSourceSchema = z.object({
  type: z.literal('static'),
  /** Entweder ein hochgeladenes ZIP ... */
  uploadId: z.string().uuid().optional(),
  /** ... oder ein Repo, optional mit Build im Wegwerf-Container. */
  repoUrl: repoUrlSchema.optional(),
  ref: gitRefSchema.optional(),
  buildCommand: z.string().min(1).max(500).optional(),
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
  webService: z.string().regex(COMPOSE_SERVICE_RE, 'Ungültiger Dienstname'),
})

export const sourceSchema = z.discriminatedUnion('type', [
  imageSourceSchema,
  staticSourceSchema,
  dockerfileSourceSchema,
  composeSourceSchema,
])
export type Source = z.infer<typeof sourceSchema>

/** Querbezüge, die ein einzelnes Feld nicht ausdrücken kann. */
export function sourceIssues(s: Source): { path: string[]; message: string }[] {
  const issues: { path: string[]; message: string }[] = []
  if (s.type === 'static') {
    if (!!s.uploadId === !!s.repoUrl) {
      issues.push({ path: ['source'], message: 'Statisch braucht entweder ein ZIP oder eine Repo-URL' })
    }
    if (s.uploadId && (s.buildCommand || s.ref)) {
      issues.push({ path: ['source', 'buildCommand'], message: 'Build-Befehl und Ref gibt es nur mit Repo' })
    }
  }
  if (s.type === 'compose' && !!s.uploadId === !!s.repoUrl) {
    issues.push({ path: ['source'], message: 'Compose braucht entweder eine hochgeladene compose.yaml oder eine Repo-URL' })
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
  key: z.string().min(1).max(128).regex(ENV_KEY_RE, 'Nur A-Z, a-z, 0-9 und _; nicht mit Ziffer beginnen'),
  value: z.string().max(8192),
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

export const createProjectSchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: slugSchema.optional(),
    source: sourceSchema,
    port: z.number().int().min(1).max(65535).optional(),
    healthcheckPath: z.string().startsWith('/').max(512).default('/'),
    env: z.array(envEntryInputSchema).max(200).default([]),
    targets: z.array(z.enum(routeTargets)).default(['lan']),
    subdomain: slugSchema.optional(),
    cpuLimit: z.number().min(0.1).max(16).optional(),
    memoryLimitMb: z.number().int().min(64).max(32768).optional(),
    keep: z.boolean().default(false),
    deploy: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (sourceNeedsPort(v.source.type) && v.port === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['port'], message: 'Port im Container ist für diese Quelle nötig' })
    }
    for (const i of sourceIssues(v.source)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: i.path, message: i.message })
    }
    for (const t of v.targets) {
      if (!(routeTargetsM1 as readonly string[]).includes(t)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targets'], message: `Ziel "${t}" kommt erst in einem späteren Meilenstein` })
      }
    }
  })
export type CreateProjectInput = z.infer<typeof createProjectSchema>

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  healthcheckPath: z.string().startsWith('/').max(512).optional(),
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
})

export const deploySchema = z.object({ ref: z.string().max(255).optional() })

export interface RouteDto {
  target: RouteTarget
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

export const loginSchema = z.object({ password: z.string().min(1).max(512) })
