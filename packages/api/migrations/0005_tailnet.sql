-- Meilenstein 4: LAN und Tailnet unter derselben Adresse.
--
-- Bisher war routes.hostname global eindeutig; ein zweites Ziel bekam
-- deshalb einen Namen "tailnet-<host>". Neu ist (target, hostname)
-- eindeutig, LAN und Tailnet tragen denselben Namen (SPEC).

ALTER TABLE routes DROP CONSTRAINT IF EXISTS routes_hostname_key;
CREATE UNIQUE INDEX routes_target_hostname ON routes (target, hostname);

-- Bestehende "tailnet-<host>"-Einträge auf den Namen der LAN-Route ziehen.
UPDATE routes AS t
SET hostname = l.hostname
FROM routes AS l
WHERE t.target = 'tailnet'
  AND l.target = 'lan'
  AND l.project_id = t.project_id
  AND t.hostname = 'tailnet-' || l.hostname;
