-- Etappe 4 «Dienst hinzufügen/entfernen» (Reiter «Aufbau»): Änderungen an
-- der compose.yaml, bis sie laufen. Der Aufbau zeigt einen neuen Dienst
-- gestrichelt «wird erstellt», solange status deploying/pr_open/merged ist;
-- gescheiterte bleiben sichtbar, bis man sie ausblendet (dismissed_at).
-- Keine Passwörter: die stehen verschlüsselt in project_env.
CREATE TABLE IF NOT EXISTS service_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- add | remove
  kind          text NOT NULL,
  service       text NOT NULL,
  -- Vorlage (postgres, redis …), beim Entfernen null
  template      text,
  -- deploying | pr_open | merged | done | failed | closed
  status        text NOT NULL,
  -- deploy | pull_request
  way           text NOT NULL,
  deployment_id uuid,
  pr_url        text,
  pr_number     integer,
  branch        text,
  -- Volumes, die nach erfolgreichem Deploy gelöscht werden (Entfernen mit Volume)
  drop_volumes  jsonb NOT NULL DEFAULT '[]'::jsonb,
  diff          text NOT NULL DEFAULT '',
  note          text,
  actor         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  dismissed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS service_changes_project_idx ON service_changes (project_id, created_at);
