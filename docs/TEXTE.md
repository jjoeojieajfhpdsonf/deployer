# Sprache und Texte der Oberfläche

**Status: entschieden – Variante (b), verbindlich.** Antwort von Joël auf Frage Nr. 1 in
`docs/FRAGEN-NACHT.md`:

> (b) – feste Liste bleibt englisch, alles andere deutsch. Uneinheitlichkeiten auf je ein Wort
> bringen (immer «Audit-Log», «Umgebungsvariablen», «Rollback» im Text / «Zurückrollen» als
> Knopf, «Tailnet» in der Oberfläche). Umbenennen als eigene Etappe.

Die Umbenennung ist erledigt (Branch `ui-antwort-sprache`). Sie betrifft nur sichtbare Texte:
Oberfläche (`packages/web/src`), Texte, die die API an die Oberfläche liefert (Fehlermeldungen,
Fortschritt, Fehlererklärungen in `packages/shared/src`) und die MCP-Beschreibungen. Code-Bezeichner,
Routen, Anker (`#set-umgebung`), API-Felder und Datenbank bleiben, wie sie sind.

## Verbindliche Liste (b)

Diese Wörter bleiben englisch: **Deploy, Deployment, deployen, Rollback, Security, Scan, Score,
Header, Report-Only, Healthcheck, Container, Image, Compose, Dockerfile, Repo, Commit,
Pull Request, Merge, Log/Logs, Audit-Log, Token, Auto-Deploy, Upload, Tunnel**; dazu die Eigennamen
(Cloudflare, Cloudflare Access, GitHub, Caddy, Trivy, ZAP, Nuclei, Let’s Encrypt, Tailscale,
Claude, MCP) und Header-Namen, wie sie die Browser-Werkzeuge zeigen (CSP, HSTS,
Referrer-Policy …). Alles, was nicht auf der Liste steht, ist deutsch. Neue englische Wörter
kommen nur nach Entscheid dazu.

## Uneinheitlichkeiten

| Gleiche Sache | Vorher | Jetzt | Stand |
|---|---|---|---|
| was mitgeschrieben wird | «Audit» (Seitenleiste, Seitentitel, Brotkrumen), «Audit-Log» | immer **«Audit-Log»** (Seitenleiste, Titel, Brotkrumen, Befehlspalette, Kürzel-Hilfe, Glocke); «Aktivität» bleibt für die Zeitleiste eines Projekts | erledigt |
| Umgebungsvariablen | «Umgebung» (Abschnitt der Projekteinstellungen, Eckdaten), «Variablen», «Variable X fehlt», «Projekt-Env» | immer **«Umgebungsvariablen»** (Abschnitt, Knöpfe «Umgebungsvariable hinzufügen» / «Umgebungsvariablen speichern», Eckdaten, Fehlerbox «Umgebungsvariable X fehlt», Fehlermeldungen der API, MCP); Zahlen darunter als «3 gesetzt» | erledigt |
| frühere Fassung zurück | Knopf «Zurückrollen», «Rollback» und «zurückrollen» in Sätzen | **«Rollback»** im Text, **«Zurückrollen»** auf dem Knopf (Hinweis nennt den Knopf «Zurückrollen» in Guillemets) | erledigt |
| Tailscale | «Tailnet» (Adressen, Schalter), «Tailscale», «Tailscale-IP», «Tailscale-Adresse» (Hinweise) | **«Tailnet»**, «Tailnet-IP», «Tailnet-Adresse», wo das Netz gemeint ist; «Tailscale» nur für das Programm («Tailscale auf dem Server einrichten», Subnet-Router) | erledigt |
| ein Deploy auslösen | «Neu deployen», «Erneut deployen», «Anlegen und deployen», Status «deployt» | unverändert (verschiedene Aktionen, alle mit «deployen» von der Liste) | offen, nicht Teil dieser Etappe |
| Ausgabe des Containers | «Logs» (Reiter), «Container-Ausgabe», «Container-Log» | unverändert | offen, nicht Teil dieser Etappe |
| öffentlich weg | «Offline nehmen», «Pausieren», «Ganz offline nehmen», «Nicht mehr öffentlich» | unverändert (verschiedene Zustände) | offen, nicht Teil dieser Etappe |
| Zugangsschlüssel | «Tokens», «Token», «API-Token» | unverändert (alle mit «Token» von der Liste) | offen, nicht Teil dieser Etappe |

