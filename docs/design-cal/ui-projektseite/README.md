# Projektseite im neuen Design (Branch `ui-projektseite`)

Überarbeitung der Projektseite nach den Referenzbildern `docs/design-cal/referenz-*.png`,
umgesetzt mit den echten Komponenten, Tokens (`packages/web/src/styles.css`) und Cal Sans.
Alles in Hell und Dunkel; Screenshots bei 1440 px, nur Desktop.

Screenshots neu aufnehmen (Port 5199 muss frei sein):

```
pnpm --filter @airlock/web exec tsx design-shots/shoot.ts --out docs/design-cal/ui-projektseite --only p1,p2,p3,p4,p5,p6,p7
```

| Punkt | Commit | Screenshots |
|---|---|---|
| 1 Deployments | 70c369d | `1-deployments-*` |
| 2 Security-Karte | 7b015b5 | `2-security-karte-*` |
| 3 Aktivität und Audit-Log | 4354043 | `3-aktivitaet-karte-*`, `3-audit-log*` |
| 4 Eckdaten | dff2783 | `4-eckdaten-*`, `4-system-frist-*` |
| 5 Reiter | c9b7edf, cbb6aff | `5-reiter-*`, `5-zugriffe*` |
| 6 Einstellungen | ef34124 | `6-einstellungen-*` |
| 7 Pause-Seite bearbeiten | 1933f72 | `7-pause-*` |
| Gutachten | baabae1 | – |

## 1 Deployments

- Grund, Auslöser und Commit-Betreff je Deployment gespeichert (Migration `0016_deployment_reason.sql`;
  0015 belegt `milestone-9`). Alte Einträge: Grund und Auslöser aus dem Audit-Log abgeleitet
  (`api/src/domain/deploy-reason.ts`, getestet), sonst «Neu deployt».
- Auslöser: «du» (Session), Claude-Symbol mit Token-Name bei MCP (`mcp:<Token>`), «automatisch» bei Jobs.
- Aktive Version als Fläche oben, laufende Nummer rechts; «gleicher Stand» ohne Zurückrollen;
  Dauer unter 1 s «sofort», nur bei erfolgreichem Build/Start; ältere gleiche Stände als
  aufklappbare Sammelzeile (Zurückrollen nur auf der neuesten darin). Gleich in Karte und Reiter (dort mit Log).

## 2 Security-Karte

- Note im Ring, Urteil in Worten, «±n seit letztem Scan» (API: `previousScore`, `nextScheduledAt`).
- Eine Zeile statt vier Zähler; bis zu zwei Befunde mit Aktion; bei CSP die Inline-Analyse als
  Unterzeile (die Analyse läuft jetzt auch ohne CSP-Regel, 60 s gecacht).
- Fusszeile mit Stufen und «Neu scannen»; ohne Befunde grüne Zeile mit Schutzmassnahmen und nächstem Scan.

## 3 Aktivität und Audit-Log

- Zentrale Tabelle Ereignis → Titel, Unterzeile, Kategorie in `web/src/lib/activity.ts`; unbekannte
  Typen bekommen einen lesbaren Satz aus ihren Wortteilen. `describeAudit` (Projektliste) nutzt sie auch.
- Bündeln: Header + Nachprüfung (Chip Note vorher → nachher), Pausieren + Pause-Seite, Code/Anlegen +
  Deploy + Scan, Scan gestartet + fertig; MCP-Aufrufe gehen im Ereignis auf.
- API neu: Ereignis `scan.done` (Note, Dauer), Nachprüfung mit `before/after`, MCP-Aufrufe mit
  `targetId` des Projekts. Audit-Log mit `?projekt=<id>` und aufklappbaren Rohdaten.

## 4 Eckdaten

- Zeilen je nach Art (statisch ohne Grenzen/Verbrauch); Quelle mit Herkunft (`createdBy` in
  GET `/projects/:id`), «Dateien ansehen» als Dialog.
- Ablauf als eigener Hinweis: neutral, ab 7 Tagen vorher Warnfarbe; «Behalten» / «Ablauf wieder aktivieren».
- Frist (`CHAT_EXPIRY_DAYS`) in System → Übersicht änderbar (`GET/PUT /system/expiry`, Wert in der
  Datenbank gilt vor der Umgebungsvariable).

## 5 Reiter

- Übersicht · Security · Deployments · Logs, Einstellungen rechts mit Zahnrad; unterstrichen statt Kapsel
  (gilt auch für die Reiter der Systemseite – dieselbe Komponente); Hover nur Textfarbe.
- Zähler (Security in Warnfarbe), grüner Live-Punkt bei Logs; Pfeiltasten, Pos1, Ende.
- Statische Seiten: «Zugriffe» aus Caddys Zugriffs-Log (neuer Logger `site` für statische Routen,
  `GET /projects/:id/access`, 24 Stunden, IP gekürzt), Filter nach Statusklasse.

## 6 Einstellungen

- Sprungnavigation (sticky, aktiver Abschnitt markiert), Karten mit Zeilen.
- Veröffentlichung: Pille «Öffentlich seit …», Hauptaktion im Kopf; Adresse «Ändern» (neuer Übergang
  `rename` mit Rückgängig); Cloudflare Access als Schalter – Rückfrage beim Einschalten und, wie bisher,
  beim Ausschalten; Pause-Seite «Anpassen».
- Erreichbarkeit: Schalter speichern sofort, «✓ gespeichert», Toast mit Rückgängig.
- Security-Header eingeklappt mit «Verwalten»; Auto-Deploy (nur Repo-Projekte); Ablauf; Gefahrenzone
  ganz unten. «Verschieben …» erscheint erst mit Umgebungen (Meilenstein 9).

## 7 Pause-Seite bearbeiten

- Umschalter «Einfach» / «HTML» im Kopf; HTML mit CodeMirror 6 (eigenes Bündel, lädt erst im HTML-Modus),
  Platzhalter per Klick, «Formatieren», «Vorlage», Vollbild; Editor-Farben aus `--cm-*`.
- Vorschau im Browser-Rahmen mit Adresse, startet im aktuellen Modus.
- Prüfleiste live; dieselbe Prüfung (`pauseHtmlProblems`) im Schema, also auch beim Server.

## Prüfungen

- `pnpm -r typecheck`, `pnpm --filter @airlock/api test` (646 grün), `pnpm -r build`,
  `node docs/design-cal/contrast.mjs` (neu: Claude-Funke, Editor-Farben) – alles grün beim letzten Commit.
- Impeccable als Gutachter: Detektor ohne Befund; manuell zwei Kleinigkeiten behoben (baabae1).
- Bewegung nach Emil: Sammelzeile und Header-Liste klappen über `grid-template-rows` (200 ms, ease-out),
  Schalter gleitet 160 ms, Reiter nur Farbe; alles ohne Bewegung bei `prefers-reduced-motion`.
  Der Emil-Skill selbst lief in dieser Session nicht.

## Offen und Hinweise zum Zusammenführen

- Nicht im laufenden Stack geprüft: Caddy-Logger `site`, Ableitung alter Deployments aus echten Audit-Daten.
- Hauptbündel der App ist ~730 KB (Warnung von Vite); bestand vor dieser Arbeit, CodeMirror ist abgetrennt.
- Konflikte mit `milestone-9` erwartbar: `ProjectDetail.tsx`, `styles.css`, `design-shots/fixtures.ts`,
  `shoot.ts`, `mcp/server.ts`, `shared/src/index.ts`.
