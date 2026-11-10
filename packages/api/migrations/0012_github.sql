-- Meilenstein 8, Etappe 3: GitHub App (per Manifest) und Auto-Deploy nach Merge.

-- Eine Verbindung pro Anbieter. Schlüssel und Secrets verschlüsselt wie die
-- Projekt-Secrets (Schlüssel in DATA_DIR/keys, nicht in der Datenbank).
CREATE TABLE git_connections (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                   text NOT NULL UNIQUE,
  app_id                     text NOT NULL,
  app_slug                   text NOT NULL,
  app_name                   text NOT NULL,
  html_url                   text NOT NULL,
  client_id                  text,
  owner_login                text,
  installation_id            text,
  -- Repos der Installation: ["owner/repo", ...]
  repos                      jsonb NOT NULL DEFAULT '[]',
  private_key_encrypted      bytea NOT NULL,
  client_secret_encrypted    bytea,
  webhook_secret_encrypted   bytea,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Pro Projekt: nach neuem Commit auf dem Deploy-Branch selbst deployen (Polling, kein Webhook).
ALTER TABLE projects ADD COLUMN auto_deploy boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN auto_deploy_checked_at timestamptz;

-- Wann deployer das Ergebnis des Nachscans am Pull Request kommentiert hat.
ALTER TABLE fix_requests ADD COLUMN pr_commented_at timestamptz;
