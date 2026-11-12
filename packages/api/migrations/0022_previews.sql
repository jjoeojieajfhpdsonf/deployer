-- Etappe 6 «Vorschau-Deploys»: pro Branch bzw. Pull Request eine eigene,
-- immer nur interne Fassung unter <branch-slug>--<projekt>.int.<basis>.
-- Nur neue Tabellen und neue Spalten mit Standardwert.
--
-- Eine Vorschau ist technisch ein eigenes Projekt (eigene Container, eigenes
-- Netz air_<label>, eigene Volumes, eigene Routen und Scans) mit Verweis auf
-- das Projekt, aus dem sie stammt (preview_of). Listen, Statusseite, MCP und
-- Backup blenden solche Projekte aus.

-- Am Vorschau-Projekt: das Projekt, aus dem es stammt. Gelöscht wird eine
-- Vorschau immer über Airlock (Container, Volumes, Routen); die Kaskade ist
-- nur die Absicherung für die Datenbankzeilen.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_of uuid REFERENCES projects(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS projects_preview_of_idx ON projects (preview_of);

-- Am eigentlichen Projekt: Schalter «Vorschauen» (Standard aus), wann zuletzt
-- bei GitHub nachgesehen wurde, und welche Branch-Köpfe und Pull Requests
-- Airlock schon kennt (ein neuer Kopf ist ein Push, ein neuer PR ein «opened»).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS previews_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS previews_checked_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_seen jsonb;

-- Eine Zeile je Vorschau (am Vorschau-Projekt)
CREATE TABLE IF NOT EXISTS previews (
  project_id      uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  parent_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch          text NOT NULL,
  -- DNS-Label <branch-slug>--<projekt> (höchstens 63 Zeichen), zugleich Slug des Vorschau-Projekts
  label           text NOT NULL UNIQUE,
  pr_number       integer,
  pr_url          text,
  head_sha        text,
  -- letzter erkannter Push (Aufräumen nach 7 Tagen ohne Push)
  last_push_at    timestamptz NOT NULL DEFAULT now(),
  -- Kommentar und Check am Pull Request
  comment_id      bigint,
  comment_hash    text,
  check_run_id    bigint,
  check_sha       text,
  check_hash      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_id, branch)
);
CREATE INDEX IF NOT EXISTS previews_parent_idx ON previews (parent_id);

-- Variablen-Ebene «Vorschau»: gilt für alle Vorschauen eines Projekts und
-- überschreibt dessen Variablen gleichen Namens (geerbt wird der Rest).
-- Geheime Werte verschlüsselt wie in project_env.
CREATE TABLE IF NOT EXISTS project_preview_env (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key              text NOT NULL,
  is_secret        boolean NOT NULL DEFAULT false,
  value            text,
  value_encrypted  bytea,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);
