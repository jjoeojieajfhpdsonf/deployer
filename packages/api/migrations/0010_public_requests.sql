-- Vorgemerkte Öffentlich-Anfragen: etwa MCP create_project mit "public",
-- solange noch kein bestandener Scan vorliegt. Höchstens eine pro Projekt.
-- Wirksam wird sie nie still: erst nach Bestätigung in der Oberfläche
-- (approved_*), dann automatisch nach dem nächsten bestandenen Scan.
CREATE TABLE IF NOT EXISTS public_requests (
  project_id       uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  actor            text NOT NULL,
  subdomain        text,
  hostname         text,
  access_protected boolean NOT NULL DEFAULT false,
  approved_by      text,
  approved_at      timestamptz,
  -- Letzter Versuch nach einem Scan gescheitert (z. B. Name belegt)
  last_error       text
);
