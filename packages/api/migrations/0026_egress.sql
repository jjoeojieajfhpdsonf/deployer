-- Nacht 3, Etappe 4 «Container-Ausgang begrenzen»: Modus je Projekt,
-- Ausnahmen und die beobachteten bzw. gesperrten Versuche. Nur neue Spalten
-- mit Standardwert und neue Tabellen.
--
-- egress_mode:    internet (Standard) | abgeschottet | frei
-- egress_enforce: false = nur beobachten (protokollieren, nie sperren),
--                 true  = durchsetzen.
-- Bestehende Projekte bekommen beim Hinzufügen der Spalte «false» (beobachten),
-- danach gilt für neue Projekte der Standard «true» (durchsetzen). Vorschauen
-- folgen immer ihrem Projekt (preview_of), ihre eigenen Spalten zählen nicht.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS egress_mode text NOT NULL DEFAULT 'internet';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS egress_enforce boolean NOT NULL DEFAULT false;
ALTER TABLE projects ALTER COLUMN egress_enforce SET DEFAULT true;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_egress_mode_check') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_egress_mode_check CHECK (egress_mode IN ('internet', 'abgeschottet', 'frei'));
  END IF;
END $$;

-- Ausnahmen: Ziel wie eingegeben (IP, CIDR oder Hostname; Hostnamen löst
-- Airlock beim Anwenden auf), optional Port und Protokoll.
CREATE TABLE IF NOT EXISTS egress_exceptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target      text NOT NULL,
  port        integer CHECK (port BETWEEN 1 AND 65535),
  protocol    text NOT NULL DEFAULT 'tcp' CHECK (protocol IN ('tcp', 'udp')),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS egress_exceptions_project_idx ON egress_exceptions (project_id);

-- Versuche, gebündelt je Stunde: «Hätte gesperrt: 192.168.0.12:445 (3×)».
-- Quelle: NFLOG des Firewall-Dienstes (begrenzt auf 20 Pakete pro Minute und
-- Projekt-Netz). Etappe 5 (Einbruchserkennung) liest die gesperrten hier
-- (egress/service.ts: listEgressAttempts). port 0 = ohne Port (ICMP).
CREATE TABLE IF NOT EXISTS egress_attempts (
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  verdict      text NOT NULL CHECK (verdict IN ('beobachtet', 'gesperrt')),
  protocol     text NOT NULL,
  destination  text NOT NULL,
  port         integer NOT NULL DEFAULT 0,
  bucket       timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  to_server    boolean NOT NULL DEFAULT false,
  first_seen   timestamptz NOT NULL,
  last_seen    timestamptz NOT NULL,
  PRIMARY KEY (project_id, verdict, protocol, destination, port, bucket)
);
CREATE INDEX IF NOT EXISTS egress_attempts_last_seen_idx ON egress_attempts (last_seen);
