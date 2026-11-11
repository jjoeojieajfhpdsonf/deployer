-- Etappe 5 «Statusseite»: status.<hauptzone> je Umgebung, öffentlich über
-- den Tunnel, ausgeliefert vom Container airlock-status (nur Dateien, kein
-- Zugriff auf Airlock, Datenbank oder Docker). Nur neue Tabellen und eine
-- neue, leere Spalte.

-- «Auf Statusseite zeigen»: NULL = Standard (öffentliche Projekte an, interne aus)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS show_on_status boolean;

-- Einstellungen je Umgebung (eine Zeile, sobald jemand etwas einstellt)
CREATE TABLE IF NOT EXISTS status_pages (
  environment_id   uuid PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
  enabled          boolean NOT NULL DEFAULT false,
  title            text NOT NULL DEFAULT 'Status',
  -- status.<hauptzone>, wie beim Einschalten angelegt (CNAME auf den Tunnel)
  hostname         text,
  cf_dns_record_id text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Tageswerte der Verfügbarkeit, ab jetzt gesammelt (vorher gibt es keine
-- Historie; fehlende Tage zeigt die Seite als «keine Daten»). Je Minute
-- zählt Airlock eine Messung: erreichbar, gestört oder absichtlich angehalten
-- (Wartung; zählt nicht zur Verfügbarkeit). Tag = Kalendertag in der
-- Zeitzone der Anzeige (TZ, sonst Europe/Zurich).
CREATE TABLE IF NOT EXISTS status_daily (
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day             date NOT NULL,
  up_minutes      integer NOT NULL DEFAULT 0,
  down_minutes    integer NOT NULL DEFAULT 0,
  paused_minutes  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day)
);
CREATE INDEX IF NOT EXISTS status_daily_day_idx ON status_daily (day);

-- Störungen («Störung melden» oder automatisch nach 5 Minuten Ausfall)
CREATE TABLE IF NOT EXISTS status_incidents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id  uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  title           text NOT NULL,
  -- untersucht | erkannt | behoben (Stand des letzten Updates)
  state           text NOT NULL,
  -- automatisch angelegt: genau ein Projekt in project_ids
  auto            boolean NOT NULL DEFAULT false,
  project_ids     uuid[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);
CREATE INDEX IF NOT EXISTS status_incidents_env_idx ON status_incidents (environment_id, created_at);

CREATE TABLE IF NOT EXISTS status_incident_updates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id  uuid NOT NULL REFERENCES status_incidents(id) ON DELETE CASCADE,
  state        text NOT NULL,
  body         text NOT NULL,
  actor        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS status_incident_updates_idx ON status_incident_updates (incident_id, created_at);
