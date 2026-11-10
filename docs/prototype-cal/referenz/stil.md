# Referenz cal.com – gemessene Styles

Gemessen am 9.11.2026 mit Playwright (Chrome, 1440 × 900, `getComputedStyle`), Skript
`packages/web/prototype-shots/reference.ts`, Rohdaten in `styles.json`, Zusammenfassung mit
`node packages/web/prototype-shots/summarize.mjs docs/prototype-cal/referenz/styles.json`.
Häufigster Wert zuerst, Anzahl in Klammern. Screenshots nur als Vergleich: `cal-hero.png`,
`cal-features.png`, `cal-preise.png`.

Die Startseite hat keinen Preisbereich mehr; `cal-preise.png` stammt von `cal.com/pricing`.

Übernommen wird nur die **Formensprache** (Masse, Radien, Schatten, Abstände, Tonwerte), kein
Logo, kein Text, keine Bilder oder Illustrationen.

| Bauteil | border-radius | box-shadow | padding / gap | Schrift (Grösse / Gewicht / letter-spacing / line-height) | Farben |
|---|---|---|---|---|---|
| Seite | – | – | – | – | Grund `#ffffff`; graue Flächen `#f3f4f6` |
| Karte (weiss) | **20px** (9×), 22px (6×), 18px | **Ring statt Rahmen:** `inset 0 0 0 1px rgba(15,35,75,.07)` (15×); erhöht: `0 20px 25px -5px rgba(0,0,0,.1), 0 8px 10px -6px rgba(0,0,0,.1)` (1×) | **24px** (9×) | 16 / 400 / normal / 24px | Grund `#fff`, Text `#242424`, Rahmen 0 |
| Karte (grau, FAQ) | 20px | keine | 24px | – | Grund `#f3f4f6` |
| Button | **10px** (h 36, 23×), **12px** (h 38 und Hero, 13×) – keine Pillen | Sekundär: `0 1px 2px rgba(0,0,0,.05)`; Primär zusätzlich `inset 0 1px 0 rgba(255,255,255,.16)` | `0 14px` / `1px 14px 0`, gap 6–8px | 14 / 500 / normal / 20–21px | Primär `#242424` auf `#fff`; Sekundär `#fff`, Rahmen `1px #e5e7eb`, Text `#242424` |
| Badge / Chip | **8px** (24×), 10px (14×), Pille (7×) | meist keine; weisse Variante: `0 0 0 1px rgba(15,35,75,.07), 0 1px 2px rgba(15,35,75,.04), inset 0 1px 0 #fff` | **4px 10px**, gap 4–8px, Höhe 24px | 13 / 500 / normal / 16px (auch 12–14px) | Flächen `#f3f4f6`, `#dee1e6`, `#fff`; dunkel `#242424` mit weissem Text |
| h1 | – | – | – | **80 / 700 / −0.8px (−1 %)** / 86.4px | `#242424` |
| h2 | – | – | – | **56 / 700 / −0.56px (−1 %)** / 58.8px | `#242424` |
| h3 / Kartentitel | – | – | – | 16–19 / 400–700 / normal bis −0.17px / 22–24px | `#242424` |
| Fliesstext | – | – | – | 14px (Karten) und 24px (Unterzeilen) / 400–500 / normal / 21px bzw. 32.4px | `#858993` (Unterzeilen), `#5f6570`, `#6a6e78`, `#374151` |

Beobachtungen:

- Schrift überall `calSans` (eigene Variante mit mehreren Gewichten). Für deployer gilt die
  Vorgabe: Cal Sans (`@fontsource/cal-sans`, ein Schnitt) nur für Titel und Kennzahlen ab ~24px,
  sonst Inter.
- `#858993` hat auf Weiss nur 3,6 : 1 – für grosse Unterzeilen (24px) zulässig, für kleinen Text
  nicht. deployer nimmt für kleinen grauen Text `#5f6570` (6,0 : 1) bzw. `#6a6e78` (5,1 : 1).
- Linien fast nur als Ring im Schatten; Listen in Karten mit 1px-Trennlinien `#e5e7eb` nur dort,
  wo Zeilen dicht stehen (Inbox), sonst Abstand statt Linie.
- Die hervorgehobene Preiskarte ist die einzige dunkle Fläche (`#242424`).
