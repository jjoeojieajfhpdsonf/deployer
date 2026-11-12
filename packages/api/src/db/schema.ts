import {
  pgTable, pgEnum, uuid, text, integer, boolean, timestamp, jsonb,
  numeric, bigserial, bigint, uniqueIndex, index, customType, smallint, primaryKey, date,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import type { ScanStageDto, PausePage, DeployReason, FailureExplanation, CfTlsPhase, CfTokenCheckDto } from '@airlock/shared'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export const sourceTypeEnum = pgEnum('source_type', ['image', 'static', 'dockerfile', 'compose', 'files'])
export const projectStatusEnum = pgEnum('project_status', ['created', 'deploying', 'running', 'stopped', 'failed'])
export const desiredStateEnum = pgEnum('desired_state', ['running', 'stopped'])
export const deploymentStatusEnum = pgEnum('deployment_status', [
  'pending', 'pulling', 'starting', 'healthchecking', 'active', 'failed', 'superseded', 'rolled_back',
])
export const routeTargetEnum = pgEnum('route_target', ['public', 'lan', 'tailnet'])
export const auditResultEnum = pgEnum('audit_result', ['ok', 'error'])

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  sourceType: sourceTypeEnum('source_type').notNull(),
  sourceConfig: jsonb('source_config').notNull().default({}),
  port: integer('port'),
  healthcheckPath: text('healthcheck_path').notNull().default('/'),
  status: projectStatusEnum('status').notNull().default('created'),
  desiredState: desiredStateEnum('desired_state').notNull().default('stopped'),
  keep: boolean('keep').notNull().default(false),
  cpuLimit: numeric('cpu_limit', { precision: 4, scale: 2 }).notNull().default('1'),
  memoryLimitMb: integer('memory_limit_mb').notNull().default(512),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // M3
  localRepoPath: text('local_repo_path'),
  lastChangeAt: timestamp('last_change_at', { withTimezone: true }).notNull().defaultNow(),
  expiryWarnedAt: timestamp('expiry_warned_at', { withTimezone: true }),
  // M8: Auto-Deploy nach Merge (Polling)
  autoDeploy: boolean('auto_deploy').notNull().default(false),
  autoDeployCheckedAt: timestamp('auto_deploy_checked_at', { withTimezone: true }),
  // M9: Umgebung
  environmentId: uuid('environment_id').notNull().references(() => environments.id),
  // Etappe 5: «Auf Statusseite zeigen»; null = Standard (öffentlich an, intern aus)
  showOnStatus: boolean('show_on_status'),
  // Etappe 6: Vorschau-Projekt → Projekt, aus dem es stammt (migrations/0022_previews.sql)
  previewOf: uuid('preview_of').references((): AnyPgColumn => projects.id, { onDelete: 'cascade' }),
  // Etappe 6: am eigentlichen Projekt – Schalter, letzte Prüfung, bekannte Branch-Köpfe und PRs
  previewsEnabled: boolean('previews_enabled').notNull().default(false),
  previewsCheckedAt: timestamp('previews_checked_at', { withTimezone: true }),
  previewSeen: jsonb('preview_seen').$type<PreviewSeen>(),
})

/** Etappe 6: was Airlock vom Repo schon kennt (Branch → Kopf, Nummern offener PRs) */
export interface PreviewSeen {
  heads: Record<string, string>
  prs: number[]
}

/* --- Etappe 6: Vorschau-Deploys (migrations/0022_previews.sql) ------------------ */

