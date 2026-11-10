-- Öffentlich pausieren: Name, DNS-Eintrag und Tunnel-Regel bleiben, Caddy
-- liefert für den öffentlichen Namen eine neutrale Wartungsseite (503).
-- NULL = live.
ALTER TABLE routes ADD COLUMN paused_at timestamptz;
