-- Nacht 3, Etappe 5 «Einbruchserkennung»: Vorfälle mit Verlauf, die
-- Grundlinie je Container, «als normal markiert» je Projekt, Prüfsummen
-- statischer Seiten und die Reaktion je Projekt. Nur neue Tabellen und neue
-- Spalten mit Standardwert.

-- Vorfall: gebündelte Hinweise gleicher Art (fingerprint = Projekt|Art|Schlüssel).
-- Solange er nicht erledigt ist, zählt ein neuer gleicher Hinweis hier hoch;
-- danach beginnt ein neuer Vorfall. project_id leer = Server (Anmeldung).
CREATE TABLE IF NOT EXISTS incidents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint        text NOT NULL,
  source             text NOT NULL CHECK (source IN ('anmeldung', 'prozess', 'datei', 'netz', 'web', 'container')),
  kind               text NOT NULL,
  severity           text NOT NULL CHECK (severity IN ('niedrig', 'mittel', 'hoch', 'kritisch')),
  status             text NOT NULL DEFAULT 'offen' CHECK (status IN ('offen', 'gesehen', 'erledigt')),
  title              text NOT NULL,
  subject            text,
  service            text,
  samples            jsonb NOT NULL DEFAULT '[]',
  count              integer NOT NULL DEFAULT 1,
  first_seen         timestamptz NOT NULL,
  last_seen          timestamptz NOT NULL,
  note               text,
  notified_at        timestamptz,
  notified_severity  text,
  reacted_at         timestamptz,
  repeat_logged_at   timestamptz,
  resolved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS incidents_active_fingerprint ON incidents (fingerprint) WHERE status <> 'erledigt';
CREATE INDEX IF NOT EXISTS incidents_project_idx ON incidents (project_id, last_seen DESC);
CREATE INDEX IF NOT EXISTS incidents_last_seen_idx ON incidents (last_seen DESC);

-- Verlauf eines Vorfalls: erkannt, erneut (höchstens stündlich), hochgestuft,
-- Status, Notiz, als normal markiert, gemeldet, Reaktion.
CREATE TABLE IF NOT EXISTS incident_events (
  id           bigserial PRIMARY KEY,
  incident_id  uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL,
  text         text NOT NULL,
  actor        text
);
CREATE INDEX IF NOT EXISTS incident_events_incident_idx ON incident_events (incident_id, at);

-- Grundlinie je Container (ein Deploy legt neue Container an, also je
-- Deployment): was er in den ersten 10 Minuten tut, gilt als normal.
-- reported_* = schon gemeldet (nicht bei jeder Runde neu zählen).
CREATE TABLE IF NOT EXISTS intrusion_containers (
  container_id      text PRIMARY KEY,
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id     text,
  service           text,
  first_seen        timestamptz NOT NULL,
  learn_until       timestamptz NOT NULL,
  processes         text[] NOT NULL DEFAULT '{}',
  files             text[] NOT NULL DEFAULT '{}',
  reported_pids     text[] NOT NULL DEFAULT '{}',
  reported_files    text[] NOT NULL DEFAULT '{}',
  restart_count     integer,
  started_at        text,
  oom_for           text,
  last_check_at     timestamptz,
  last_files_at     timestamptz,
  last_seen         timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS intrusion_containers_project_idx ON intrusion_containers (project_id);

-- «Als normal markieren»: erweitert die Grundlinie des Projekts (alle
-- künftigen Container). kind: prozess (Programm), datei (Pfad oder Ordner
-- mit «/» am Ende), netz (Ziel:Port). service leer = alle Dienste.
CREATE TABLE IF NOT EXISTS intrusion_allow (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('prozess', 'datei', 'netz')),
  service     text NOT NULL DEFAULT '',
  value       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  PRIMARY KEY (project_id, kind, service, value)
);

-- Statische Seiten: Prüfsummen der ausgelieferten Fassung (beim ersten
-- Prüfen nach dem Deploy festgehalten), stündlich verglichen.
CREATE TABLE IF NOT EXISTS intrusion_sites (
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version      text NOT NULL,
  files        jsonb NOT NULL,
  reported     text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  checked_at   timestamptz,
  PRIMARY KEY (project_id, version)
);

-- Reaktion je Projekt: «Bei kritischem Vorfall Container stoppen und Seite
-- pausieren» (Standard aus) und Isolation (Ausgang abgeschottet, Neustart
-- verweigert bis zur Freigabe; isolation = Restart-Policies vorher u. a.).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS incident_auto_stop boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS isolated_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS isolated_by text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS isolation jsonb;
