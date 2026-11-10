-- Meilenstein 8, Etappe 2: Vorschläge zum Beheben eines Befunds (Mit Claude lösen).

CREATE TABLE fix_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Der Befund kann mit seinem Scan verschwinden; Fingerabdruck und Titel bleiben.
  finding_id     uuid REFERENCES findings(id) ON DELETE SET NULL,
  fingerprint    text NOT NULL,
  finding_title  text NOT NULL,
  tool           text NOT NULL,
  -- mcp: Claude über MCP; api: deployer fragt Claude selbst; github: Pull Request (Etappe 3)
  way            text NOT NULL DEFAULT 'mcp',
  -- proposed, applied, pr_open, merged, verified, rejected, failed
  status         text NOT NULL DEFAULT 'proposed',
  explanation    text NOT NULL DEFAULT '',
  diff           text NOT NULL DEFAULT '',
  -- Dateien zum Anwenden: { files: [{path, content, encoding}], delete: [path] }
  changes        jsonb NOT NULL DEFAULT '{}',
  base_commit    text,
  commit         text,
  deployment_id  uuid,
  branch         text,
  pr_url         text,
  pr_number      integer,
  note           text,
  actor          text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fix_requests_project ON fix_requests (project_id, created_at DESC);
