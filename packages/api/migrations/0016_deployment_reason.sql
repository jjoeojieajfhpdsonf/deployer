-- Projektseite: Grund und Auslöser je Deployment (Titel der Zeile).
-- (0015 belegt Branch milestone-9, «Umgebungen».)

-- { kind, detail } – siehe DeployReason in @airlock/shared. NULL = alter
-- Eintrag; die API leitet den Grund dann aus dem Audit-Log ab.
ALTER TABLE deployments ADD COLUMN reason jsonb;
-- «ui:joel», «token:<Name>», «system:auto-deploy»
ALTER TABLE deployments ADD COLUMN actor text;
-- Betreff des Commits dieser Fassung (Chat-Projekte, Repo), soweit bekannt
ALTER TABLE deployments ADD COLUMN message text;
