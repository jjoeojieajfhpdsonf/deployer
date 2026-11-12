-- Etappe 7 «Spass-Paket»: erreichte Achievements (Liste im Konto).
-- Nur eine neue Tabelle. Ein Eintrag entsteht, sobald die Regel über die
-- echten Daten (Deploys, Routen, Scans, Verfügbarkeit, Freischaltungen)
-- zum ersten Mal erfüllt ist, und bleibt – auch wenn die Note später sinkt.
--
-- achieved_at: Zeitpunkt aus den Daten (z. B. Ende des ersten Deploys)
-- seen_at:     schon gemeldet (Konfetti nur einmal, nicht beim Neuladen)
CREATE TABLE IF NOT EXISTS achievements (
  id          text PRIMARY KEY,
  achieved_at timestamptz NOT NULL,
  seen_at     timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
