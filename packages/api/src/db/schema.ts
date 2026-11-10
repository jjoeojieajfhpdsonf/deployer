import {
  pgTable, pgEnum, uuid, text, integer, boolean, timestamp, jsonb,
  numeric, bigserial, bigint, uniqueIndex, index, customType,
} from 'drizzle-orm/pg-core'
import type { ScanStageDto } from '@deployer/shared'

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
})

export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
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
  },
  (t) => [index('audit_events_at').on(t.at)],
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
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
