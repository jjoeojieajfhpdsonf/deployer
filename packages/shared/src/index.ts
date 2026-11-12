import { z } from 'zod'
import type { PausePage } from './pause-page.js'
import type { FailureExplanation } from './failure.js'
import { SCP_REPO_RE, repoAddressKind } from './git.js'

/* ------------------------------------------------------------------ *
 * Slug
 * ------------------------------------------------------------------ */

/** 1-40 Zeichen, Kleinbuchstaben, Ziffern, Bindestrich; nicht am Rand. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

/** Produktname in Texten. */
export const PRODUCT_NAME = 'Airlock'

/**
 * Label der Oberfläche im Hostnamen: <label>.<basisdomain> und <label>.<ip>.nip.io.
 * Bleibt vorerst "deployer" (deployer.int.jherren.com), obwohl das Produkt
 * Airlock heisst; die Umstellung auf "airlock" kommt separat (docs/RENAME.md).
 */
export const UI_HOST_LABEL = 'deployer'

/**
 * Vergeben an Airlock selbst: "deployer" ist die Adresse der Oberfläche
 * (sonst hätte ein Projekt sie überdeckt – Fehler aus M1), "airlock" ihre
 * künftige Adresse, "ext-scan" das Netz für Scans externer Ziele (M6).
 */
// 'name-preview': GET /projects/name-preview würde sonst ein Projekt dieses Namens verdecken
export const RESERVED_SLUGS = ['deployer', 'airlock', 'ext-scan', 'name-preview'] as const

/**
 * Öffentliche Adressen: Namen, die in keiner Zone vergeben werden – die
 * Kurznamen oben, dazu «int» (interne Basis) und «acme-probe» (Zertifikatsprobe).
 */
// Etappe 5: «status» ist die Statusseite der Umgebung (status.<hauptzone>)
export const RESERVED_PUBLIC_LABELS = [...RESERVED_SLUGS, 'int', 'acme-probe', 'status'] as const

/**
 * Rein: Eingabe für den Namen einer öffentlichen Adresse beim Tippen
 * normalisieren – Kleinbuchstaben, ä/ö/ü → ae/oe/ue, ß → ss, Leerzeichen und
 * andere Zeichen → Bindestrich, nur a–z 0–9 -, keine doppelten oder
 * randständigen Bindestriche, höchstens 63 Zeichen.
 */
export function normalizePublicLabel(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 63)
  // Ende erst nach dem Kürzen bereinigen (sonst bliebe «abc-» stehen)
  return s.replace(/-+$/, '').replace(/-{2,}/g, '-')
}

/**
 * Rein: ein eingefügter voller Name (auch mit https:// und Pfad) in Name und
 * Zone zerlegen, wenn er in einer der Zonen liegt. Längste Zone gewinnt;
 * genau die Zone ergibt apex. Sonst null.
 */
export function splitPublicHost(input: string, zones: readonly string[]): { label: string; zone: string; apex: boolean } | null {
  const host = input.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#:].*$/, '').replace(/\.$/, '')
  if (!host.includes('.')) return null
  const zone = [...zones].map((z) => z.toLowerCase()).sort((a, b) => b.length - a.length).find((z) => host === z || host.endsWith(`.${z}`))
  if (!zone) return null
  if (host === zone) return { label: '', zone, apex: true }
  return { label: host.slice(0, -(zone.length + 1)), zone, apex: false }
}

/** Ergebnis der Prüfung eines öffentlichen Namens (Veröffentlichen, Adresse ändern, Neues Projekt) */
export interface PublicNameCheckDto {
  host: string | null
  label: string
  zone: string | null
  apex: boolean
  zones: string[]
  problems: { kind: 'format' | 'reserved' | 'zone' | 'internal' | 'taken' | 'dns' | 'depth'; message: string }[]
  /** Vorhandener DNS-Eintrag, der nicht von Airlock stammt (Übernehmen nur nach Bestätigung) */
  existing: { type: string; content: string; worker: boolean } | null
}

export const slugSchema = z
  .string()
  .min(1, 'Gib einen Kurznamen an, z.B. solar-heute')
  .max(40, 'Höchstens 40 Zeichen, z.B. solar-heute')
  .regex(SLUG_RE, 'Nur Kleinbuchstaben, Ziffern und Bindestrich, nicht am Anfang oder Ende, z.B. solar-heute')
  .refine((s) => !(RESERVED_SLUGS as readonly string[]).includes(s), 'Dieser Name ist für Airlock selbst reserviert; wähle einen anderen, z.B. mein-airlock')

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
 * Nacht 3, Etappe 2: auch SSH (ssh://git@host/pfad oder git@host:pfad) –
 * nur zusammen mit einem Deploy-Key.
 */
export const repoUrlSchema = z
  .string({ required_error: 'Gib die Adresse des Repos an, z.B. https://github.com/user/app.git' })
  .trim()
  .min(1, 'Gib die Adresse des Repos an, z.B. https://github.com/user/app.git')
  .max(2048, 'Die Repo-Adresse ist zu lang (höchstens 2048 Zeichen)')
  .refine(
    (v) => /^https?:\/\/[^\s]+$/i.test(v) || /^ssh:\/\/[^\s]+$/i.test(v) || SCP_REPO_RE.test(v),
    'Die Repo-Adresse beginnt mit https:// (http:// im LAN) oder ist eine SSH-Adresse wie git@gitlab.com:user/app.git',
  )

/** Branch, Tag oder Commit. Nie mit "-" am Anfang (sonst eine Git-Option). */
export const gitRefSchema = z
  .string()
  .trim()
  .min(1, 'Gib einen Branch, Tag oder Commit an, z.B. main – oder lass das Feld leer')
  .max(255, 'Höchstens 255 Zeichen')
  .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, 'Nur Buchstaben, Ziffern und . _ / -, nicht mit - beginnend, z.B. main oder v1.2.0')
  .refine((v) => !v.includes('..'), 'Zwei Punkte hintereinander sind nicht erlaubt, z.B. v1.2.0 statt v1..2')

/**
 * Pfad innerhalb eines Repos; ob er drin bleibt, prüft der Server am aufgelösten Pfad.
 * UI-Qualität 5: die Beispiele der Meldungen passen zum Feld (wie Platzhalter und Hinweis).
 */
const repoPath = (what: string, example: string) => z
  .string()
  .trim()
  .min(1, `Gib ${what} an, z.B. ${example}`)
  .max(512, 'Höchstens 512 Zeichen')
  .refine((v) => !v.includes('\0') && !v.startsWith('/') && !v.includes('\\'), `Gib den Pfad relativ zum Repo an, ohne / am Anfang, z.B. ${example}`)

