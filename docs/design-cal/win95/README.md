# Verstecktes Theme «Windows 95» (Branch `theme-win95`)

Spass-Theme nach der Vorlage `win95-vorlage.png`. Nur das Aussehen ändert sich; Bedienung,
Markup und Tastatur bleiben wie in Hell und Dunkel.

| Bild | Was |
|---|---|
| `umgesetzt-projekte.png` | Projekte-Seite in Windows 95 (Fenster 1440×900) |
| `umgesetzt-projektdetail.png` | Projektdetail, Reiter Übersicht |
| `umgesetzt-profilmenue.png` | Profilmenü mit vierter Option «Windows 95» (gewählt) |
| `umgesetzt-freischalten.png` | Freischalten per Konami-Code in Hell: Meldung und neue Option |
| `umgesetzt-bausteine.png` | Ausschnitt `/design`: Hell, Dunkel, Windows 95 als dritte Spalte |

## Freischalten (Easter Egg)

- Zuerst stehen unter «Darstellung» nur Hell / Dunkel / Wie das Gerät.
- 7 schnelle Klicks auf «Version x.y.z» unten links (höchstens 1.5 s zwischen zwei Klicks)
  **oder** irgendwo ↑↑↓↓←→←→ B A (nicht in Eingabefeldern; Gross-/Kleinbuchstaben egal).
- Danach die Meldung «Windows 95 freigeschaltet» (kein Ton) und die vierte Option im Profilmenü.
- Gespeichert auf dem Server in den Präferenzen (`win95Unlocked`), gilt also auf jedem Gerät.
  Die Freischaltung bleibt; `false` nimmt sie nicht zurück. Ohne Freischaltung lehnt der Server
  `theme: 'win95'` ab, und ein gespeichertes `win95` ohne Freischaltung fällt beim Lesen auf
  den Standard zurück. Erstes Freischalten steht im Audit (`ui.win95_unlocked`).
- Keine Migration nötig: Die Präferenzen liegen als JSON in `settings` (kein CHECK, kein Enum).

## Umsetzung

- `shared`: `themePrefs` um `win95`, Feld `win95Unlocked`, Zod-Meldung nennt alle vier.
- `api/domain/ui-prefs.ts`: Lesen, Zusammenführen und Prüfen wie oben; `/auth/me` liefert `win95Unlocked`.
- `web/lib/easter-egg.ts`: Konami-Erkennung und Klick-Zähler als reine Funktionen (getestet).
- `web/components/Win95.tsx`: Freischalten (Server, Cache, Meldung), Konami-Lauscher, Taskleiste.
- `web/lib/theme.ts` und das Vorabskript in `index.html`: `win95` setzt `html[data-theme='win95']`,
  `color-scheme: light`, Theme-Farbe Teal.
- `styles.css`:
  - Token-Block `:root[data-theme='win95'], .theme-win95` – Desktop `#008080`, Flächen `#c0c0c0`,
    Text `#000`, Primär `#000080`, Radius überall 0, Schatten als Bevel statt weich,
    Schrift «MS Sans Serif», Tahoma, Geneva (nur Systemschriften) in 12–13 px.
  - Zusatz-Block am Ende: Inhalt als Fenster «Airlock» auf dem Desktop; Karten als Fenster mit
    Titelleiste (Verlauf `#000080 → #1084d0`, weisse fette Schrift, Überschrift der Karte wandert
    in die Leiste); Knöpfe und Felder mit 2-px-Bevel (gedrückt umgekehrt, Fokus gepunktet);
    Seitenleiste als Startmenü mit senkrechtem Band; Menüs mit blauer Auswahl; Taskleiste.
  - Die Fenster-Knöpfe _ □ ✕ sind ein SVG-Hintergrundbild auf der Titelleiste – reine Deko, für
    Screenreader unsichtbar, ohne JSX. Einzige Theme-Verzweigung im JSX ist die Taskleiste
    («Start», laufendes Programm, Uhrzeit; `aria-hidden`).
  - Der Zusatz-Block gilt per `@scope` auch in der Spalte «Windows 95» unter `/design`, aber
    nicht in den Spalten Hell und Dunkel, wenn die Seite selbst in Windows 95 steht.
- `/design`: dritte Spalte «Windows 95». Drei Spalten sind schmal; Zeilen und Kennzahlen rücken
  in schmalen Spalten per Container-Query zusammen (sonst brach «Wert» Buchstabe für Buchstabe).
- `contrast.mjs` prüft das dritte Theme, dazu Weiss auf der Titelleiste (Anfang und 60 %-Punkt
  des Verlaufs; der Titeltext ist auf 60 % Breite begrenzt).
- Screenshot-Werkzeug: `--themes hell,dunkel,win95` und `--viewport`; neue Szene
  `win95-freigeschaltet`. Visuelle und axe-Tests laufen zusätzlich für `WIN95_SCENES` in Windows 95.

## Abweichungen von der Vorlage

- Primärknöpfe sind grau mit fettem Text und schwarzem Rahmen (Standard-Knopf in Windows 95), nicht
  blau gefüllt. `--primary` (#000080) trägt Auswahl, aktive Navigation, Avatar und Balken.
- Der Desktop-Grund (Teal) ist `--desktop`; `--bg` ist das Grau der Fenster, weil Schwarz auf Teal
  nur 4.4:1 erreicht und Text überall auf Fenstern steht.
- Keine Desktop-Symbole, kein Menüband «Datei Bearbeiten …» und keine Statusleiste im Fenster –
  das bräuchte neues Markup.

## Screenshots neu aufnehmen

```
pnpm --filter @airlock/web exec tsx design-shots/shoot.ts --out docs/design-cal/win95/neu --only projekte,projekt-uebersicht,shell-profilmenue --themes win95 --viewport
```
