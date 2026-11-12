-- Nacht 3, Etappe 2 «Private Git-Repos»: Zugang zu privaten Repos ausserhalb
-- der GitHub-App. Nur eine neue Tabelle.
--
-- Pro Projekt höchstens ein Zugang: ein Deploy-Key (ed25519, SSH) oder ein
-- HTTPS-Token. Privater Schlüssel und Token liegen AES-GCM-verschlüsselt mit
-- der Schlüsseldatei (DATA_DIR/keys/secrets.key), wie die Projekt-Secrets.
-- project_id NULL: eben beim Anlegen erzeugt, noch keinem Projekt
-- zugeordnet; solche Zeilen räumt der Aufräum-Job nach 24 Stunden weg.
--
-- known_hosts: die beim ersten Verbinden angezeigten und bestätigten
-- Schlüssel des Git-Servers (TOFU); danach verbindet Airlock nur mit
-- StrictHostKeyChecking=yes gegen genau diese.

CREATE TABLE IF NOT EXISTS git_credentials (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  -- ssh_key | https_token
  kind                 text NOT NULL CHECK (kind IN ('ssh_key', 'https_token')),
  public_key           text,
  private_key_enc      bytea,
  username             text,
  token_enc            bytea,
  host                 text,
  known_hosts          text,
  host_confirmed_at    timestamptz,
  pending_host         text,
  pending_known_hosts  text,
  pending_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  last_used_at         timestamptz,
  CHECK ((kind = 'ssh_key' AND private_key_enc IS NOT NULL AND public_key IS NOT NULL)
      OR (kind = 'https_token' AND token_enc IS NOT NULL AND username IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS git_credentials_unbound_idx ON git_credentials (created_at) WHERE project_id IS NULL;
