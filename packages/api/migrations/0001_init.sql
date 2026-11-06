-- Meilenstein 1: Projekte, Deployments, Routen, Env/Secrets, Audit, Uploads.
-- Noch nicht hier: domains, external_targets, scan_runs, findings, api_tokens.

CREATE TYPE source_type        AS ENUM ('image','static','dockerfile','compose','files');
CREATE TYPE project_status     AS ENUM ('created','deploying','running','stopped','failed');
CREATE TYPE desired_state      AS ENUM ('running','stopped');
CREATE TYPE deployment_status  AS ENUM ('pending','pulling','starting','healthchecking','active','failed','superseded','rolled_back');
CREATE TYPE route_target       AS ENUM ('public','lan','tailnet');
CREATE TYPE audit_result       AS ENUM ('ok','error');

CREATE TABLE projects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  slug              text NOT NULL UNIQUE
                      CONSTRAINT projects_slug_shape
                      CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  source_type       source_type NOT NULL,
  source_config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  port              integer CHECK (port IS NULL OR (port > 0 AND port < 65536)),
  healthcheck_path  text NOT NULL DEFAULT '/',
  status            project_status NOT NULL DEFAULT 'created',
  -- Getrennt vom status: nach einem Serverneustart muss unterscheidbar sein,
  -- ob ein Container gewollt gestoppt oder abgestuerzt ist.
  desired_state     desired_state NOT NULL DEFAULT 'stopped',
  keep              boolean NOT NULL DEFAULT false,
  cpu_limit         numeric(4,2) NOT NULL DEFAULT 1 CHECK (cpu_limit > 0),
  memory_limit_mb   integer NOT NULL DEFAULT 512 CHECK (memory_limit_mb >= 64),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deployments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version        text,
  source_ref     text,
  status         deployment_status NOT NULL DEFAULT 'pending',
  error_message  text,
  container_id   text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  log_ref        text,
  is_active      boolean NOT NULL DEFAULT false
);

CREATE INDEX deployments_project_started ON deployments (project_id, started_at DESC);

-- Genau ein aktives Deployment pro Projekt. Letzte Absicherung in den Daten;
-- das Rennen selbst verhindert der Advisory Lock in der Pipeline.
CREATE UNIQUE INDEX deployments_one_active_per_project
  ON deployments (project_id) WHERE is_active;

CREATE TABLE routes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target            route_target NOT NULL,
  -- Nur der kanonische Name. nip.io-Aliase werden daraus berechnet.
  hostname          text NOT NULL UNIQUE,
  cf_dns_record_id  text,
  access_protected  boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, target)
);

CREATE TABLE project_env (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key              text NOT NULL CHECK (key ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  is_secret        boolean NOT NULL DEFAULT false,
  value            text,
  value_encrypted  bytea,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key),
  CONSTRAINT project_env_one_value CHECK (
    (is_secret AND value IS NULL AND value_encrypted IS NOT NULL) OR
    (NOT is_secret AND value IS NOT NULL AND value_encrypted IS NULL)
  )
);

CREATE TABLE audit_events (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  actor          text NOT NULL,
  action         text NOT NULL,
  target_type    text,
  target_id      text,
  params_masked  jsonb NOT NULL DEFAULT '{}'::jsonb,
  result         audit_result NOT NULL,
  error          text
);

CREATE INDEX audit_events_at ON audit_events (at DESC);

CREATE TABLE uploads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename    text NOT NULL,
  size_bytes  bigint NOT NULL,
  sha256      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);

CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