Bewusst so gelassen:

- **«Umgebung»** im Sinn von Meilenstein 9 (Arbeitsbereich wie jherren.com: Umschalter, «Umgebung
  anlegen», «Einstellungen der Umgebung») bleibt «Umgebung». Nur wo die Variablen gemeint waren,
  heisst es jetzt «Umgebungsvariablen».
- **Partizipien** «zurückgerollt» (Status einer Fassung) und «Zurückgerollt» (Titel in Aktivität und
  Deployments) bleiben: Sie sind das Verb des Knopfs, wie «deployt» zu «deployen».
- **«Rollback»** bleibt in den MCP-Werkzeugnamen und in der Beschreibung `rollback` («Auf eine
  frühere Fassung zurückrollen») – dort ist es die Aktion, wie auf dem Knopf.
- **«Secret»** in Befundtiteln von Trivy («Secret im Code») und in den Texten für Claude: der
  Befundtitel ist gespeichert und wird zum Zuordnen des Lösungswegs gelesen.

## Englische Wörter ausserhalb der Liste

Übersetzt: «Redeploy» → «neuer Deploy» (Security-Header), «Login» → «Anmeldung» (Cloudflare
Access, wie schon «Anmeldungen zeigen» im Audit-Log), «Secrets» → «geheime Werte» bzw.
«Umgebungsvariablen» (GitHub App entfernen, Projekt verschieben), «Projekt-Env» →
«Umgebungsvariablen des Projekts» (API, MCP).

**Zur Entscheidung (noch englisch, nicht auf der Liste):** Branch, Build (Build-Befehl, Build-Log),
Diff, Fix/Fixes, Push (ntfy), Live («Live folgen»), Wildcard-Zertifikat, «nicht proxied»
(Cloudflare-Begriff), Secret (Befunde), Subnet-Router, Header-Check, Cipher. Für jedes: auf die
Liste nehmen oder übersetzen.

## Glossar mit zwei Varianten (Entscheidungsgrundlage)

Gilt: Spalte (b). Spalte (a) bleibt als Herleitung stehen.

- **(a) alles deutsch:** jedes Wort der Oberfläche deutsch; englisch nur Eigennamen (Cloudflare,
  GitHub, Caddy, Trivy, ZAP, Nuclei, Let’s Encrypt, Claude, MCP) und Header-Namen, die man so in
  den Browser-Werkzeugen sieht (CSP, HSTS).
- **(b) feste Liste bleibt englisch:** Fachwörter, die in Docker, Git, Browsern und bei Claude genau
  so heissen, bleiben englisch (Liste unten); alles andere deutsch.