export const repoPathSchema = repoPath('einen Pfad im Repo', 'docker/Dockerfile')
const dockerfilePathSchema = repoPath('den Pfad des Dockerfiles', 'Dockerfile oder docker/Dockerfile')
const contextPathSchema = repoPath('den Ordner, aus dem gebaut wird', '. (die Wurzel) oder app')
const composePathSchema = repoPath('den Pfad der compose.yaml', 'compose.yaml oder app/compose.yaml')
const outputDirSchema = repoPath('den Ausgabeordner', 'dist')

export const staticSourceSchema = z.object({
  type: z.literal('static'),
  /** Entweder ein hochgeladenes ZIP ... */
  uploadId: z.string().uuid().optional(),
  /** ... oder ein Repo, optional mit Build im Wegwerf-Container. */
  repoUrl: repoUrlSchema.optional(),
  ref: gitRefSchema.optional(),
  buildCommand: z.string().trim().min(1, 'Gib einen Befehl an, z.B. npm run build – oder lass das Feld leer').max(500, 'Höchstens 500 Zeichen').optional(),
  outputDir: outputDirSchema.optional(),
})

export const dockerfileSourceSchema = z.object({
  type: z.literal('dockerfile'),
  repoUrl: repoUrlSchema,
  ref: gitRefSchema.optional(),
  dockerfile: dockerfilePathSchema.default('Dockerfile'),
  context: contextPathSchema.default('.'),
})

export const COMPOSE_SERVICE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/

export const composeSourceSchema = z.object({
  type: z.literal('compose'),
  /** Entweder ein Repo ... */
  repoUrl: repoUrlSchema.optional(),
  ref: gitRefSchema.optional(),
  composePath: composePathSchema.default('compose.yaml'),
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
  outputDir: outputDirSchema.optional(),
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

/** CPU-Grenze in Kernen (1 = ein voller Kern) */
export const cpuLimitSchema = z
  .number({ invalid_type_error: 'Gib die CPU-Grenze als Zahl an, z.B. 1 oder 0.5', required_error: 'Gib die CPU-Grenze an, z.B. 1' })
  .min(0.1, 'Mindestens 0.1 CPU')
  .max(16, 'Höchstens 16 CPU')

/** RAM-Grenze in MB */
export const memoryLimitSchema = z
  .number({ invalid_type_error: 'Gib die RAM-Grenze in MB an, z.B. 512', required_error: 'Gib die RAM-Grenze an, z.B. 512' })
  .int('Ganze Megabyte, z.B. 512 oder 1024')
  .min(64, 'Mindestens 64 MB')
  .max(32768, 'Höchstens 32768 MB')

/** Öffentlicher Name (M5): Form hier, Zone und Belegung prüft der Server. */
export const publicHostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Gib einen Namen an, z.B. solar oder solar.deinedomain.ch')
  .max(253, 'Höchstens 253 Zeichen')
  .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/, 'Nur Buchstaben, Ziffern, Bindestrich und Punkte, z.B. solar.deinedomain.ch')

/** Name einer öffentlichen Adresse (ein Label vor der Zone), nach normalizePublicLabel */
export const publicLabelSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)$/, 'Nur a–z, 0–9 und Bindestrich, höchstens 63 Zeichen, z.B. solar')

/**
 * Öffentlich nach dem ersten Scan (Neues Projekt): Name und Zone getrennt,
 * apex nur ausdrücklich. Wird als bestätigte Öffentlich-Anfrage vorgemerkt.
 */
export const createPublicSchema = z.object({
  subdomain: publicLabelSchema.optional(),
  zone: publicHostnameSchema.optional(),
  apex: z.boolean().optional(),
  accessProtected: z.boolean().optional(),
})

