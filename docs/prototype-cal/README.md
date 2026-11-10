# Prototyp «cal» – Formensprache der cal.com-Startseite

Branch `design/cal-prototype`. Dieselbe App mit echten Komponenten unter `/prototype/…`
(z. B. `http://localhost:5173/prototype/projekte`), Umschalter Hell/Dunkel oben rechts,
«Original» führt zurück. Das Midnight-Design unter allen anderen Pfaden ist unverändert
(Ausnahme: der Fehler in den «…»-Knöpfen ist überall behoben, siehe unten).

**Version 2** (nach Rückmeldung «altes Layout mit neuen Farben»): Vorbild ist jetzt die
Startseite cal.com, gemessen statt geschätzt, und das Layout ist mit umgebaut.

## 1. Referenz

- Screenshots in `referenz/`: `cal-hero.png`, `cal-features.png`, `cal-preise.png`
  (die Startseite hat keinen Preisbereich mehr; die Preiskarten stammen von `cal.com/pricing`).
- Gemessene Styles: `referenz/stil.md` (Tabelle), Rohdaten `referenz/styles.json`.
- Skript: `pnpm --filter @deployer/web exec tsx prototype-shots/reference.ts`.
- Übernommen ist nur die Formensprache; kein Logo, kein Text, keine Bilder oder Illustrationen.

Die wichtigsten Messwerte und was daraus wurde:

| cal.com (gemessen) | deployer-Prototyp |
|---|---|
| Karten weiss, Radius 20, Ring `inset 0 0 0 1px rgba(15,35,75,.07)`, Polster 24 | genau so; dazu ein sehr weicher Schatten, damit Karten auf der grauen Fläche stehen |
| Buttons Radius 10 (36 hoch) bzw. 12 (gross), Primär `#242424` mit Lichtkante | genau so; Hauptaktion der Seite und des Formulars in der grossen Variante |
| Badges Radius 8, 24 hoch, Polster 4/10, Fläche statt Rahmen | Chips (LAN/Tailnet), Befund-Zähler, Schwere, Status-Pille |
| Titel Cal Sans, −1 % Laufweite | Cal Sans nur ab 24 px: Seitentitel 40, Abschnitte 24, Kennzahlen 44, aktueller Assistenten-Schritt 24 |
| Fliesstext Cal Sans (eigene Variante) | Inter (Vorgabe); Monospace nur noch für Logs, Commit-Hashes, Code |
| Eine dunkle hervorgehobene Karte (Preis «Organizations») | die Kennzahl mit offenem Befund als dunkle Bento-Karte |
| Feature-Liste: eine aktive weisse Karte, übrige zurückgenommen | Cloudflare-Assistent: jeder Schritt eine Karte, der aktuelle erhöht mit Cal-Sans-Titel |

**Abweichung vom Auftrag, bewusst:** «Pillen-Buttons wie auf cal.com» – gemessen sind die
Buttons auf cal.com *keine* Pillen (Radius 10–12 px). Der Prototyp folgt der Messung; auf
Pille umstellen ist ein Token (`--r` / `--r-md` auf 999px).

## 2. Umbau

- **Projektübersicht:** keine Tabelle mehr, sondern Projekt-Karten im Raster (Name als Link über die ganze Karte, Status-Badge, Adresse, Erreichbarkeit als Pillen, Security-Note und letzter Deploy in eingelassenen Feldern, «Öffnen» und «…»). Kennzahlen oben als Bento-Karten. Die Karte nutzt dieselben Bausteine wie die Tabellenzeile; das Aktionsmenü ist dafür eine eigene Komponente (`ProjectMenu`) geworden, die Zeile und Karte teilen.
- **Weniger Linien:** Listen (Aktivität, Dienste, Eckdaten, Deployments, Assistent, Verwaltung) ohne Trennlinie zwischen jeder Zeile; Befunde und Assistenten-Schritte als einzelne Karten; Pillen ohne Rahmen.
- **Seitenleiste und Kopf:** breiter (256 px), ohne Trennlinie, Einträge 40 hoch, aktiver Eintrag als weisse Karte, Zähler als Pillen; Kopf mit mehr Luft, Suche als Karte.
- **Mehr Weissraum:** Abschnitte 56 px auseinander, Kartenpolster 24–28 px, Seitenkopf 40 px Abstand.
- **Fehler behoben:** Die «…»-Knöpfe waren leer – die drei Punkte waren Linien der Länge 0,01, bei 16 px kaum 2 px gross. Jetzt gefüllte Kreise (`components/Icons.tsx`, gilt auch im Original).

Bewegung nach Emil: Druck-Feedback auf Buttons (`scale(.97)`, 160 ms), Menüs klappen von der
Auslöser-Ecke auf (150 ms), Karten reagieren auf Hover nur mit dem Schatten – nichts bewegt sich,
weil Projektkarten dutzendfach am Tag angefahren werden. Theme-Wechsel nicht animiert.

