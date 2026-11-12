-- Abgrenzung HomeBento: Umfang eines API-Tokens. «voll» = wie bisher (REST und
-- MCP der Umgebung), «lesen» = nur die Übersicht für Dashboards
-- (GET /api/v1/summary), kein MCP, nichts ändern, nichts Geheimes.
-- Nur eine neue Spalte mit Standardwert: bestehende Tokens bleiben «voll».
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'voll'
  CHECK (scope IN ('voll', 'lesen'));
