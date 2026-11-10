-- CSP-Fix: Funktionsprüfung nach dem Scharfschalten und Beginn von Report-Only.
-- (Auf main sind bis 0013 belegt.)

-- Seit wann die CSP im Report-Only läuft: Aufrufe ohne Verstoss zählen ab hier.
ALTER TABLE header_rules ADD COLUMN report_only_since timestamptz;
-- Ergebnis der Funktionsprüfung im Headless-Browser (state, at, pages, violations, message)
ALTER TABLE header_rules ADD COLUMN check_result jsonb;

-- Bestehende Report-Only-Regeln: ab ihrer letzten Änderung zählen.
UPDATE header_rules SET report_only_since = updated_at WHERE mode = 'report-only';
