-- Meilenstein 5: öffentlich über Cloudflare Tunnel.

CREATE TABLE domains (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cf_zone_id  text NOT NULL UNIQUE,
  name        text NOT NULL UNIQUE,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- Höchstens eine Standard-Domain.
CREATE UNIQUE INDEX domains_one_default ON domains (is_default) WHERE is_default;

-- Access-Anwendung einer öffentlichen Route (optional pro Projekt).
ALTER TABLE routes ADD COLUMN cf_access_app_id text;