export const createProjectSchema = z
  .object({
    name: projectNameSchema,
    slug: slugSchema.optional(),
    source: sourceSchema,
    port: portSchema.optional(),
    healthcheckPath: healthcheckPathSchema.default('/'),
    env: z.array(envEntryInputSchema).max(200).default([]),
    // Tailscale ist die Hauptadresse des Servers; LAN braucht für eigene Namen einen lokalen DNS
    targets: z.array(z.enum(routeTargets)).default(['tailnet']),
    subdomain: slugSchema.optional(),
    cpuLimit: cpuLimitSchema.optional(),
    memoryLimitMb: memoryLimitSchema.optional(),
    keep: z.boolean().default(false),
    deploy: z.boolean().default(true),
    /** M3: Anfangsdateien bei Quelle files. Grenzen prüft der Server. */
    files: z.array(fileInputSchema).max(2000).optional(),
    /** Nach dem ersten Scan ohne kritischen Befund öffentlich schalten (bestätigt beim Anlegen) */
    public: createPublicSchema.optional(),
    /** Nacht 3, Etappe 2: Deploy-Key oder Token (vorher unter /git/credentials angelegt) für ein privates Repo */
    gitCredentialId: z.string().uuid().optional(),
  })
  .superRefine((v, ctx) => {
    const repoUrl = 'repoUrl' in v.source ? v.source.repoUrl : undefined
    if (v.gitCredentialId && !repoUrl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gitCredentialId'], message: 'Einen Zugang gibt es nur bei einer Quelle aus einem Git-Repo' })
    }
    if (repoUrl && repoAddressKind(repoUrl) === 'ssh' && !v.gitCredentialId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source', 'repoUrl'], message: 'Eine SSH-Adresse braucht einen Deploy-Key: unter «Zugang» Deploy-Key wählen – oder die https://-Adresse nehmen' })
    }
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

/** UI-Qualität 5: Vorschau von Kurzname und Adresse beim Anlegen */
export interface NamePreviewDto {
  /** Kurzname aus dem Namen */
  wanted: string
  /** Kurzname, den das Projekt bekäme (bei Kollision «-2» usw.); leer, wenn keiner frei ist */
  slug: string
  /** Projekt, das den gewünschten Kurznamen schon trägt */
  takenBy: { id: string; name: string } | null
  /** Für Airlock selbst reserviert */
  reserved: boolean
  /** Die Adresse des gewünschten Kurznamens trägt schon ein anderes Projekt (eigene Subdomain) */
  hostTaken?: boolean
  /** Interne Adresse (Tailnet/LAN) */
  host: string | null
  urls: string[]
}

export const updateProjectSchema = z.object({
  name: projectNameSchema.optional(),
  port: portSchema.optional(),
  healthcheckPath: healthcheckPathSchema.optional(),
  cpuLimit: cpuLimitSchema.optional(),
  memoryLimitMb: memoryLimitSchema.optional(),
  keep: z.boolean().optional(),
  /** Etappe 5: «Auf Statusseite zeigen»; null = Standard (öffentlich an, intern aus) */
  showOnStatus: z.boolean().nullable().optional(),
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
  /** Öffentlich: seit wann der Name besteht (ISO). */
  since?: string
  /** Öffentlich pausiert seit (ISO); null/fehlend = live. */
  pausedAt?: string | null
}

/* --- Veröffentlichung ------------------------------------------------------ */

/**
 * Privat: keine öffentliche Route. Live: Cloudflare liefert das Projekt aus.
 * Pausiert: Name, DNS und Tunnel-Regel bleiben, Caddy antwortet mit einer
 * neutralen Wartungsseite (503).
 */
export type PublicState = 'private' | 'live' | 'paused'

export function publicStateOf(routes: RouteDto[]): PublicState {
  const r = routes.find((x) => x.target === 'public')
  if (!r) return 'private'
  return r.pausedAt ? 'paused' : 'live'
}

/** Übergänge der Karte «Veröffentlichung»; access = nur Cloudflare Access an/aus. */
export type PublicOp = 'publish' | 'pause' | 'resume' | 'unpublish' | 'access'

export type PublicStepState = 'todo' | 'current' | 'done' | 'failed' | 'warn' | 'skipped'

export interface PublicStepDto {
  key: 'check' | 'dns' | 'access' | 'tunnel' | 'caddy' | 'outside'
  label: string
  state: PublicStepState
  /** Ergebnis oder Grund in einem Satz (bei warn/failed immer gesetzt). */
  detail?: string
}

export interface PublicProgressDto {
  op: PublicOp
  hostname: string | null
  steps: PublicStepDto[]
  startedAt: string
  finishedAt: string | null
  /** null solange es läuft */
  ok: boolean | null
  error?: string
}

/** Prüfung eines öffentlichen Namens von aussen (über Cloudflare). */
export interface OutsideCheckDto {
  ok: boolean
  status: number | null
  viaCloudflare: boolean
  message: string
}

export interface PublicRequestDto {
  requestedAt: string
  actor: string
  hostname: string | null
  accessProtected: boolean
  /** In der Oberfläche bestätigt: wird nach dem nächsten bestandenen Scan wirksam */
  approvedBy: string | null
  approvedAt: string | null
  /**
   * waiting: wartet auf abgeschlossenen Scan ohne kritischen Befund;
   * blocked: kritischer Befund offen; ready: Scan bestanden, wartet nur auf
   * die Bestätigung; failed: der automatische Versuch scheiterte (lastError).
   */
  state: 'waiting' | 'blocked' | 'ready' | 'failed'
  /** Ein Satz für Oberfläche und MCP */
  text: string
  lastError: string | null
}

export interface PublicStatusDto {
  state: PublicState
  /** Cloudflare-Tunnel eingerichtet? Sonst lässt sich nichts veröffentlichen. */
  enabled: boolean
  hostname: string | null
  url: string | null
  /** Live: seit wann öffentlich; pausiert: seit wann pausiert. */
  since: string | null
  accessProtected: boolean
  /** Interne Adresse, die unabhängig davon weiter funktioniert. */
  internalUrl: string | null
  /**
   * Lässt sich das Projekt jetzt veröffentlichen (bzw. fortsetzen)? why:
   * no_scan, scan_running, critical (offener kritischer Befund), disabled.
   */
  publishable: { ok: true } | { ok: false; why: 'no_scan' | 'scan_running' | 'critical' | 'disabled'; reason: string }
  /**
   * Vorgemerkte Öffentlich-Anfrage (etwa von MCP create_project), die nach
   * bestandenem Scan wirksam werden soll – nie still: erst nach Bestätigung
   * in der Oberfläche (approvedBy).
   */
  pendingRequest: PublicRequestDto | null
  /** Pause-Seite: eigene des Projekts (null = Vorlage), «Voraussichtlich zurück», die Vorlage */
  pause: { page: PausePage | null; backAt: string | null; template: PausePage }
  /** Letzter oder laufender Übergang (nur im Speicher des Servers). */
  progress: PublicProgressDto | null
}

export const publishPublicSchema = z.object({
  publicSubdomain: publicLabelSchema.optional(),
  publicHostname: publicHostnameSchema.optional(),
  /** Zone der Umgebung zum Namen (Standard: Hauptzone) */
  publicZone: publicHostnameSchema.optional(),
  /** Direkt unter der Zone (Schalter «Direkt unter <zone>») */
  publicApex: z.boolean().optional(),
  /** Vorhandenen fremden DNS-Eintrag ersetzen – nur nach ausdrücklicher Bestätigung */
  takeOverDns: z.boolean().optional(),
  accessProtected: z.boolean().optional(),
})

/** Prüfung eines öffentlichen Namens (GET …/public/check) */
export const publicNameCheckQuerySchema = z.object({
  name: z.string().max(300).default(''),
  zone: publicHostnameSchema.optional(),
  apex: z.enum(['0', '1']).optional(),
})

/** Tailnet und LAN allein speichern, ohne die öffentliche Route anzufassen. */
export const putInternalRoutesSchema = z.object({
  targets: z.array(z.enum(['lan', 'tailnet'])),
  subdomain: slugSchema.optional(),
})

/* --- Adressen-Prüfung ------------------------------------------------------ */

/**
 * Ergebnis der Prüfung einer Adresse vom Server aus (GET
 * /projects/:id/address-check). routed: Caddy kennt den Namen, der IP-Filter
 * hält aber Airlock selbst ab – die Antwort des Projekts bleibt offen.
 */
export interface AddressCheckDto {
  url: string
  state: 'ok' | 'routed' | 'unknown' | 'down' | 'error'
  detail: string
  checkedAt: string
}

/**
 * Darf der Browser die Adresse selbst prüfen? Nicht, wenn die Oberfläche über
 * https läuft und die Adresse http ist: das blockiert der Browser als Mixed
 * Content, die Prüfung meldete fälschlich «nicht erreichbar».
 */
export function browserCanProbe(url: string, pageProtocol: string): boolean {
  return !(pageProtocol === 'https:' && url.startsWith('http:'))
}

export interface AddressRowInput { url: string; ways: string[]; access: boolean }

/**
 * Teilt die Adressen eines Projekts in Haupt- und weitere Adressen. Läuft
 * eine interne Route über https (Wildcard-Zertifikat aktiv), sind ihre
 * http-Aliase (nip.io) nur noch Ausweichnamen und wandern unter «Weitere
 * Adressen». Ohne Zertifikat bleibt alles oben.
 */
export function splitAddresses(routes: RouteDto[]): { primary: AddressRowInput[]; more: AddressRowInput[] } {
  const primary: AddressRowInput[] = []
  const more: AddressRowInput[] = []
  for (const r of routes) {
    const ways = (r.targets ?? [r.target]) as string[]
    const secure = r.urls.some((u) => u.startsWith('https:'))
    for (const url of r.urls) {
      const host = url.replace(/^https?:\/\//, '')
      const row = { url, ways, access: Boolean(r.accessProtected) }
      if (secure && url.startsWith('http:') && r.aliases.includes(host)) more.push(row)
      else primary.push(row)
    }
  }
  return { primary, more }
}

export interface DeploymentDto {
  id: string
  projectId: string
  version: string | null
  sourceRef: string | null
  status: DeploymentStatus
  errorMessage: string | null
  /** UI-Qualität 2: Erklärung eines gescheiterten Deploys, beim Scheitern festgehalten (Fehlerbox, Pille, Listen) */
  failure?: FailureExplanation | null
  startedAt: string
  finishedAt: string | null
  isActive: boolean
  durationMs: number | null
  /** M2 */
  trigger: 'deploy' | 'rollback'
  rollbackOf: string | null
  /** Lässt sich auf diese Fassung zurückrollen (Artefakt noch vorhanden, nicht aktiv)? */
  canRollback: boolean
  /**
   * Warum deployt wurde (Titel der Zeile). Neue Einträge speichern ihn beim
   * Start, ältere leitet die API aus dem Audit-Log ab; ohne Hinweis «redeploy».
   */
  reason?: DeployReason
  /** Wer ausgelöst hat: «ui:…», «token:<Name>», «system:…»; null = unbekannt (alt) */
  actor?: string | null
  /** Betreff des Commits dieser Fassung, soweit bekannt (Chat-Projekte, Repo) */
  message?: string | null
  /** Laufende Nummer im Projekt (#1 = erstes Deployment) */
  seq?: number
}

export const deployReasonKinds = [
  'first', 'code', 'redeploy', 'rollback', 'recreate', 'headers', 'public', 'internal', 'paused', 'auto_merge', 'start',
] as const
export type DeployReasonKind = (typeof deployReasonKinds)[number]

export interface DeployReason {
  kind: DeployReasonKind
  /** code/auto_merge: Commit-Nachricht; headers: Header-Name; public: Hostname */
  detail?: string | null
}

/** Titel einer Deployment-Zeile aus dem Grund, z. B. «Erstes Deployment», «Hintergrund blau». */
export function deployReasonTitle(r: DeployReason | undefined | null, message?: string | null): string {
  const d = r?.detail?.trim()
  switch (r?.kind) {
    case 'first': return 'Erstes Deployment'
    case 'code': return d || message?.trim() || 'Code geändert'
    case 'auto_merge': return 'Auto-Deploy nach Merge'
    case 'rollback': return 'Zurückgerollt'
    case 'recreate': return 'Neu erstellt'
    case 'headers': return d ? `Header geändert: ${d}` : 'Header geändert'
    case 'public': return 'Öffentlich gemacht'
    case 'internal': return 'Erreichbarkeit intern geändert'
    case 'paused': return 'Öffentlich pausiert'
    case 'start': return 'Gestartet'
    default: return 'Neu deployt'
  }
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
  /**
   * Etappe 5: «Auf Statusseite zeigen» – ausdrücklich gesetzt (true/false) oder
   * null = Standard (öffentlich an, intern aus; showsOnStatusPage). Fehlt bei
   * älteren Antworten.
   */
  showOnStatus?: boolean | null
  /**
   * Nacht 3, Etappe 4: Ausgang der Container (bei Vorschauen der des Projekts).
   * Fehlt bei älteren Antworten.
   */
  egress?: { mode: import('./egress.js').EgressMode; enforce: boolean }
  /** Läuft der Container als root? Nur Hinweis, kein Fehler (siehe Plan). */
  runsAsRoot: boolean | null
  /** M3: wie das Projekt zur Laufzeit behandelt wird (bei files: die erkannte Art). */
  runtimeKind: 'image' | 'dockerfile' | 'static' | 'compose'
  /** M3, nur Quelle files: als was die aktive Fassung erkannt wurde. */
  filesKind: 'compose' | 'dockerfile' | 'static-build' | 'static' | null
  lastChangeAt: string
  /** M3: wann ein Chat-Projekt ohne Änderung gestoppt wird; null = läuft nicht ab. */
  expiresAt: string | null
  /** Projektseite: Frist der Chat-Projekte in Tagen (System-Einstellungen); null bei anderen Quellen */
  expiryDays?: number | null
  /** Projektseite (nur GET /projects/:id): wer das Projekt angelegt hat, z. B. «mcp:claude-code-mac» */
  createdBy?: string | null
  /** M6: letzter Scan in Kurzform. */
  security: {
    scanId: string
    status: ScanStatus
    score: number | null
    grade: 'A' | 'B' | 'C' | 'D' | null
    finishedAt: string | null
    /** Offene Befunde des letzten Scans nach Schwere */
    open: Record<'critical' | 'high' | 'medium' | 'low', number>
  } | null
  /** Letzter Deploy-Versuch, auch laufend oder gescheitert (für Übersicht und Banner) */
  lastDeployment: DeploymentDto | null
  /**
   * Übergang deployer → Airlock: läuft noch mit Containern aus der
   * deployer-Zeit (alte Labels und Namen). «Neu erstellen» ersetzt sie.
   */
  legacyContainers: boolean
  /**
   * UI-Qualität 1: Zustand fertig berechnet (einzige Quelle für Pille,
   * Unterzeile, Fehlerbox und Deployments-Liste). Siehe projectState().
   */
  state: ProjectStateDto
}

/* --- Stufen des Scans: ein Name überall (Oberfläche, Fortschritt, MCP) ---------------- */

export const SCAN_STAGE_LABEL: Record<string, string> = {
  'trivy-image': 'Abhängigkeiten & Image (Trivy)',
  'trivy-source': 'Eigener Code',
  headers: 'Security-Header',
  'zap-baseline': 'Webseite passiv (ZAP)',
  'zap-full': 'Webseite aktiv (ZAP)',
  nuclei: 'Offene Dateien & Panels (Nuclei)',
  testssl: 'TLS',
}
/** Name einer Stufe; «trivy-image nginx:1» → Name der Grundstufe */
export const scanStageLabel = (key: string): string => SCAN_STAGE_LABEL[key.split(' ')[0]!] ?? key

/* --- Befunde zählen: eine Funktion für «offen» --------------------------------------- */

export type SeverityCounts = Record<'critical' | 'high' | 'medium' | 'low', number>

/**
 * Offene Befunde nach Schwere – «offen» heisst: weder akzeptiert noch behoben.
 * Grundlage für jede Zahl in der Oberfläche (Kopf, Zähler-Pillen,
 * Reiter-Badge, Seitenleiste, Projektkarte) und für die Kurzform am Projekt.
 */
export function countOpenFindings(findings: readonly { status: string; severity: string }[]): SeverityCounts {
  const c: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const f of findings) if (f.status === 'open' && f.severity in c) c[f.severity as keyof SeverityCounts]++
  return c
}
/** Alle offenen Befunde */
export const openTotal = (c: SeverityCounts | null | undefined): number => (c ? c.critical + c.high + c.medium + c.low : 0)
/** Offene kritische und hohe Befunde (Badge der Seitenleiste) */
export const openUrgent = (c: SeverityCounts | null | undefined): number => (c ? c.critical + c.high : 0)
/** Summe über mehrere Projekte */
export function sumCounts(list: readonly (SeverityCounts | null | undefined)[]): SeverityCounts {
  const c: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const x of list) if (x) for (const k of Object.keys(c) as (keyof SeverityCounts)[]) c[k] += x[k]
  return c
}

/* --- Projektzustand: eine Quelle ------------------------------------------------- */

export const projectStateKeys = ['deploying', 'stopped', 'paused', 'failed_old_running', 'running', 'down'] as const
export type ProjectStateKey = (typeof projectStateKeys)[number]

export interface ProjectStateDto {
  key: ProjectStateKey
  /** Wort für die Pille */
  label: string
  /** Ton der Pille (immer mit Wort, nie nur Farbe) */
  tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral'
  /** Unterzeile in einem Satz; null, wenn die Pille alles sagt */
  detail: string | null
}

const STATE_TEXT: Record<ProjectStateKey, { label: string; tone: ProjectStateDto['tone'] }> = {
  running: { label: 'läuft', tone: 'ok' },
  failed_old_running: { label: 'neue Version gescheitert, alte läuft weiter', tone: 'warn' },
  stopped: { label: 'gestoppt', tone: 'neutral' },
  paused: { label: 'pausiert', tone: 'warn' },
  deploying: { label: 'deployt gerade', tone: 'info' },
  down: { label: 'nichts läuft', tone: 'bad' },
}

/** Läuft gerade ein Deploy (Schritt vor «aktiv»)? */
const DEPLOY_RUNNING = new Set(['pending', 'pulling', 'starting', 'healthchecking'])

/**
 * Der Zustand eines Projekts, in dieser Reihenfolge entschieden:
 *   deployt gerade → gestoppt (gewollt) → nichts läuft (Container weg/beendet
 *   oder keine aktive Fassung) → pausiert (öffentlich pausiert, intern läuft
 *   es) → neue Version gescheitert, alte läuft weiter → läuft.
 * container: letzter bekannter Zustand vom Server (Monitor); null = unbekannt
 * oder ohne Container (statische Seite).
 */
export function projectState(p: {
  status: ProjectStatus
  desiredState: DesiredState
  activeDeployment: { id: string } | null
  lastDeployment: { id: string; status: DeploymentStatus; errorMessage?: string | null; failure?: { title: string } | null } | null
  routes: { target: string; pausedAt?: string | null }[]
  container?: { running: boolean; missing?: boolean; exitCode?: number | null } | null
}): ProjectStateDto {
  const make = (key: ProjectStateKey, detail: string | null, tone?: ProjectStateDto['tone']): ProjectStateDto => ({ key, ...STATE_TEXT[key], ...(tone ? { tone } : {}), detail })
  const last = p.lastDeployment
  if (p.status === 'deploying' || (last && DEPLOY_RUNNING.has(last.status))) return make('deploying', null)
  // Ohne aktive Fassung zuerst: Ein neues Projekt steht bis zum ersten erfolgreichen Deploy auf
  // «stopped»; ein gescheiterter erster Deploy darf nicht als «gestoppt» erscheinen.
  if (!p.activeDeployment) {
    return last?.status === 'failed'
      ? make('down', 'Der erste Deploy ist gescheitert; es gibt noch keine laufende Fassung.')
      // Noch nie deployt: kein Fehler, also neutral
      : make('down', 'Noch nicht deployt.', 'neutral')
  }
  if (p.desiredState === 'stopped') return make('stopped', 'Gestoppt – die Adressen antworten nicht, bis du es wieder startest.')
  if (p.container && !p.container.running) {
    return make('down', p.container.missing
      ? 'Der Container der aktiven Fassung fehlt.'
      : `Der Container hat sich beendet${p.container.exitCode != null ? ` (Exit-Code ${p.container.exitCode})` : ''}.`)
  }
  const failedNewer = last?.status === 'failed' && last.id !== p.activeDeployment.id
  if (p.routes.some((r) => r.target === 'public' && r.pausedAt)) {
    return make('paused', failedNewer ? 'Öffentlich pausiert; intern läuft die alte Fassung, der letzte Deploy ist gescheitert.' : 'Öffentlich pausiert; intern läuft es weiter.')
  }
  // Grund wie in der Fehlerbox (Titel der Erklärung), sonst die rohe Meldung
  if (failedNewer) return make('failed_old_running', last?.failure?.title ?? last?.errorMessage ?? null)
  return make('running', null)
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

export type ScanStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

/** Eine Scan-Stufe, von Anfang an geplant und laufend aktualisiert. */
export interface ScanStageDto {
  ran: boolean
  note?: string
  findings?: number
  /** lief an und scheiterte (anders als «nicht anwendbar») */
  failed?: boolean
  state?: 'waiting' | 'running' | 'done' | 'skipped' | 'failed' | 'timeout' | 'cancelled'
  /** Was die Stufe prüft (Kurzbeschreibung) */
  checks?: string
  /** Was tatsächlich abgedeckt wurde, z. B. «214 Pakete aus pnpm-lock.yaml» */
  checked?: string
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  timeoutMs?: number
  /** Fortschritt, soweit bekannt (DB-Download, gecrawlte URLs) */
  progress?: string
  /** Letzte Zeilen der Scanner-Ausgabe */
  tail?: string[]
}

export interface ScanReportDto {
  scan: {
    id: string
    status: ScanStatus
    level: 'standard' | 'active'
    startedAt: string
    finishedAt: string | null
    score: number | null
    grade: 'A' | 'B' | 'C' | 'D' | null
    error: string | null
    stages: Record<string, ScanStageDto>
    trigger: 'deploy' | 'mcp' | 'manual' | 'schedule' | null
    actor: string | null
    /** Solange der Scan wartet: Position (1 = als Nächstes), Scans davor */
    queue: { position: number; ahead: number } | null
    /** Score des vorherigen abgeschlossenen Scans; null = erster Scan */
    previousScore?: number | null
    /** Projekte: frühester nächster automatischer Scan (wöchentlich) */
    nextScheduledAt?: string | null
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
  /** Netz des Servers: erkannt vom Host (stündlich) oder aus .env (Docker Desktop) */
  network: {
    mode: 'detected' | 'env'
    checkedAt: string | null
    lanIp: string | null
    lanCidr: string
    lanDev: string | null
    tailscaleIp: string | null
    tailscaleSource: 'eingetragen' | 'erkannt' | null
    detectedTailscaleIp: string | null
  }
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
    /** Nacht 3, Etappe 3: belegt in Prozent wie `df` (Hinweis ab 80 %, Deploys gesperrt ab 95 %) */
    diskPercent?: number | null
  }
  scanQueue: number
  /** M5: Cloudflare Tunnel */
  publicTunnel: { configured: boolean; status: string | null; connections: number }
  /**
   * Absender, die Caddy bei Anfragen auf Airlock sieht (letzte 30 Minuten,
   * Zugriffs-Log). fromGateway > 0: Anfragen kamen maskiert von einem
   * Docker-Gateway an (Tailscale als Subnet-Router, docs/INSTALL.md).
   * null: Log nicht lesbar.
   */
  /**
   * Absender der Anfragen auf Airlock (30 Minuten, Zugriffs-Log): nur fremde
   * Anfragen; eigene Prüfungen («airlock-probe») stehen in ownProbes.
   */
  clientIps: {
    total: number; fromGateway: number; gatewayIps: string[]; gatewayOnly: boolean; blocked: number; since: string
    ownProbes: number
    groups: { source: 'tailnet' | 'server'; count: number; blocked: number; hosts: string[]; paths: string[]; userAgents: string[]; last: string }[]
  } | null
  /** Namen, die der Browser selbst prüfen soll: Weg -> URL */
  reachability: { way: 'dns' | 'nipio' | 'hosts'; label: string; url: string | null }[]
}

/** Projektseite, Reiter «Zugriffe» (statische Seiten): ein Aufruf aus Caddys Zugriffs-Log */
export interface SiteAccessEntryDto {
  at: string
  method: string
  path: string
  status: number
  durationMs: number | null
  bytes: number | null
  /** gekürzt: «192.168.1.x» */
  ip: string
  host: string
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
  /** M9: Umgebung des Eintrags; null = Server-Ereignis (gilt für alle Umgebungen) */
  environmentId: string | null
  server: boolean
}

/* --- M9: Umgebungen ------------------------------------------------------- */

export interface EnvironmentDto {
  id: string
  slug: string
  name: string
  /** Kürzel aus zwei Zeichen, im Umschalter neben dem Namen */
  short: string
  isDefault: boolean
  /** Hauptzone, z. B. «jherren.com»; null = noch nicht gewählt */
  zone: string | null
  /** Interne Basis, z. B. «int.jherren.com» */
  baseDomain: string | null
  projects: number
  /** Offene kritische Befunde (Zahl, im Umschalter mit Wort) */
  critical: number
  /** Präfix der internen Basis («int») */
  internalPrefix: string
  /** Cloudflare: Konto (Name) und ob es mit anderen Umgebungen geteilt ist */
  account: { name: string | null; sharedWith: string[] } | null
  /** Zertifikat der internen Basis */
  tlsPhase: CfTlsPhase
  accessDefault: boolean
  accessEmails: string[]
  notifyMuted: boolean
  externalTargets: number
}

/** Slug einer Umgebung: steht in der Adresse /u/<slug>/… */
export const environmentSlugSchema = z.string().trim().min(2, 'Mindestens 2 Zeichen').max(40, 'Höchstens 40 Zeichen')
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Nur Kleinbuchstaben, Ziffern und Bindestriche, nicht am Anfang oder Ende')

export const createEnvironmentSchema = z.object({
  name: z.string().trim().min(1, 'Name fehlt').max(60),
  slug: environmentSlugSchema,
  short: z.string().trim().min(1, 'Kürzel fehlt').max(2, 'Höchstens zwei Zeichen').regex(/^[A-Za-z0-9]+$/, 'Nur Buchstaben und Ziffern'),
  /** Cloudflare-Token dieser Umgebung mitbenutzen (ID) */
  shareAccountOf: z.string().uuid().nullable().optional(),
  internalPrefix: z.string().trim().max(40).regex(/^[a-z0-9-]*(?:\.[a-z0-9-]+)*$/, 'Nur Kleinbuchstaben, Ziffern, Bindestriche und Punkte').default('int'),
  /** Standards (Header-Vorlagen, Pause-Seite, Access) von dieser Umgebung übernehmen (ID) */
  copyStandardsFrom: z.string().uuid().nullable().optional(),
})
export type CreateEnvironmentInput = z.infer<typeof createEnvironmentSchema>

export const updateEnvironmentSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  short: z.string().trim().min(1).max(2).regex(/^[A-Za-z0-9]+$/).optional(),
  accessDefault: z.boolean().optional(),
  accessEmails: z.array(z.string().trim().email('Keine gültige E-Mail-Adresse')).max(20).optional(),
  notifyMuted: z.boolean().optional(),
  /** Zur Standard-Umgebung machen (Adresse der Oberfläche wandert mit) */
  makeDefault: z.literal(true).optional(),
  /** Assistent, Schritt 2: Cloudflare-Token dieser Umgebung mitbenutzen (nur solange noch kein eigenes da ist) */
  shareAccountOf: z.string().uuid().optional(),
})
export type UpdateEnvironmentInput = z.infer<typeof updateEnvironmentSchema>

/** Header-Vorlage einer Umgebung (ohne CSP) */
export interface HeaderTemplateDto {
  header: HeaderKeyName
  value: string
  mode: 'enforce' | 'report-only'
  /** Projekte der Umgebung, für die sie gilt (ohne eigene Regel, nicht abgeschaltet) */
  appliesTo: number
  projects: number
  /** Projekte mit eigener Regel oder abgeschaltet */
  overriddenBy: { project: string; mode: 'own' | 'off' }[]
}
/** Header, die eine Umgebung vorgeben kann (CSP bleibt pro Projekt) */
export const templateHeaderKeys = ['x-content-type-options', 'referrer-policy', 'frame-ancestors', 'strict-transport-security'] as const
export type HeaderKeyName = (typeof templateHeaderKeys)[number]

/** Lokaler DNS: greift die Umschreibung *.<basis> → Server? */
export interface LanDnsCheckDto {
  baseDomain: string | null
  /** Zeile zum Kopieren (AdGuard/Pi-hole/dnsmasq) */
  line: string | null
  expected: string | null
  resolved: string[]
  ok: boolean
  detail: string
}

/** Vorschau «In andere Umgebung verschieben» (Tabelle aus der SPEC) */
export interface MovePreviewDto {
  from: { id: string; name: string; slug: string }
  to: { id: string; name: string; slug: string }
  internal: { from: string | null; to: string | null; redirectDays: number } | null
  public: { hostname: string; paused: boolean; pendingRequest: boolean } | null
  headers: { header: string; from: string | null; to: string | null }[]
  tokensLosingAccess: string[]
  blocked: string | null
}

export const moveProjectSchema = z.object({ to: z.string().min(1), confirm: z.literal(true, { message: 'Verschieben verlangt eine Bestätigung' }) })

/* --- Cloudflare verbinden (Systemseite) ------------------------------------ */

export interface CfPermissionCheck {
  key: 'zone_read' | 'dns_edit' | 'tunnel_edit' | 'access_edit'
  label: string
  required: boolean
  ok: boolean
  /** Was genau fehlt, z.B. die Zonen ohne DNS-Recht */
  detail: string | null
}

export interface CfTokenCheckDto {
  valid: boolean
  /** Alle Pflichtrechte vorhanden */
  complete: boolean
  message: string | null
  expiresOn: string | null
  accounts: { id: string; name: string }[]
  zones: { id: string; name: string; dnsEdit: boolean }[]
  permissions: CfPermissionCheck[]
}

export type CfTlsPhase = 'off' | 'staging' | 'production' | 'done' | 'failed'

export interface CfStatusDto {
  /** ui: über die Oberfläche eingerichtet; env: alte Variablen aus .env; null: nichts */
  source: 'ui' | 'env' | null
  token: { present: boolean; source: 'ui' | 'env' | null; savedAt: string | null; lastCheck: CfTokenCheckDto | null }
  account: { id: string; name: string | null } | null
  zones: { id: string; name: string; isDefault: boolean }[]
  baseDomain: string | null
  defaultZone: string | null
  tailscaleIp: string | null
  /** Vom Host erkannt (Vorschlag für Schritt 3) */
  detectedTailscaleIp: string | null
  accessEmail: string | null
  acmeEmail: string | null
  tunnel: {
    id: string
    name: string | null
    managed: boolean
    container: { exists: boolean; running: boolean; restarting: boolean; startedAt: string | null; lastLog: string | null } | null
    status: string | null
    connections: number
    /** Version aus dem festgelegten Image-Tag, z.B. 2025.8.1 */
    version: string | null
    latestVersion: string | null
    updateAvailable: boolean
    /** Ingress-Regeln bei Cloudflare, die nicht auf Caddy zeigen */
    foreignIngress: { hostname: string | null; service: string }[]
    ingressError: string | null
  } | null
  /** Tunnel-Schritt mit «Später einrichten» übersprungen (kein Tunnel vorhanden) */
  tunnelSkipped: boolean
  tls: {
    enabled: boolean
    phase: CfTlsPhase
    ca: 'production' | 'staging'
    startedAt: string | null
    steps: { at: string; text: string; tone: 'info' | 'ok' | 'bad' }[]
    /** Rate-Limit-Schutz: frühester nächster Versuch (höchstens ein produktiver pro Stunde) */
    retryAt: string | null
    /** Ein gültiges produktives Zertifikat liegt vor; ein neuer Versuch lädt es, ohne neu zu bestellen */
    reusesCert: boolean
    cert: { issuer: string | null; validTo: string | null; daysLeft: number | null; ok: boolean; error: string | null } | null
  }
  /** Link zur Token-Seite bei Cloudflare mit vorausgefüllten Rechten */
  tokenTemplateUrl: string
  requiredPermissions: { label: string; required: boolean; why: string }[]
  publicProjects: number
}

/** Ein Messpunkt: CPU in Kernen (1 = ein voller Kern), RAM in MB. */
export interface ResourceSample { at: string; cpu: number; memMb: number }

/** Zustand eines Projekts für die Übersicht (GET /projects/:id/health). */
export interface ProjectHealthDto {
  kind: string | null
  /** missing: der Container der aktiven Fassung existiert nicht mehr */
  container: { running: boolean; missing?: boolean; startedAt: string | null; exitCode: number | null } | null
  health: { at: string; ok: boolean; status: number | null; error: string | null; ms: number; url: string; port: number | null } | null
  /** Bis zu 60 Werte, einer pro Minute */
  samples: ResourceSample[]
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
/** Namen, die nie öffentlich auflösen oder Airlock selbst gehören. */
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

/* --- Darstellung (Profilmenü) -------------------------------------------- */

/**
 * system: folgt prefers-color-scheme des Geräts. win95: verstecktes Spass-Theme,
 * erst nach der Freischaltung wählbar (unlocks enthält 'win95'; 7× auf die Version oder Konami-Code).
 * terminal (Etappe 7): grün auf schwarz, freigeschaltet durch «sudo» in der Befehlspalette.
 */
export const themePrefs = ['light', 'dark', 'system', 'win95', 'terminal'] as const
export type ThemePref = (typeof themePrefs)[number]

/**
 * Freischaltungen (Easter Eggs) pro Benutzer: eine Liste bekannter Kennungen in
 * den Präferenzen. Neue Freischaltung = neue Kennung hier (und, falls sie ein
 * Theme öffnet, ein Eintrag in THEME_UNLOCK). Einmal freigeschaltet, bleibt sie.
 */
export const unlockIds = ['win95', 'terminal'] as const
export type UnlockId = (typeof unlockIds)[number]
export const unlockIdSchema = z.enum(unlockIds, { message: 'Unbekannte Freischaltung' })
/** POST /auth/unlocks: eine Kennung hinzufügen (idempotent) */
export const unlockRequestSchema = z.object({ id: unlockIdSchema })
export type UnlockRequest = z.infer<typeof unlockRequestSchema>
/** Themes, die erst nach einer Freischaltung wählbar sind */
export const THEME_UNLOCK: Partial<Record<ThemePref, UnlockId>> = { win95: 'win95', terminal: 'terminal' }
/** Ist das Theme mit diesen Freischaltungen wählbar? */
export function themeUnlocked(theme: ThemePref, unlocks: readonly string[] | null | undefined): boolean {
  const need = THEME_UNLOCK[theme]
  return !need || (unlocks ?? []).includes(need)
}
/** Schritte des Einrichtungs-Assistenten (erster Start), in dieser Reihenfolge */
export const setupSteps = ['passwort', 'cloudflare', 'adressen', 'zertifikat', 'projekt'] as const
export type SetupStep = (typeof setupSteps)[number]
export const setupPrefsSchema = z.object({
  /** «Später»: der Assistent erscheint nicht mehr von selbst (unter System fortsetzbar) */
  dismissed: z.boolean(),
  /** Bewusst übersprungene Schritte (gelten nicht als «fehlt») */
  skipped: z.array(z.enum(setupSteps)).max(setupSteps.length),
})
export type SetupPrefs = z.infer<typeof setupPrefsSchema>
export const uiPrefsSchema = z.object({
  theme: z.enum(themePrefs, { message: 'Hell, Dunkel, Wie das Gerät, Windows 95 oder Terminal' }),
  /** Freischaltungen (Easter Eggs), z. B. 'win95'; bleiben freigeschaltet. Nur über POST /auth/unlocks */
  unlocks: z.array(unlockIdSchema).max(unlockIds.length).optional(),
  setup: setupPrefsSchema.optional(),
  /** UI-Qualität 8: Glocke – bis wann die Ereignisse gelesen sind (ISO) */
  bellSeenAt: z.string().datetime().optional(),
  /** M9: zuletzt gewählte Umgebung (Slug); alte Adressen ohne /u/… führen dorthin */
  lastEnvironment: z.string().max(64).optional(),
  /**
   * Etappe 7: Spass-Funktionen (Matrix-Regen, Disketti, Konfetti, Achievements, Snake auf der
   * 404-Seite der internen Adressen). Fehlt = an. Die Themes selbst bleiben wählbar.
   */
  fun: z.boolean().optional(),
  /** Etappe 7: Matrix-Regen während eines Deploys auch ausserhalb des Terminal-Themes. Fehlt = aus */
  matrix: z.boolean().optional(),
  /** Etappe 7: Helferfigur Disketti (nur im Windows-95-Theme). «Nie wieder» setzt false. Fehlt = an */
  disketti: z.boolean().optional(),
})
export type UiPrefs = z.infer<typeof uiPrefsSchema>
/**
 * PUT /auth/preferences: nur geänderte Teile; der Server fügt sie mit dem Bestand zusammen.
 * Freischaltungen gehen nicht über diesen Weg (POST /auth/unlocks fügt nur hinzu).
 */
export const uiPrefsPatchSchema = uiPrefsSchema.omit({ unlocks: true }).partial()
export type UiPrefsPatch = z.infer<typeof uiPrefsPatchSchema>

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
    .min(1, 'Gib das Topic an, auf das du in der ntfy-App hörst, z.B. airlock-joel')
    .max(64, 'Höchstens 64 Zeichen')
    .regex(/^[A-Za-z0-9_-]+$/, 'Nur Buchstaben, Ziffern, _ und -, z.B. airlock-joel'),
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
    .min(1, 'Gib die Absender-Adresse an, z.B. airlock@meine-domain.ch')
    .max(200, 'Höchstens 200 Zeichen')
    .regex(emailList, 'Das ist keine E-Mail-Adresse, z.B. airlock@meine-domain.ch'),
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


/* --- Cloudflare verbinden ------------------------------------------------- */

export const cfTokenSchema = z.object({
  token: z
    .string()
    .trim()
    .min(1, 'Füge das API-Token ein, das Cloudflare nach «Token erstellen» einmal anzeigt')
    .regex(/^[A-Za-z0-9_-]{30,200}$/, 'Das ist kein API-Token: 40 Zeichen aus Buchstaben, Ziffern, - und _. Der «Global API Key» geht nicht.'),
})

const optionalEmail = z
  .string()
  .trim()
  .max(200, 'Höchstens 200 Zeichen')
  .regex(/^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Das ist keine E-Mail-Adresse, z.B. joel@meine-domain.ch')
  .nullable()
  .optional()

export const cfDomainsSchema = z.object({
  baseZone: z.string().trim().min(1, 'Wähle die Zone, unter der die internen Adressen liegen'),
  baseLabel: z
    .string()
    .trim()
    .toLowerCase()
    .max(40, 'Höchstens 40 Zeichen')
    .regex(/^$|^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Ein einzelnes Label aus a-z, 0-9 und -, z.B. int'),
  defaultZone: z.string().trim().nullable(),
  accountId: z.string().trim().optional(),
  tailscaleIp: z
    .string()
    .trim()
    .regex(/^$|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/, 'Eine Tailnet-Adresse im Bereich 100.64.0.0/10, z.B. 100.101.102.103 – oder leer lassen')
    .nullable()
    .optional(),
  accessEmail: optionalEmail,
  acmeEmail: optionalEmail,
})

/* M8: Fix-Assistent (eigene Datei, damit parallele Änderungen hier nicht kollidieren) */
export * from './fix.js'

/* Pause-Seite für pausierte öffentliche Projekte (Renderer für Server und Vorschau) */
export * from './pause-page.js'

/* UI-Qualität 2: Fehler erklären – eine Erklärung für Oberfläche und MCP */
export * from './failure.js'

/* UI-Qualität 4: Logzeilen mit Zeit, Dienst und Stufe */
export * from './logs.js'

/* Meilenstein Backup: Einstellungen, Läufe, Stände */
export * from './backup.js'
/* Reiter «Aufbau»: Zugang, Eingang, Dienste, Daten eines Projekts */
export * from './topology.js'
/* Etappe 3: Besucher und Herkunft aus Caddys Zugriffs-Log */
export * from './traffic.js'
/* Etappe 4: Dienst hinzufügen und entfernen (Aufbau) */
export * from './services.js'
/* Etappe 5: öffentliche Statusseite (Daten, Renderer für Seite und RSS) */
export * from './status.js'
/* Etappe 6: Vorschau-Deploys je Branch bzw. Pull Request (nur intern) */
export * from './previews.js'
// Etappe 7: Spass-Paket (Achievements, Snake-Seite für unbekannte interne Namen)
export * from './fun.js'
// Nacht 3, Etappe 1: Passkeys, TOTP, Wiederherstellungscodes, Sitzungen, erneute Bestätigung
export * from './auth.js'
// Nacht 3, Etappe 2: private Git-Repos (GitHub-App, Deploy-Key, Token, Server-Schlüssel)
export * from './git.js'
// Nacht 3, Etappe 3: Server › Speicher (Belegung, Aufräumen, verwaiste Volumes, Warnstufen)
export * from './storage.js'
// Nacht 3, Etappe 4: Ausgang der Projekt-Container (Modus, Ausnahmen, Versuche, Firewall-Dienst)
export * from './egress.js'
