-- Bestehender Dienst: Projektart «external» (läuft schon, Airlock macht ihn nur
-- erreichbar) und der Zugang «Airlock-Login» für alle Projekte. Nur ein neuer
-- Enum-Wert und neue Spalten mit Standardwert.
ALTER TYPE source_type ADD VALUE IF NOT EXISTS 'external';

-- Airlock-Login vor jeder Anfrage an die Adressen des Projekts (Caddy forward_auth)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS login_guard boolean NOT NULL DEFAULT false;

-- Bekannte Admin-Oberfläche trotzdem ohne Schutz öffentlich: wann und von wem
-- bestätigt (erneute Bestätigung, sudo). null = Schutz ist Pflicht.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS admin_override_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS admin_override_by text;

-- Ziel nicht wiedergefunden seit (nur external mit Container)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS external_missing_since timestamptz;
