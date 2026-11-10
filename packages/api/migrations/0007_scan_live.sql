-- Live-Anzeige der Scans: wer hat ausgelöst (Deploy, MCP, manuell, Zeitplan) und als wer.
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS trigger text;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS actor text;