**Kontrast** (`node docs/prototype-cal/contrast.mjs`, alle Ziele erfüllt): Text 14–15 : 1,
grauer Text ≥ 5,5 : 1 (cal.com nutzt für Unterzeilen `#858993` mit 3,6 : 1 – für kleinen Text
nicht zulässig, deshalb hier `#5f636c`), Statusfarben ≥ 4,7 : 1 auf jeder Fläche und eigener
Tönung, Feldrahmen ≥ 3 : 1. Dunkel: alles ≥ 5,6 : 1.

## 3. Vergleich

`vergleich-<seite>-<hell|dunkel>.png`: links der Prototyp, rechts der passende cal.com-Ausschnitt
(`prototype-shots/compare.ts`). cal.com hat auf der Startseite kein Dunkel; die dunklen Vergleiche
stellen den Prototyp neben dieselbe helle Referenz.

| Seite | Referenz | Wo es noch abweicht |
|---|---|---|
| Projektübersicht | Preiskarten | cal.com hat weissen Grund und Karten mit Haarlinie; deployer graue Fläche mit weissen Karten (Vorgabe). Die Preiskarten tragen Buttons über die ganze Breite; die Projekt-Karten kompakte Aktionen rechts, weil die ganze Karte schon klickbar ist. Kennzahlen 44 px statt der 56–80 px der Marketing-Titel. |
| Projektdetail | Feature-Karten | Die Seite bleibt zweispaltig mit vielen Karten; cal.com zeigt pro Abschnitt eine grosse Aussage und ein Bild. Diagramme (CPU/RAM) haben bei cal.com kein Gegenstück. |
| Security | Preiskarten | Befund-Karten sind textlastig und tragen je einen Button; die Häkchen-Listen von cal.com sind leichter. Der Ergebnis-Block ist noch eine Beschriftung/Wert-Liste statt Bento. |
| System / Assistent | Feature-Karten | Zurückgenommene Schritte sind auf cal.com grau gefüllte Karten auf Weiss; auf der grauen deployer-Fläche wären sie unsichtbar – deshalb weiss (erledigt) bzw. nur Ring (gesperrt). Die Seite ist lang (Benachrichtigungen, Netz); cal.com hält jeden Abschnitt auf einem Bildschirm. |
| Formular | Hero | Felder haben einen dunkleren Rahmen als bei cal.com (WCAG 1.4.11, mindestens 3 : 1). Die gewählte Quelle hat einen 2-px-Ring in Tinte; dafür gibt es bei cal.com kein Vorbild. |
| Kopf und Profilmenü | Hero (Navigation) | cal.com hat oben eine graue Navigationsleiste in einer abgerundeten Fläche; deployer behält die Seitenleiste (App mit sieben Bereichen). Profilmenü als Karte mit Schatten wie die Dropdowns von cal.com. |
| Dunkel (alle) | – | Ohne Vorbild auf cal.com; eigene Ableitung in Schwarz und Grau, die hervorgehobene Karte kehrt sich zur hellen um. |

## Screenshots

`pnpm --filter @deployer/web exec tsx prototype-shots/shoot.ts` – startet Vite selbst, Daten aus
`prototype-shots/fixtures.ts` (typisiert gegen die echten DTOs, erfundene Projekte), nur Desktop
(1440 px). Dateien `01-…` bis `06-…` je `hell` und `dunkel`.

## Aufwand für die komplette Umstellung (aktualisiert)

| Variante | Aufwand | Darin |
|---|---|---|
| (a) nur Hell | **3–4 Tage** | wie Version 1 (Tokens, 39 feste Farben, Schriften, Beschriftungen) plus das Layout: Projekt-Karten statt Tabelle, Listen ohne Linien, Befunde und Assistent als Karten, Seitenleiste; die restlichen Seiten (Domains, Externe Ziele, Tokens, Audit, Konto, Anmeldung, Reiter Deployments/Logs/Einstellungen) im gleichen Stil |
| (b) Hell + Dunkel umschaltbar | **4–5 Tage** | wie (a), dazu Theme-Mechanik (Profilmenü, `prefers-color-scheme`), zweiter Kontrast- und Screenshot-Durchgang |

## Offen

- Nicht im Prototyp angesehen: Domains, Externe Ziele, Tokens, Audit, Konto, Anmeldung, Reiter Deployments/Logs/Einstellungen.
- Security-Ergebnis als Bento-Karten und leichtere Befund-Karten (siehe Vergleich).
- Systemseite in kürzere Abschnitte teilen (Benachrichtigungen eigene Seite?).
- Kein PRODUCT.md/DESIGN.md: vor der Umstellung `impeccable init`, damit spätere Gutachten den neuen Stil als Massstab haben.
