-- Meilenstein 6: Scans, Befunde, externe Ziele.

CREATE TYPE scan_interval AS ENUM ('off', 'daily', 'weekly', 'monthly');

CREATE TABLE external_targets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname       text NOT NULL UNIQUE,
  txt_token      text NOT NULL,
  verified_at    timestamptz,
  last_check_at  timestamptz,
  scan_interval  scan_interval NOT NULL DEFAULT 'weekly',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scan_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid REFERENCES projects(id) ON DELETE CASCADE,
  external_target_id  uuid REFERENCES external_targets(id) ON DELETE CASCADE,
  deployment_id       uuid REFERENCES deployments(id) ON DELETE SET NULL,
  level               text NOT NULL DEFAULT 'standard' CHECK (level IN ('standard', 'active')),
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  score               integer,
  grade               text CHECK (grade IS NULL OR grade IN ('A', 'B', 'C', 'D')),
  error               text,
  -- Was lief, was nicht anwendbar war (z.B. testssl ohne HTTPS).
  stages              jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Genau eines von beiden ist gesetzt.
  CONSTRAINT scan_runs_one_target CHECK ((project_id IS NULL) <> (external_target_id IS NULL))
);

CREATE INDEX scan_runs_project ON scan_runs (project_id, started_at DESC);
CREATE INDEX scan_runs_external ON scan_runs (external_target_id, started_at DESC);

CREATE TABLE findings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_run_id    uuid NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  tool           text NOT NULL,
  severity       text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  title          text NOT NULL,
  location       text NOT NULL,
  description    text NOT NULL DEFAULT '',
  fix            text NOT NULL DEFAULT '',
  fingerprint    text NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'fixed')),
  accept_reason  text
);

CREATE INDEX findings_run ON findings (scan_run_id);

-- Akzeptieren gilt über Scans hinweg: pro Projekt bzw. externem Ziel und Fingerabdruck.
CREATE TABLE finding_acceptances (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid REFERENCES projects(id) ON DELETE CASCADE,
  external_target_id  uuid REFERENCES external_targets(id) ON DELETE CASCADE,
  fingerprint         text NOT NULL,
  reason              text NOT NULL CHECK (length(reason) >= 3),
  actor               text NOT NULL,
  accepted_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finding_acceptances_one_target CHECK ((project_id IS NULL) <> (external_target_id IS NULL))
);

CREATE UNIQUE INDEX finding_acceptances_project ON finding_acceptances (project_id, fingerprint) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX finding_acceptances_external ON finding_acceptances (external_target_id, fingerprint) WHERE external_target_id IS NOT NULL;
