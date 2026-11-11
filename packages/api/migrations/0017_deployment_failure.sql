-- UI-Qualität 2: Erklärung eines gescheiterten Deploys, festgehalten beim Scheitern
-- ({ kind, title, cause, action, lines, linesFrom, exitCode } – FailureExplanation in
-- @airlock/shared). So bleibt sie richtig, auch wenn danach eine Variable oder der Port
-- geändert wird, und die Projektliste muss keine Logs lesen. NULL = älterer Eintrag; die API
-- erklärt ihn beim ersten Lesen und trägt das Ergebnis nach.
ALTER TABLE deployments ADD COLUMN failure jsonb;
