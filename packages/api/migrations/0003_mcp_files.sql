-- Meilenstein 3: API-Tokens für MCP und Skripte, Quelle "files" mit lokalem Repo.

CREATE TABLE api_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- Nur der SHA-256 des Tokens. Das Token ist zufällig und lang; ein
  -- langsamer Hash bringt hier nichts.
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

-- Lokales Git-Repo eines Chat-Projekts (Quelle "files").
ALTER TABLE projects ADD COLUMN local_repo_path text;
-- Letzte Änderung an Dateien oder Deploy; Grundlage für den Ablauf nach 30 Tagen.
ALTER TABLE projects ADD COLUMN last_change_at timestamptz NOT NULL DEFAULT now();
-- Wann zuletzt "läuft bald ab" gemeldet wurde; zurückgesetzt bei Änderung.
ALTER TABLE projects ADD COLUMN expiry_warned_at timestamptz;
