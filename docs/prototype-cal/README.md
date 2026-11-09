# Prototyp «cal» – helles Schwarz-Weiss-Theme

Branch `design/cal-prototype`. Dieselbe App mit echten Komponenten unter `/prototype/…`
(z. B. `http://localhost:5173/prototype/projekte`), Umschalter Hell/Dunkel oben rechts,
«Original» führt zurück. Das Midnight-Design unter allen anderen Pfaden ist unverändert.

## Analyse des bestehenden Frontends

| | Befund |
|---|---|
| Organisation | Eine Datei `packages/web/src/styles.css` (1250 Zeilen), Tokens in `:root`, 517 `var()`-Bezüge |
| Feste Farben in CSS | 39 ausserhalb `:root`; meist rgba-Abstufungen der Statusfarben für Rahmen (`rgba(244,116,116,.35)` …), dazu `#07090b` (Log/Code), `#ffffff` (Hover des Primärbuttons), `rgba(255,255,255,.03)` (Zeilen-Hover), 6 Graustufen für Hover-Rahmen |
| Feste Farben in Komponenten | 4, alle im Entwickler-Umschalter `DemoToggle.tsx` (nur Dev); sonst keine Inline-Farben |
| Radien | Zentral (`--r-sm/--r/--r-lg`, 42 Bezüge); 8 Ausreisser (2, 3, 5 px, 50 %, 999px) |
| Schatten | 3, alle fest (Menü, Feld-Fehler, Diagramm-Punkt) |
| Schriften | Zentral (`--font`, `--mono`); Mono 36× genutzt, oft für Beschriftungen in Versalien |
| Schriftgrössen | Verstreut: 13 verschiedene feste Werte (13px 61×, 12px 34×, 14px 15× …), keine Tokens |

## Aufwand für die komplette Umstellung

Der Prototyp deckt die Token-Ebene und die meisten Komponenten schon ab; die Umstellung
heisst vor allem, `prototype-cal.css` in `styles.css` zu überführen und die nicht gezeigten
Seiten nachzuziehen.

| Variante | Aufwand | Darin |
|---|---|---|
| (a) nur Hell | **1,5–2 Tage** | Tokens tauschen; 39 feste Farben durch Tokens ersetzen (neue `--ok-line` …, `--code`, `--hover`, `--primary-hover`); Schriften; Beschriftungen von Mono-Versalien auf Inter; Button-/Link-Rückstellungen; restliche Seiten prüfen; Critique |
| (b) Hell + Dunkel umschaltbar | **2,5–3 Tage** | wie (a), dazu Theme-Mechanik (`data-theme`, `prefers-color-scheme`, Wahl im Profilmenü gespeichert), zweiter Kontrast-Durchgang, Logs/Code/Diagramme in beiden Varianten, Screenshots beider Varianten |

Die dunkle Variante kostet wenig Zusatzaufwand, weil die Farben schon jetzt als Tokens
angelegt sind und der Prototyp beide Sätze geprüft enthält.

## Stellen mit besonderer Arbeit

- **Statusfarben:** Rahmen und Flächen sind heute feste rgba-Werte auf dunklem Grund; auf Weiss brauchen sie eigene, dunklere Töne. Im Prototyp: `--ok/--warn/--bad/--info` je mit `-bg` und `-line`, Text ≥ 4,5:1 auf jeder Fläche **und** der eigenen Tönung (siehe unten). Jeder Zustand steht weiter als Wort oder Zeichen da, nie nur als Farbe.
- **Logs und Code:** `#07090b` fest im CSS; neu `--code` (hell: eingelassenes Grau, dunkel: fast Schwarz).
- **Diagramme (CPU/RAM):** Linie war Link-Blau; neu Tinte, Warnung und Fehler bleiben farbig.
- **Beschriftungen:** Spaltenköpfe, Eckdaten und Legenden waren 11px Mono-Versalien; neu 13px/500 Inter in Satzschreibung.
- **Buttons, die keine sind:** Textlinks, Icon-Knöpfe, Marke und Profil sind `<button>`; eine Grundregel für Buttons braucht für sie Rückstellungen (im Prototyp vorhanden).
- **Feldrahmen:** Die zarten Grautöne üblicher heller Oberflächen liegen unter 3:1 (WCAG 1.4.11); Felder haben einen eigenen, kräftigeren Rahmen (`--field-line`).
- **Schriftgrössen:** ohne Tokens verstreut; für die Umstellung lohnt eine kleine Skala (12/13/14/15/18/30).

## Was übernommen wurde

