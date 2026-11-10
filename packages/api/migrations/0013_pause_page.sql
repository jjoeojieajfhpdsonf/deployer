-- Pause-Seite pro Projekt: eigener Titel/Text/Link/Kontakt (NULL = globale
-- Vorlage aus settings.pause_page) und «Voraussichtlich zurück» (Seite und
-- Retry-After). Nur an der öffentlichen Route.
ALTER TABLE routes ADD COLUMN IF NOT EXISTS pause_page jsonb;
ALTER TABLE routes ADD COLUMN IF NOT EXISTS pause_back_at timestamptz;