| Vorher | (a) alles deutsch | (b) feste Liste englisch – gilt | Wo |
|---|---|---|---|
| Projekte | Projekte | Projekte | Navigation, Titel |
| Security | Sicherheit | Security | Navigation, Reiter |
| Domains | Domains *(oder Adressen)* | Domains | Navigation |
| Externe Ziele | Externe Ziele | Externe Ziele | Navigation |
| Tokens | Zugangsschlüssel | Tokens | Navigation, Konto |
| Audit, Audit-Log | Protokoll | Audit-Log | Navigation, Karten |
| Aktivität | Aktivität | Aktivität | Projektseite, Übersicht |
| System | System | System | Navigation |
| Deployments | Auslieferungen *(oder Versionen)* | Deployments | Reiter, Karte |
| Deploy / deployen | Ausliefern / ausliefern | Deploy / deployen | Knöpfe, Status, Toasts |
| Rollback, Zurückrollen | Zurückholen | Rollback (Knopf «Zurückrollen») | Deployments |
| Logs | Ausgabe | Logs | Reiter |
| Zugriffe | Aufrufe | Zugriffe | Reiter statischer Seiten |
| Healthcheck | Lebenszeichen *(oder Zustandsprüfung)* | Healthcheck | Übersicht, Einstellungen |
| Container | Container | Container | überall |
| Image | Abbild | Image | Quelle, Befunde |
| Compose, Dockerfile | Compose-Datei, Dockerfile | Compose, Dockerfile | Neues Projekt, Eckdaten |
| Repo, Commit, Pull Request, Merge | Repository, Stand, Änderungsvorschlag, Zusammenführen | Repo, Commit, Pull Request, Merge | GitHub, Auto-Deploy, Claude |
| Scan | Prüfung | Scan | Security |
| Befund | Befund | Befund | Security |
| Note, Score | Note, Punkte | Note, Score | Security |
| Stufen (Trivy, ZAP …) | Stufen | Stufen | Security |
| Header, Security-Header | Kopfzeilen, Sicherheits-Kopfzeilen | Header, Security-Header | Security, Einstellungen |
| Report-Only | nur melden | Report-Only | CSP |
| Veröffentlichung, Öffentlich | Veröffentlichung, Öffentlich | Veröffentlichung, Öffentlich | Einstellungen, Pillen |
| Offline nehmen, Pausieren | Offline nehmen, Pausieren | Offline nehmen, Pausieren | Veröffentlichung |
| Pause-Seite | Pausenseite | Pause-Seite | System, Dialog |
| Cloudflare Access | Cloudflare Access | Cloudflare Access | Veröffentlichung |
| Tunnel | Tunnel | Tunnel | System |
| Zertifikat, HTTPS | Zertifikat, HTTPS | Zertifikat, HTTPS | System |
| Tailnet / Tailscale | Tailnet | Tailnet | Erreichbarkeit |
| Heimnetz (LAN) | Heimnetz | Heimnetz (LAN) | Erreichbarkeit |
| Zone | Zone | Zone | Domains |
| Umgebung, Variablen | Umgebungsvariablen | Umgebungsvariablen | Einstellungen |
| Auto-Deploy | automatisch ausliefern | Auto-Deploy | Einstellungen |
| Ablauf, Behalten | Ablauf, Behalten | Ablauf, Behalten | Chat-Projekte |
| Gefahrenzone | Gefahrenzone | Gefahrenzone | Einstellungen |
| Eckdaten | Eckdaten | Eckdaten | Übersicht |
| Slug, Kurzname | Kurzname | Kurzname | Neues Projekt, Löschen |
| Upload | Hochladen | Upload | Neues Projekt |
| Per Chat (MCP) | Per Chat (MCP) | Per Chat (MCP) | Neues Projekt, Tokens |
| Vorgänge | Vorgänge | Vorgänge | Kopf (Aktivitätsanzeige) |

Die feste Liste steht oben unter «Verbindliche Liste (b)».

## Begründung für (b) (Empfehlung, so entschieden)

Begründung:

1. **Gleiche Wörter wie die Werkzeuge daneben.** Wer Airlock bedient, liest dieselben Begriffe in
   Docker, GitHub, in Fehlermeldungen der Container und im Chat mit Claude («deploy», «rollback»,
   «image»). Ein deutsches Ersatzwort («ausliefern», «Abbild») muss man im Kopf zurückübersetzen.
2. **Die MCP-Werkzeuge heissen schon so** (`deploy`, `rollback`, `get_logs`, `run_scan`); Oberfläche
   und Chat sprechen dann dieselbe Sprache.
3. **Deutsche Ersatzwörter sind mehrdeutig:** «Protokoll» (Audit-Log oder Container-Log?),
   «Prüfung» (Scan oder Healthcheck?), «Version» (Deployment oder Programmversion?).
4. **Der Rest bleibt deutsch und klar:** Navigation, Sätze, Zustände, Knöpfe als deutsche Verben
   («Neu deployen» ist ein deutsches Verb aus einem englischen Stamm).

Was (b) trotzdem verlangt: Die Liste ist abschliessend. Neue englische Wörter kommen nur nach
Entscheid dazu; alles andere wird deutsch. Die Uneinheitlichkeiten oben sind auf **ein** Wort
gebracht (immer «Audit-Log», immer «Umgebungsvariablen», «Rollback» im Text und «Zurückrollen»
als Knopf, «Tailnet» in der Oberfläche).

## Text-Leitfaden

**Knöpfe**
- Ein Verb, das sagt, was passiert: «Neu deployen», «Token anlegen», «Offline nehmen». Kein
  «OK», «Weiter», «Ja» allein. Bestätigungen wiederholen die Aktion: «Ja, löschen».
