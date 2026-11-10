-- Meilenstein 8, Etappe 1: Security-Header über Caddy.
-- (0007 ist auf main für die live sichtbaren Scan-Stufen belegt.)

-- Eine Regel pro Projekt und Header. Caddy ergänzt den Header nur, wenn die
-- Antwort der App ihn nicht schon hat.
CREATE TABLE header_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  header      text NOT NULL,
  value       text NOT NULL,
  mode        text NOT NULL DEFAULT 'enforce',
  -- Nur CSP: zufälliger Schlüssel in der report-uri
  report_key  text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, header)
);

-- Von Browsern gemeldete CSP-Verstösse, zusammengefasst je Direktive und
-- blockierter Quelle.
CREATE TABLE csp_violations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  directive    text NOT NULL,
  blocked      text NOT NULL,
  sample_path  text,
  count        integer NOT NULL DEFAULT 1,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, directive, blocked)
);