export const previews = pgTable('previews', {
  projectId: uuid('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  branch: text('branch').notNull(),
  label: text('label').notNull().unique(),
  prNumber: integer('pr_number'),
  prUrl: text('pr_url'),
  headSha: text('head_sha'),
  lastPushAt: timestamp('last_push_at', { withTimezone: true }).notNull().defaultNow(),
  commentId: bigint('comment_id', { mode: 'number' }),
  commentHash: text('comment_hash'),
  checkRunId: bigint('check_run_id', { mode: 'number' }),
  checkSha: text('check_sha'),
  checkHash: text('check_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('previews_parent_id_branch_key').on(t.parentId, t.branch), index('previews_parent_idx').on(t.parentId)])

/** Variablen-Ebene «Vorschau» eines Projekts (erbt vom Projekt, überschreibt gleichnamige) */
export const projectPreviewEnv = pgTable(
  'project_preview_env',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    isSecret: boolean('is_secret').notNull().default(false),
    value: text('value'),
    valueEncrypted: bytea('value_encrypted'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('project_preview_env_project_id_key_key').on(t.projectId, t.key)],
)

export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  // M9: Ein Token gehört zu genau einer Umgebung
  environmentId: uuid('environment_id').notNull().references(() => environments.id),
})

export const deployments = pgTable(
  'deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    version: text('version'),
    sourceRef: text('source_ref'),
    status: deploymentStatusEnum('status').notNull().default('pending'),
    errorMessage: text('error_message'),
    containerId: text('container_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    logRef: text('log_ref'),
    isActive: boolean('is_active').notNull().default(false),
    // M2
    imageRef: text('image_ref'),
    artifact: jsonb('artifact').$type<DeploymentArtifact>().notNull().default({}),
    trigger: text('trigger').$type<'deploy' | 'rollback'>().notNull().default('deploy'),
    rollbackOf: uuid('rollback_of'),
    // Projektseite (Migration 0016): Grund, Auslöser, Commit-Betreff
    reason: jsonb('reason').$type<DeployReason>(),
    actor: text('actor'),
    message: text('message'),
    // UI-Qualität 2 (Migration 0017): Erklärung beim Scheitern festgehalten
    failure: jsonb('failure').$type<FailureExplanation>(),
  },
  (t) => [index('deployments_project_started').on(t.projectId, t.startedAt)],
)

/** Was ein Rollback braucht, je nach Quelle. */
export interface DeploymentArtifact {
  /** compose: Pfad der normalisierten Datei dieser Fassung */
  composeFile?: string
  /** compose: Name des Web-Containers fuer den Upstream */
  webContainer?: string
  /** static: Name des Versionsordners unter /srv/sites/<slug>/ */
  siteVersion?: string
  /** dockerfile, compose mit build: von dieser Fassung gebaute Image-Tags */
  builtImages?: string[]
  /** files (M3): als was das Chat-Projekt in dieser Fassung erkannt wurde */
  filesKind?: FilesKind
  /** compose (Etappe 4): Dienste mit eigener interner Adresse (x-airlock-internal) */
  internalRoutes?: { service: string; port: number }[]
}

/** Erkannte Art eines Chat-Projekts (Quelle "files"). */
export type FilesKind = 'compose' | 'dockerfile' | 'static-build' | 'static'

/** Vorgemerkte Öffentlich-Anfrage (Migration 0010), höchstens eine pro Projekt. */
export const publicRequests = pgTable('public_requests', {
  projectId: uuid('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  actor: text('actor').notNull(),
  subdomain: text('subdomain'),
  hostname: text('hostname'),
  accessProtected: boolean('access_protected').notNull().default(false),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  lastError: text('last_error'),
})

export const routes = pgTable(
  'routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    target: routeTargetEnum('target').notNull(),
    // M4: eindeutig pro Ziel (Migration 0005); LAN und Tailnet teilen sich den Namen.
    hostname: text('hostname').notNull(),
    cfDnsRecordId: text('cf_dns_record_id'),
    accessProtected: boolean('access_protected').notNull().default(false),
    // M5
    cfAccessAppId: text('cf_access_app_id'),
    // Öffentlich pausiert (Migration 0009): Wartungsseite statt Projekt; NULL = live
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    // Pause-Seite des Projekts (Migration 0013): NULL = Vorlage; «Voraussichtlich zurück»
    pausePage: jsonb('pause_page').$type<PausePage>(),
    pauseBackAt: timestamp('pause_back_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('routes_project_target').on(t.projectId, t.target),
    uniqueIndex('routes_target_hostname').on(t.target, t.hostname),
  ],
)

export const projectEnv = pgTable(
  'project_env',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    isSecret: boolean('is_secret').notNull().default(false),
    value: text('value'),
    valueEncrypted: bytea('value_encrypted'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('project_env_project_key').on(t.projectId, t.key)],
)

export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    paramsMasked: jsonb('params_masked').notNull().default({}),
    result: auditResultEnum('result').notNull(),
    error: text('error'),
    // M9: leer = Server-Ereignis
    environmentId: uuid('environment_id').references(() => environments.id, { onDelete: 'set null' }),
  },
  (t) => [index('audit_events_at').on(t.at), index('audit_events_environment').on(t.environmentId, t.at)],
)

export const uploads = pgTable('uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  filename: text('filename').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  kind: text('kind').$type<'zip' | 'compose'>().notNull().default('zip'),
})

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/* --- Etappe 3: Besucher (Stundenzähler, migrations/0019_traffic.sql) ----------- */

