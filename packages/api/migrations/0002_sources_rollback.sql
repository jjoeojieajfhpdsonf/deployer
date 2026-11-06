-- Meilenstein 2: Dockerfile, Compose, statisch aus Repo, Rollback.

-- Womit eine Fassung lief, damit ein Rollback sie wieder starten kann:
-- Digest bei fertigen Images, eigener Tag bei gebauten.
ALTER TABLE deployments ADD COLUMN image_ref text;

-- Quellenspezifische Artefakte einer Fassung, z.B. der Pfad der
-- normalisierten Compose-Datei oder der statische Versionsordner.
ALTER TABLE deployments ADD COLUMN artifact jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE deployments ADD COLUMN trigger text NOT NULL DEFAULT 'deploy'
  CONSTRAINT deployments_trigger_known CHECK (trigger IN ('deploy', 'rollback'));

ALTER TABLE deployments ADD COLUMN rollback_of uuid
  REFERENCES deployments(id) ON DELETE SET NULL;

-- Uploads sind ZIPs (statische Seiten) oder einzelne compose.yaml.
ALTER TABLE uploads ADD COLUMN kind text NOT NULL DEFAULT 'zip'
  CONSTRAINT uploads_kind_known CHECK (kind IN ('zip', 'compose'));
