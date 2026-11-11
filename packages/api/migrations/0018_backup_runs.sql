-- Meilenstein Backup, Etappe 1: Läufe der Sicherung (restic).
-- Einstellungen stehen in app_settings (backup_settings, backup_state).
CREATE TABLE backup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- schedule | manual
  trigger text NOT NULL,
  -- «system», «ui:joel»
  actor text NOT NULL,
  -- running | ok | warning | failed
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  snapshot_id text,
  -- Neu ins Repository geschrieben (nach Deduplizierung) bzw. Grösse des Stands
  bytes_new bigint,
  bytes_total bigint,
  files_new integer,
  -- Geschwärzt (keine Zugangsdaten)
  error text,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX backup_runs_started_at_idx ON backup_runs (started_at DESC);
