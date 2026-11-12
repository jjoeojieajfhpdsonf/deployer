-- «Besucher neu»: weitere Merkmale und Messbeginn je Projekt. Wie traffic_hourly
-- nur Zähler – keine IP, kein Hash, kein User-Agent, keine Query. Aufbewahrung
-- 13 Monate (derselbe tägliche Job, packages/api/src/traffic/retention.ts).

-- Je Merkmal eine Zeile (Randsummen, keine Kreuzung der Merkmale):
--   entry / exit  Einstiegs- bzw. Ausstiegsseite (Pfad); aus dem täglichen
--                 Besucher-Hash im Speicher, ohne DNT/Sec-GPC
--   lang          erste Sprache aus Accept-Language («de-CH»)
--   browser / os  Familie und Hauptversion («Chrome 131», «iOS 18»)
--   asn           Netz aus DB-IP «IP to ASN Lite» («13030 Init7 (Switzerland) Ltd.»)
--   utm           utm_source, utm_medium, utm_campaign (getrennt durch U+001F)
CREATE TABLE IF NOT EXISTS traffic_dims (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hour       timestamptz NOT NULL,
  way        text NOT NULL,
  dim        text NOT NULL,
  value      text NOT NULL,
  -- Anfragen von Bots (nur dim = asn: Rechenzentren und Crawler je Netz)
  bot        boolean NOT NULL DEFAULT false,
  views      integer NOT NULL DEFAULT 0,
  visitors   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, hour, way, dim, value, bot)
);
CREATE INDEX IF NOT EXISTS traffic_dims_hour_idx ON traffic_dims (hour);

-- Messbeginn: erster Ingest für das Projekt. Davor gibt es keine Zahlen; die
-- Kurve beginnt dort statt mit Nullen.
CREATE TABLE IF NOT EXISTS traffic_projects (
  project_id     uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  measured_since timestamptz NOT NULL
);

-- Bestehende Projekte: ältester Stundenzähler (genauer weiss man es nicht mehr)
INSERT INTO traffic_projects (project_id, measured_since)
  SELECT project_id, min(hour) FROM traffic_hourly GROUP BY project_id
  ON CONFLICT (project_id) DO NOTHING;
