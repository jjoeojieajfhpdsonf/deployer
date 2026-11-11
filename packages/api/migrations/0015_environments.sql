-- M9: Umgebungen (SPEC «Umgebungen», docs/MILESTONE-9.md).
--
-- Legt die Tabellen an und genau eine Umgebung, der alle bestehenden Zeilen
-- gehören, damit environment_id sofort NOT NULL sein kann. Name, Slug,
-- Kürzel, Hauptzone, Cloudflare-Konto, Tunnel, TLS-Zustand und Pause-Seite
-- überträgt der Start-Schritt importLegacySettings() (TypeScript, weil die
-- Werte verschlüsselt im JSON von app_settings.cloudflare liegen).
-- app_settings.cloudflare und pause_page bleiben als Rückfall stehen.

CREATE TABLE IF NOT EXISTS cloudflare_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cf_account_id text,
  name text,
  token_enc text NOT NULL,
  token_saved_at timestamptz,
  last_check jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cloudflare_accounts_cf_account_id
  ON cloudflare_accounts (cf_account_id) WHERE cf_account_id IS NOT NULL;

-- Ein Tunnel pro Cloudflare-Konto (cfargotunnel.com leitet nur Einträge
-- desselben Kontos weiter, siehe MILESTONE-9.md, Abschnitt 2).
CREATE TABLE IF NOT EXISTS tunnels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cloudflare_account_id uuid NOT NULL UNIQUE REFERENCES cloudflare_accounts (id) ON DELETE CASCADE,
  cf_tunnel_id text NOT NULL,
  name text NOT NULL,
  token_enc text NOT NULL,
  cloudflared_image text,
  container_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  short text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  -- Hauptzone (öffentliche Domain) und Präfix der internen Basis:
  -- interne Basis = <prefix>.<zone> (leeres Präfix: die Zone selbst)
  zone_name text,
  internal_prefix text NOT NULL DEFAULT 'int',
  cloudflare_account_id uuid REFERENCES cloudflare_accounts (id) ON DELETE SET NULL,
  -- Zertifikats-Einrichtung wie bisher in app_settings.cloudflare.tls
  tls_state jsonb,
  tunnel_skipped boolean NOT NULL DEFAULT false,
  tailnet_record_id text,
  pause_page jsonb,
  access_default boolean NOT NULL DEFAULT false,
  access_emails text[] NOT NULL DEFAULT '{}',
  acme_email text,
  notify_muted boolean NOT NULL DEFAULT false,
  legacy_imported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Genau eine Standard-Umgebung
CREATE UNIQUE INDEX IF NOT EXISTS environments_one_default ON environments (is_default) WHERE is_default;
-- Eine Zone gehört höchstens einer Umgebung als Hauptzone
CREATE UNIQUE INDEX IF NOT EXISTS environments_zone ON environments (zone_name) WHERE zone_name IS NOT NULL;

INSERT INTO environments (slug, name, short, is_default)
SELECT 'standard', 'Standard', 'ST', true
WHERE NOT EXISTS (SELECT 1 FROM environments);

-- environment_id an allem, was einer Umgebung gehört
ALTER TABLE projects ADD COLUMN IF NOT EXISTS environment_id uuid REFERENCES environments (id);
ALTER TABLE domains ADD COLUMN IF NOT EXISTS environment_id uuid REFERENCES environments (id);
ALTER TABLE external_targets ADD COLUMN IF NOT EXISTS environment_id uuid REFERENCES environments (id);
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS environment_id uuid REFERENCES environments (id);
-- Audit: leer = Server-Ereignis (Anmeldung, Passwort, Tunnel, Benachrichtigungen, GitHub, Updates)
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS environment_id uuid REFERENCES environments (id) ON DELETE SET NULL;

UPDATE projects SET environment_id = (SELECT id FROM environments WHERE is_default) WHERE environment_id IS NULL;
UPDATE domains SET environment_id = (SELECT id FROM environments WHERE is_default) WHERE environment_id IS NULL;
UPDATE external_targets SET environment_id = (SELECT id FROM environments WHERE is_default) WHERE environment_id IS NULL;
UPDATE api_tokens SET environment_id = (SELECT id FROM environments WHERE is_default) WHERE environment_id IS NULL;
UPDATE audit_events SET environment_id = (SELECT id FROM environments WHERE is_default)
  WHERE environment_id IS NULL AND target_type IN ('project', 'domain', 'token', 'external_target', 'dns');

ALTER TABLE projects ALTER COLUMN environment_id SET NOT NULL;
ALTER TABLE domains ALTER COLUMN environment_id SET NOT NULL;
ALTER TABLE external_targets ALTER COLUMN environment_id SET NOT NULL;
ALTER TABLE api_tokens ALTER COLUMN environment_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS projects_environment ON projects (environment_id);
CREATE INDEX IF NOT EXISTS domains_environment ON domains (environment_id);
CREATE INDEX IF NOT EXISTS external_targets_environment ON external_targets (environment_id);
CREATE INDEX IF NOT EXISTS api_tokens_environment ON api_tokens (environment_id);
CREATE INDEX IF NOT EXISTS audit_events_environment ON audit_events (environment_id, at);

-- Standard-Header einer Umgebung (ohne CSP); eine Projektregel für denselben
-- Header ersetzt die Vorlage, header_rules.mode = 'off' schaltet sie ab.
CREATE TABLE IF NOT EXISTS header_rule_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
  header text NOT NULL,
  value text NOT NULL,
  mode text NOT NULL DEFAULT 'enforce',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS header_rule_templates_env_header ON header_rule_templates (environment_id, header);

-- Interne Weiterleitung nach dem Verschieben eines Projekts (30 Tage, 308)
CREATE TABLE IF NOT EXISTS route_redirects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id uuid REFERENCES environments (id) ON DELETE SET NULL,
  project_id uuid REFERENCES projects (id) ON DELETE CASCADE,
  from_host text NOT NULL UNIQUE,
  to_host text NOT NULL,
  until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
