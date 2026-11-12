# Bericht: Zugriffe neu (Branch `ui-zugriffe`)

Stand 12.11.2026. Nicht gepusht, nicht nach main gemergt.

## Abhängigkeit zu `ui-besucher`

`ui-zugriffe` baut auf `ui-besucher` auf (zuerst ab 650c18d abgezweigt, dann auf 56e2444 nachgezogen –
ein sauberes Rebase ohne Konflikt). Grund: Punkt 5 verlangt, Provider/ASN, Browser/System und die
Scanner-Liste wiederzuverwenden. Die liegen dort bereits committet und werden hier unverändert benutzt:

- `packages/shared/src/traffic.ts`: `SCANNER_PATHS`, `isScannerPath`, `DATACENTER_ASNS`, `isDatacenterAsn`
- `packages/api/src/traffic/agent.ts`: `browserOf`, `systemOf`, `languageOf`
- `packages/api/src/traffic/classify.ts`: `botReason`, `wayOf`, `countryOf`, `deviceOf`
- `packages/api/src/traffic/geo.ts`: `AsnDb`, `CityDb` (DB-IP)

Neu angelegt wurde nichts davon doppelt. Merge-Reihenfolge: erst `ui-besucher`, dann `ui-zugriffe`.
main enthält inzwischen `ui-security` (3ef1db2), dieser Branch noch nicht: beim Merge sind Konflikte in
`styles.css`, `shoot.ts`, `scenes.ts` und `ProjectDetail.tsx` möglich (Listen und angehängte Blöcke).

## Umsetzung

- **Quelle** bleibt das Zugriffs-Log: `visits.log` und rotierte Dateien (`visits-*.log`, auch `.gz`,
  höchstens 2 Tage), gelesen nur auf Abruf. `GET /projects/:id/access?range=15m|1h|24h` (höchstens 5000)
  und live `GET …/access/stream?since=` (Anschluss aus den letzten 200 Anfragen im Speicher, über den
  bestehenden Ingest – kein zweites Mitlesen). Vorher kam der Reiter aus dem Container-Log von Caddy
  (Logger `site`); der wird nicht mehr gelesen, Caddy schreibt ihn aber weiter (Aufräumen: Folgearbeit).
- **Datenschutz**: Absender nur gekürzt (`192.168.1.x`), auch im CSV; Pfad und Referrer ohne Query;
  Header nur `user-agent`, `accept-language`, `sec-fetch-*`, `x-airlock-block`, gekürzt – nie Cookie,
  Authorization oder Cloudflare-Ortsangaben. Gespeichert wird nichts.
- **Regeln** rein in `packages/shared/src/access.ts` (getestet in `api/src/traffic/access-rules.test.ts`):
  Status-Einteilung, Herkunft, Zusammenfassen (gleicher Pfad + Status + Zugang + Herkunft, 5 Min. ab dem
  neuesten), Erklärungen (Docker-Netz + abgewiesen, Scanner-Pfad, Rechenzentrum), Warnung «> 3 in 1 Std.».
- **Oberfläche** `web/src/components/Access.tsx` nach der Vorlage: Werkzeugleiste (Suche, Status mit
  Anzahl, Zeitraum, Live, CSV), zweite Zeile (Zugang, drei Schalter mit Anzahl), Tabelle mit Tagestrennern,
  ×N, Zeitspanne, Detail rechts (unter 1100 px Schublade), Aktionen «Alle von diesem Zugang», «Nur dieser
  Pfad», «Anleitung». Alle Filter in der Adresse (`status`, `zeit`, `zugang`, `suche`, `einzeln`,
  `pruefungen`, `bots`, `zeile`). Pfeiltasten/Pos1/Ende wechseln die Zeile, Enter setzt den Fokus ins Detail.
  Neue Live-Zeilen kurz grün getönt (2,4 s, ease-out); mit reduzierter Bewegung ohne Animation.
  Kein Diagramm.
- **Server › Übersicht**: dieselbe Warnung wie die Gateway-Adressen auf Airlock, ergänzt um die
  Abweisungen aus dem Docker-Netz auf Projekten (`dockerBlocks`) – ein Banner, nicht zwei.

## Abweichungen von der Vorlage bzw. vom Auftrag

- **Abgewiesen** erkennt Airlock an `X-Airlock-Block` (heute nur `ip-filter`), an der Pause-Seite
  (`X-Airlock-State: paused`) und an 429 am CSP-Endpunkt (Rate-Limit). Caddy setzt `X-Airlock-Block`
  für Pause und Rate-Limit (noch) nicht – bewusst ohne Änderung an der Caddy-Konfiguration, weil das
  auch die Besucher-Zähler verschieben würde.
- **Status-Wörter**: neben ok / nicht gefunden / abgewiesen / Fehler auch «umgeleitet» (3xx) und
  «Clientfehler» (übrige 4xx), damit kein Code ein falsches Wort bekommt. Filter «Erfolg» umfasst 2xx/3xx.
- **Tailnet-Gerät**: Airlock kennt keine Tailnet-Namen; «iPhone», «Mac» … kommen aus dem User-Agent.
- **Absender im Detail** gekürzt (`172.25.0.x`), die Vorlage zeigte die volle Adresse.
- **Bots**: «Bots zeigen» betrifft sichere Bots (User-Agent); Rechenzentren und Scanner bleiben mit
  «Bot?» sichtbar (wie in der Vorlage). Eigene Prüfungen tragen eingeblendet «Prüfung».
- **Detail** 340 px statt 360 px, damit die fünf Spalten bei 1440 px ungekürzt passen.
- Der Reiter bleibt wie bisher nur bei **statischen Seiten** («Zugriffe»); Container-Projekte haben dort
  «Logs». Die neue Quelle hätte Daten für alle Projekte (Folgearbeit, wenn gewünscht).
- Die Docker-Netz-Warnung zählt seit dem Start von Airlock (im Speicher); nach einem Neustart beginnt
  sie bei null. Benachrichtigung (`gateway_warning`) unverändert.

## Wie testen

- `pnpm --filter @airlock/shared build && pnpm -r typecheck && pnpm -r test`
- `node docs/design-cal/contrast.mjs`
- `VISUAL_PORT=5381 pnpm test:visual` (Szenen `zugriffe*`, auch Win95/Terminal; Tastatur-Test «Zugriffe»)
- Auf dem Server: Projekt › Zugriffe öffnen, Seite aus dem Tailnet aufrufen; mit maskiertem Tailnet
  erscheint «Docker-Netz · 172.x.0.x» mit Hinweis und nach > 3 Abweisungen das Banner in Server › Übersicht.

## Risiken

- 24 Std. liest bis zu ~60 MB Log je Abruf (Vorfilter ohne JSON, dann Parsen) – bei grossem Verkehr
  ein bis zwei Sekunden. Kein Polling, nur beim Öffnen und beim Wechsel des Zeitraums.
- Der Anschluss-Link «Anleitung» zeigt auf docs/INSTALL.md im GitHub-Repo (`GATEWAY_GUIDE_URL` in
  shared/access.ts) – nach einem Umbenennen des Repos dort anpassen.
- `ui-security` fehlt auf diesem Branch (siehe oben); Referenzbilder auf main können sich beim Merge
  gegenseitig verschieben – nach dem Merge `pnpm test:visual` laufen lassen.