- **Keine «…» auf Knöpfen.** Drei Punkte nur in Menüeinträgen, die eine Rückfrage öffnen
  («Löschen …»), und im Platzhalter von Suchfeldern.
- Während der Aktion bleibt der Text stehen (Ladering, Etappe 2) – kein «Wird gespeichert…».

**Fehlermeldungen**
- Sagen, was nicht ging, warum, und was zu tun ist: «Port zwischen 1 und 65535 angeben,
  z. B. 8080.» statt «Ungültiger Wert».
- Titel nennt die Aktion («Header nicht gesetzt»), Text den Grund in einem Satz, dazu eine
  Aktion, wenn es eine gibt («Erneut versuchen», «Log ansehen»).
- Keine Schuld beim Menschen («Du hast …»), keine Codes ohne Erklärung.

**Ansprache**
- Du-Form, freundlich und knapp: «Lege eins an», «Prüfe, ob er angekommen ist».
- Schweizer Rechtschreibung: «ss» statt «ß», Guillemets «…» für Namen und Zitate.

**Zahlen, Zeiten, Daten (Schweizer Format)**
- Tausender mit Apostroph: 1’024 MB (de-CH), Dezimalkomma bei Werten mit Einheit in Sätzen.
- Datum 11.11.2026, Uhrzeit 14:05 (24 h), zusammen «11.11.2026, 14:05».
- Relative Zeit für Jüngeres: «gerade eben», «vor 3 Min.», «vor 2 Std.», «gestern», «vor 4 Tagen»;
  ab 30 Tagen das Datum. Der genaue Zeitpunkt steht im Tooltip.
- Dauer: «41 s», «5 Min. 4 s» bzw. «2 Std. 10 Min.».
- Alles über `lib/dates.ts` und `lib/format.ts`, nie eigene Formatierung.

**Zustände**
- Nie nur Farbe: Punkt oder Zeichen **und** Wort («läuft», «fehlgeschlagen», «kritisch»).
- Leerzustände nennen den nächsten Schritt («Projekt anlegen», «Suche leeren»).

## Farbregel (UI-Qualität 7)

Farbe trägt Bedeutung, nie allein: immer zusammen mit einem Wort oder einer Zahl mit Wort.

| Farbe | Bedeutung | Wo |
|---|---|---|
| Rot (`--bad`) | etwas ist kaputt oder gefährlich | Deploy gescheitert, nichts läuft, kritische und hohe Befunde, Fehlermeldungen, Löschen |
| Gelb (`--warn`) | Aufmerksamkeit, aber nichts kaputt | mittlere Befunde, Warnungen im Log, bald ablaufend, pausiert |
| Grün (`--ok`) | in Ordnung | läuft, gesund, erreichbar, keine offenen Befunde |
| Blau (`--info`) | läuft gerade / Hinweis | deployt gerade, Scan läuft, Hinweise; Note B (gut, nicht sehr gut) |
| Grau (`--ink-dim`, `--muted`) | neutral | niedrige Befunde, übersprungen, gestoppt, nicht deployt |

**Schweregrade** haben je eine eigene Form, nicht nur eine eigene Farbe – die Reihenfolge ist
auch ohne Farbe lesbar:

| Stufe | Darstellung |
|---|---|
| kritisch | gefüllt rot, Schrift in der Grundfarbe, fett; Zeichen: Quadrat gefüllt, Kennzahl: Punkt gefüllt |
| hoch | rot getönt, rote Schrift; Zeichen: Quadrat mit Rand, Kennzahl: Ring |
| mittel | gelb getönt, gelbe Schrift; Zeichen: Kreis gefüllt |
| niedrig | neutral grau mit feinem Rand; Zeichen: Kreis leer |

Zähler (Seitenleiste, Reiter) nehmen die Form der schwersten offenen Stufe an: gefüllt bei
kritisch, rot getönt bei hoch, gelb getönt bei mittel.

Immer mit dem Wort («kritisch», «hoch», «mittel», «niedrig»). Die Bausteine zeigt `/design`.

**Schriftgrössen** kommen nur aus der Skala (`--fs-12` … `--fs-44`); nichts unter 12 px.
