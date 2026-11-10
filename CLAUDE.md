# Design-Regeln für dieses Projekt

- Den visuellen Stil (Layout, Farben, Typografie, Effekte) bestimmt ausschliesslich der Taste Skill (design-taste-frontend).
- Impeccable nur als Gutachter verwenden (audit, critique, detect). Keine Impeccable-Befehle, die den Look ändern (shape, bolder, quieter, colorize, typeset, layout, overdrive, delight, animate).
- Animationen nur nach Emils Skills (animate, choreograph, review-animations). Keine zusätzlichen Taste-Skill-Effekte ohne ausdrücklichen Auftrag.
- Bei widersprüchlichen Befunden gilt der Stil des Taste Skills. Funktionale Befunde (Kontrast, Schriftgrösse, kaputte Darstellung) immer beheben.

# Visuelle Regressionstests

- Nach jeder Änderung an der Oberfläche `pnpm test:visual` laufen lassen (Hauptseiten und Zustände, Hell und Dunkel, 1440 px, feste Uhr).
- Abweichungen nie blind übernehmen: Diff-Bilder in `packages/web/visual/ergebnis/` (bzw. Bericht in `visual/bericht/`) ansehen. Nur gewollte Änderungen mit `pnpm test:visual:update` als neue Referenz übernehmen und in der Commit-Nachricht nennen, welche Bilder sich warum geändert haben.
- Neue Ansicht oder neuer Zustand: Szene in `packages/web/design-shots/shoot.ts` anlegen und den Namen in `packages/web/visual/ui.spec.ts` (`VISUAL_SCENES`) eintragen.
