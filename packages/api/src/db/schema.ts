import {
  pgTable, pgEnum, uuid, text, integer, boolean, timestamp, jsonb,
  numeric, bigserial, bigint, uniqueIndex, index, customType,
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
})

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