export const trafficHourly = pgTable('traffic_hourly', {
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  hour: timestamp('hour', { withTimezone: true }).notNull(),
  way: text('way').$type<import('@airlock/shared').TrafficWay>().notNull(),
  path: text('path').notNull().default(''),
  country: text('country').notNull().default(''),
  city: text('city').notNull().default(''),
  referrer: text('referrer').notNull().default(''),
  device: text('device').notNull().default(''),
  status: smallint('status').notNull(),
  bot: boolean('bot').notNull().default(false),
  views: integer('views').notNull().default(0),
  visitors: integer('visitors').notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.hour, t.way, t.path, t.country, t.city, t.referrer, t.device, t.status, t.bot] }),
  index('traffic_hourly_hour_idx').on(t.hour),
])

/** «Besucher neu» (Migration 0030): je Merkmal eine Zählerzeile (Einstieg, Ausstieg, Sprache, Browser, System, Netz, Kampagne) */
export const trafficDims = pgTable('traffic_dims', {
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  hour: timestamp('hour', { withTimezone: true }).notNull(),
  way: text('way').$type<import('@airlock/shared').TrafficWay>().notNull(),
  dim: text('dim').$type<import('@airlock/shared').TrafficDim>().notNull(),
  value: text('value').notNull(),
  bot: boolean('bot').notNull().default(false),
  views: integer('views').notNull().default(0),
  visitors: integer('visitors').notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.hour, t.way, t.dim, t.value, t.bot] }),
  index('traffic_dims_hour_idx').on(t.hour),
])

/** «Besucher neu»: Messbeginn je Projekt (erster Ingest) */
export const trafficProjects = pgTable('traffic_projects', {
  projectId: uuid('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  measuredSince: timestamp('measured_since', { withTimezone: true }).notNull(),
})

/* --- Meilenstein Backup ------------------------------------------------------ */

export const backupRuns = pgTable('backup_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  trigger: text('trigger').$type<'schedule' | 'manual'>().notNull(),
  actor: text('actor').notNull(),
  status: text('status').$type<'running' | 'ok' | 'warning' | 'failed'>().notNull().default('running'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
  snapshotId: text('snapshot_id'),
  bytesNew: bigint('bytes_new', { mode: 'number' }),
  bytesTotal: bigint('bytes_total', { mode: 'number' }),
  filesNew: integer('files_new'),
  error: text('error'),
  warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
})

/* --- M6: Security ------------------------------------------------------------ */

export const scanIntervalEnum = pgEnum('scan_interval', ['off', 'daily', 'weekly', 'monthly'])

export const externalTargets = pgTable('external_targets', {
  id: uuid('id').primaryKey().defaultRandom(),
  hostname: text('hostname').notNull().unique(),
  txtToken: text('txt_token').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  lastCheckAt: timestamp('last_check_at', { withTimezone: true }),
  scanInterval: scanIntervalEnum('scan_interval').notNull().default('weekly'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // M9
  environmentId: uuid('environment_id').notNull().references(() => environments.id),
})

/** Eine Stufe: siehe ScanStageDto (Zustand, Dauer, Fortschritt, Live-Ausgabe). */
export type ScanStage = ScanStageDto

export interface ScanStages {
  [stage: string]: ScanStage
}

export const scanRuns = pgTable('scan_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  externalTargetId: uuid('external_target_id').references(() => externalTargets.id, { onDelete: 'cascade' }),
  deploymentId: uuid('deployment_id'),
  level: text('level').$type<'standard' | 'active'>().notNull().default('standard'),
  status: text('status').$type<'queued' | 'running' | 'done' | 'failed' | 'cancelled'>().notNull().default('queued'),
  /** Wer den Scan ausgelöst hat (deploy, mcp, manual, schedule) und als wer */
  trigger: text('trigger').$type<'deploy' | 'mcp' | 'manual' | 'schedule'>(),
  actor: text('actor'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  score: integer('score'),
  grade: text('grade').$type<'A' | 'B' | 'C' | 'D'>(),
  error: text('error'),
  stages: jsonb('stages').$type<ScanStages>().notNull().default({}),
})

export const findings = pgTable('findings', {
  id: uuid('id').primaryKey().defaultRandom(),
  scanRunId: uuid('scan_run_id').notNull().references(() => scanRuns.id, { onDelete: 'cascade' }),
  tool: text('tool').notNull(),
  severity: text('severity').$type<'critical' | 'high' | 'medium' | 'low'>().notNull(),
  title: text('title').notNull(),
  location: text('location').notNull(),
  description: text('description').notNull().default(''),
  fix: text('fix').notNull().default(''),
  fingerprint: text('fingerprint').notNull(),
  status: text('status').$type<'open' | 'accepted' | 'fixed'>().notNull().default('open'),
  acceptReason: text('accept_reason'),
})

export const findingAcceptances = pgTable('finding_acceptances', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id'),
  externalTargetId: uuid('external_target_id'),
  fingerprint: text('fingerprint').notNull(),
  reason: text('reason').notNull(),
  actor: text('actor').notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
})

/* --- M5: Domains (Zonen bei Cloudflare) ------------------------------------- */

export const domains = pgTable('domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  cfZoneId: text('cf_zone_id').notNull().unique(),
  name: text('name').notNull().unique(),
  /** Seit M9 nicht mehr gelesen: die Hauptzone steht in environments.zone_name */
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // M9: Eine Zone gehört genau einer Umgebung
  environmentId: uuid('environment_id').notNull().references(() => environments.id),
})

