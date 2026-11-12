-- Etappe 3 «Besucher und Herkunft»: Stundenzähler aus Caddys Zugriffs-Log.
-- Keine IP, kein Hash, kein User-Agent: nur Zähler je Projekt, Stunde und
-- Merkmal. «visitors» zählt Besucher bei ihrer ersten gezählten Anfrage des
-- Tages (Hash aus IP, User-Agent und Tagessalz, nur im Speicher); die Summe
-- über Stunden ergibt so die Besucher je Tag. Aufbewahrung 13 Monate, dann
-- löscht ein täglicher Job (packages/api/src/traffic/retention.ts).
CREATE TABLE IF NOT EXISTS traffic_hourly (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Beginn der Stunde (UTC)
  hour       timestamptz NOT NULL,
  -- public (Internet über den Tunnel) | tailnet | lan (Heimnetz)
  way        text NOT NULL,
  -- Pfad ohne Query; leer bei Bots
  path       text NOT NULL DEFAULT '',
  -- ISO 3166-1 alpha-2 aus CF-IPCountry (nur Internet); leer = unbekannt
  country    text NOT NULL DEFAULT '',
  -- Stadt aus DB-IP «IP to City Lite», nur wenn die Datei vorliegt
  city       text NOT NULL DEFAULT '',
  -- Nur der Host des Referrers; leer = direkt
  referrer   text NOT NULL DEFAULT '',
  -- desktop | mobile | tablet; leer bei Bots
  device     text NOT NULL DEFAULT '',
  status     smallint NOT NULL,
  bot        boolean NOT NULL DEFAULT false,
  views      integer NOT NULL DEFAULT 0,
  visitors   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, hour, way, path, country, city, referrer, device, status, bot)
);
-- Löschfrist und «heute» über alle Projekte
CREATE INDEX IF NOT EXISTS traffic_hourly_hour_idx ON traffic_hourly (hour);