- Graue Fläche, weisse Karten mit Haarlinie und weichem Schatten, eine Radius-Skala 6/8/12.
- Fast schwarze Tinte (`#111113`, nie `#000`), schwarzer Primär-Button ohne Schatten, ein Sekundär-Stil.
- Cal Sans (OFL, `@fontsource/cal-sans`) für Seitentitel, Abschnitte und Kennzahlen; Inter für Text; Geist Mono bleibt für Adressen, Versionen, Logs. Alle Schriften lokal gebündelt, nur im Prototyp geladen.
- Seitenleiste mit weissem aktivem Eintrag, Kopf mit Profil-Icon (Initiale auf Tinte).
- Reiter und Filter als eine Steuerung: graue Schiene, weisses Feld.
- Links mit Haarlinie (nicht nur Farbe).
- Dunkel im gleichen Stil, fast nur Schwarz und Grau; Primär-Button wird weiss.
- Kein Logo und kein Markenelement von cal.com.

**Bewegung (nach Emil):** nur Druck-Feedback auf Buttons (`scale(.97)`, 160 ms, `cubic-bezier(.23,1,.32,1)`) und das Aufklappen der Menüs von der Auslöser-Ecke (`@starting-style`, Opacity + `scale(.97)`, 150 ms). Hover nur als Farbwechsel. Der Theme-Wechsel ist bewusst nicht animiert. Unter «weniger Bewegung» bleibt nur der Farbwechsel.

**Kontrast** (`node docs/prototype-cal/contrast.mjs`, alle Werte erfüllt):

| | Hell | Dunkel |
|---|---|---|
| Text auf Karte | 18,9 : 1 | 16,5 : 1 |
| Grauer Text (muted) | 5,4–5,9 : 1 | 6,7–7,2 : 1 |
| ok / Warnung / Fehler / Info, schlechteste Fläche | 4,7 / 5,2 / 4,8 / 5,3 : 1 | 7,2 / 7,7 / 5,7 / 6,4 : 1 |
| Feldrahmen | 3,2–3,4 : 1 | 3,5–3,8 : 1 |

Impeccable (nur als Gutachter): Detektor ohne Befund; Critique-Befunde behoben
(Rahmen im Profilmenü, kaum sichtbare Zeilenmenü-Punkte, Gruppentitel als Kerbe in der Kartenkante).

## Screenshots

`pnpm --filter @deployer/web exec tsx prototype-shots/shoot.ts` – startet Vite selbst, Daten aus
`packages/web/prototype-shots/fixtures.ts` (typisiert gegen die echten DTOs, erfundene Projekte).
Nur Desktop (1440 px); deployer ist kein Werkzeug fürs Handy.

| Seite | Hell | Dunkel |
|---|---|---|
| Projektübersicht | `01-projekte-hell-desktop.png` | `01-projekte-dunkel-desktop.png` |
| Projektdetail | `02-projekt-uebersicht-hell-desktop.png` | `02-projekt-uebersicht-dunkel-desktop.png` |
| Security-Reiter | `03-projekt-security-hell-desktop.png` | `03-projekt-security-dunkel-desktop.png` |
| System mit Cloudflare-/Zertifikats-Assistent | `04-system-cloudflare-hell-desktop.png` | `04-system-cloudflare-dunkel-desktop.png` |
| Formular mit Validierung | `05-formular-validierung-hell-desktop.png` | `05-formular-validierung-dunkel-desktop.png` |
| Profilmenü offen | `06-profilmenue-hell-desktop.png` | `06-profilmenue-dunkel-desktop.png` |

## Offen

- Nicht im Prototyp geprüft: Domains, Externe Ziele, Tokens, Audit, Konto, Anmeldung, die Reiter Deployments/Logs/Einstellungen. Sie erben die Tokens, sind aber nicht angesehen.
- Schmale Fenster: nicht bearbeitet (bewusst, kein Handy-Werkzeug); die bestehenden Umbrüche gelten weiter.
- Inter setzt den Bindestrich zwischen Grossbuchstaben etwas höher («Kontoauszug-Reader»); unauffällig, bei Bedarf über `font-feature-settings`.
- Cal Sans hat nur einen Schnitt; deshalb nur für Titel und Kennzahlen, nie für Text.
- Kein PRODUCT.md/DESIGN.md: vor der Umstellung lohnt `impeccable init`, damit spätere Gutachten den neuen Stil als Massstab haben.
- Theme-Wahl im Prototyp liegt im Browser (`localStorage`); in der Umstellung ins Profilmenü und ggf. pro Benutzer.