/* --- M8: Fix-Assistent ------------------------------------------------------ */

export const headerRules = pgTable('header_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  header: text('header').$type<import('@airlock/shared').HeaderKey>().notNull(),
  value: text('value').notNull(),
  /** M9: «off» schaltet eine Header-Vorlage der Umgebung für dieses Projekt ab */
  mode: text('mode').$type<'report-only' | 'enforce' | 'off'>().notNull().default('enforce'),
  reportKey: text('report_key').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // CSP-Fix: Report-Only-Beginn und Funktionsprüfung
  reportOnlySince: timestamp('report_only_since', { withTimezone: true }),
  checkResult: jsonb('check_result').$type<import('@airlock/shared').CspCheckDto>(),
}, (t) => [uniqueIndex('header_rules_project_id_header_key').on(t.projectId, t.header)])

export const cspViolations = pgTable('csp_violations', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  directive: text('directive').notNull(),
  blocked: text('blocked').notNull(),
  samplePath: text('sample_path'),
  count: integer('count').notNull().default(1),
  firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('csp_violations_project_id_directive_blocked_key').on(t.projectId, t.directive, t.blocked)])

export interface FixChanges {
  files?: { path: string; content: string; encoding?: 'utf8' | 'base64' }[]
  delete?: string[]
}

export const fixRequests = pgTable('fix_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  findingId: uuid('finding_id').references(() => findings.id, { onDelete: 'set null' }),
  fingerprint: text('fingerprint').notNull(),
  findingTitle: text('finding_title').notNull(),
  tool: text('tool').notNull(),
  way: text('way').$type<'mcp' | 'api' | 'github'>().notNull().default('mcp'),
  status: text('status').$type<import('@airlock/shared').FixStatus>().notNull().default('proposed'),
  explanation: text('explanation').notNull().default(''),
  diff: text('diff').notNull().default(''),
  changes: jsonb('changes').$type<FixChanges>().notNull().default({}),
  baseCommit: text('base_commit'),
  commit: text('commit'),
  deploymentId: uuid('deployment_id'),
  branch: text('branch'),
  prUrl: text('pr_url'),
  prNumber: integer('pr_number'),
  prCommentedAt: timestamp('pr_commented_at', { withTimezone: true }),
  note: text('note'),
  actor: text('actor').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('fix_requests_project').on(t.projectId, t.createdAt)])

export const gitConnections = pgTable('git_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').$type<'github' | 'gitlab'>().notNull().unique(),
  appId: text('app_id').notNull(),
  appSlug: text('app_slug').notNull(),
  appName: text('app_name').notNull(),
  htmlUrl: text('html_url').notNull(),
  clientId: text('client_id'),
  ownerLogin: text('owner_login'),
  installationId: text('installation_id'),
  repos: jsonb('repos').$type<string[]>().notNull().default([]),
  privateKeyEncrypted: bytea('private_key_encrypted').notNull(),
  clientSecretEncrypted: bytea('client_secret_encrypted'),
  webhookSecretEncrypted: bytea('webhook_secret_encrypted'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Nacht 3, Etappe 2: Zugang zu einem privaten Repo ausserhalb der GitHub-App
 * (Deploy-Key oder HTTPS-Token), höchstens einer pro Projekt. Ohne Projekt:
 * eben beim Anlegen erzeugt, noch nicht benutzt (verfällt nach 24 Stunden).
 */
export const gitCredentials = pgTable('git_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').unique().references(() => projects.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<'ssh_key' | 'https_token'>().notNull(),
  publicKey: text('public_key'),
  privateKeyEnc: bytea('private_key_enc'),
  username: text('username'),
  tokenEnc: bytea('token_enc'),
  /** Bestätigter Server (HostKeyAlias) und seine Schlüssel als known_hosts-Zeilen */
  host: text('host'),
  knownHosts: text('known_hosts'),
  hostConfirmedAt: timestamp('host_confirmed_at', { withTimezone: true }),
  /** Zuletzt gemeldete, noch nicht bestätigte Schlüssel */
  pendingHost: text('pending_host'),
  pendingKnownHosts: text('pending_known_hosts'),
  pendingAt: timestamp('pending_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
})

/* --- M9: Umgebungen (Migration 0015) ----------------------------------------- */

/** Ein Cloudflare-Token; eine oder mehrere Umgebungen nutzen es. */
export const cloudflareAccounts = pgTable('cloudflare_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  cfAccountId: text('cf_account_id'),
  name: text('name'),
  tokenEnc: text('token_enc').notNull(),
  tokenSavedAt: timestamp('token_saved_at', { withTimezone: true }),
  lastCheck: jsonb('last_check').$type<CfTokenCheckDto>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Ein Tunnel pro Cloudflare-Konto, mit eigenem cloudflared-Container. */
export const tunnels = pgTable('tunnels', {
  id: uuid('id').primaryKey().defaultRandom(),
  cloudflareAccountId: uuid('cloudflare_account_id').notNull().unique().references(() => cloudflareAccounts.id, { onDelete: 'cascade' }),
  cfTunnelId: text('cf_tunnel_id').notNull(),
  name: text('name').notNull(),
  tokenEnc: text('token_enc').notNull(),
  cloudflaredImage: text('cloudflared_image'),
  containerName: text('container_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Gespeicherter Stand der Zertifikats-Einrichtung (wie bisher app_settings.cloudflare.tls). */
export interface StoredTlsState {
  phase: CfTlsPhase
  ca: 'production' | 'staging'
  startedAt: string
  steps: { at: string; text: string; tone: 'info' | 'ok' | 'bad' }[]
  prodAttemptAt?: string
  prodCert?: { validTo: string; issuer: string | null; seenAt: string; source: 'probe' | 'log' | 'storage'; trusted: boolean | null }
}

export const environments = pgTable('environments', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  short: text('short').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  zoneName: text('zone_name'),
  internalPrefix: text('internal_prefix').notNull().default('int'),
  cloudflareAccountId: uuid('cloudflare_account_id').references(() => cloudflareAccounts.id, { onDelete: 'set null' }),
  tlsState: jsonb('tls_state').$type<StoredTlsState>(),
  tunnelSkipped: boolean('tunnel_skipped').notNull().default(false),
  tailnetRecordId: text('tailnet_record_id'),
  pausePage: jsonb('pause_page').$type<PausePage>(),
  accessDefault: boolean('access_default').notNull().default(false),
  accessEmails: text('access_emails').array().notNull().default([]),
  acmeEmail: text('acme_email'),
  notifyMuted: boolean('notify_muted').notNull().default(false),
  legacyImportedAt: timestamp('legacy_imported_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const headerRuleTemplates = pgTable('header_rule_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  environmentId: uuid('environment_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
  header: text('header').$type<import('@airlock/shared').HeaderKey>().notNull(),
  value: text('value').notNull(),
  mode: text('mode').$type<'report-only' | 'enforce'>().notNull().default('enforce'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('header_rule_templates_env_header').on(t.environmentId, t.header)])

export const routeRedirects = pgTable('route_redirects', {
  id: uuid('id').primaryKey().defaultRandom(),
  environmentId: uuid('environment_id').references(() => environments.id, { onDelete: 'set null' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  fromHost: text('from_host').notNull().unique(),
  toHost: text('to_host').notNull(),
  until: timestamp('until', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/* --- Etappe 4: Dienst hinzufügen/entfernen (migrations/0020_service_changes.sql) --- */

export const serviceChanges = pgTable('service_changes', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<'add' | 'remove'>().notNull(),
  service: text('service').notNull(),
  template: text('template').$type<import('@airlock/shared').ServiceTemplateId>(),
  status: text('status').$type<import('@airlock/shared').ServiceChangeStatus>().notNull(),
  way: text('way').$type<import('@airlock/shared').ServiceEditWay>().notNull(),
  deploymentId: uuid('deployment_id'),
  prUrl: text('pr_url'),
  prNumber: integer('pr_number'),
  branch: text('branch'),
  dropVolumes: jsonb('drop_volumes').$type<string[]>().notNull().default([]),
  diff: text('diff').notNull().default(''),
  note: text('note'),
  actor: text('actor').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
}, (t) => [index('service_changes_project_idx').on(t.projectId, t.createdAt)])

/* --- Etappe 5: Statusseite (migrations/0021_status_page.sql) -------------------- */

export const statusPages = pgTable('status_pages', {
  environmentId: uuid('environment_id').primaryKey().references(() => environments.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  title: text('title').notNull().default('Status'),
  hostname: text('hostname'),
  cfDnsRecordId: text('cf_dns_record_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const statusDaily = pgTable('status_daily', {
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  day: date('day', { mode: 'string' }).notNull(),
  upMinutes: integer('up_minutes').notNull().default(0),
  downMinutes: integer('down_minutes').notNull().default(0),
  pausedMinutes: integer('paused_minutes').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.projectId, t.day] }), index('status_daily_day_idx').on(t.day)])

export const statusIncidents = pgTable('status_incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  environmentId: uuid('environment_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  state: text('state').$type<import('@airlock/shared').IncidentState>().notNull(),
  auto: boolean('auto').notNull().default(false),
  projectIds: uuid('project_ids').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t) => [index('status_incidents_env_idx').on(t.environmentId, t.createdAt)])

/* --- Nacht 3, Etappe 1: Sitzungen, Passkeys, TOTP, Wiederherstellungscodes (migrations/0024_auth_2fa.sql) --- */

export const authSessions = pgTable('auth_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  method: text('method').$type<import('@airlock/shared').SessionMethod>().notNull(),
  sudoUntil: timestamp('sudo_until', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [index('auth_sessions_active_idx').on(t.revokedAt, t.expiresAt)])

export const authPasskeys = pgTable('auth_passkeys', {
  id: uuid('id').primaryKey().defaultRandom(),
  credentialId: text('credential_id').notNull().unique(),
  publicKey: bytea('public_key').notNull(),
  counter: bigint('counter', { mode: 'number' }).notNull().default(0),
  transports: text('transports').array().notNull().default([]),
  deviceType: text('device_type'),
  backedUp: boolean('backed_up'),
  name: text('name').notNull(),
  rpId: text('rp_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
})

export const authTotp = pgTable('auth_totp', {
  id: smallint('id').primaryKey().default(1),
  secretEnc: bytea('secret_enc'),
  enabledAt: timestamp('enabled_at', { withTimezone: true }),
  lastStep: bigint('last_step', { mode: 'number' }).notNull().default(-1),
  pendingEnc: bytea('pending_enc'),
  pendingAt: timestamp('pending_at', { withTimezone: true }),
})

export const authRecoveryCodes = pgTable('auth_recovery_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  codeHash: text('code_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  usedAt: timestamp('used_at', { withTimezone: true }),
})

/* --- Etappe 7: Achievements (migrations/0023_achievements.sql) ---------------- */

export const achievements = pgTable('achievements', {
  id: text('id').primaryKey(),
  achievedAt: timestamp('achieved_at', { withTimezone: true }).notNull(),
  seenAt: timestamp('seen_at', { withTimezone: true }),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
})

export const statusIncidentUpdates = pgTable('status_incident_updates', {
  id: uuid('id').primaryKey().defaultRandom(),
  incidentId: uuid('incident_id').notNull().references(() => statusIncidents.id, { onDelete: 'cascade' }),
  state: text('state').$type<import('@airlock/shared').IncidentState>().notNull(),
  body: text('body').notNull(),
  actor: text('actor').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('status_incident_updates_idx').on(t.incidentId, t.createdAt)])
