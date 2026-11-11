# Sprache und Texte der Oberfläche

**Status: Vorschlag.** Nichts davon ist umbenannt. Die Wahl zwischen (a) und (b) trifft Joël
(Frage Nr. 1 in `docs/FRAGEN-NACHT.md`); danach wird in einer eigenen Etappe umbenannt.

Grundlage: die Begriffe, wie sie heute in `packages/web/src` stehen (Navigation, Reiter,
Abschnitte, Knöpfe, Zustände; Stand Branch `ui-grundlagen`).

## Heute: gemischt und uneinheitlich

Die Oberfläche ist deutsch, mit englischen Fachwörtern dazwischen – ohne feste Regel:

- Navigation: *Projekte*, *Security*, *Domains*, *Externe Ziele*, *Tokens*, *Audit*, *System*.
- Reiter einer Projektseite: *Übersicht*, *Security*, *Deployments*, *Logs* (bei statischen Seiten
  *Zugriffe*), *Einstellungen*.
- Einstellungen: *Veröffentlichung*, *Erreichbarkeit*, *Umgebung*, *Security-Header*,
  *Auto-Deploy*, *Ablauf*, *Gefahrenzone*.
- System: *Übersicht*, *Cloudflare & HTTPS*, *Veröffentlichung*, *Benachrichtigungen*, *GitHub*.

Uneinheitlich sind u. a.:

| Gleiche Sache | Heute an verschiedenen Stellen |
|---|---|
| ein Deploy auslösen | «Neu deployen», «Erneut deployen», «Anlegen und deployen», Status «deployt» |
| frühere Fassung zurück | Knopf «Zurückrollen», Wort «Rollback» in Hinweisen und im Audit |
| was mitgeschrieben wird | «Audit», «Audit-Log», «Aktivität», «Letzte Aktivität» |
| Ausgabe des Containers | «Logs» (Reiter), «Container-Ausgabe», «Container-Log» |
| Umgebungsvariablen | «Umgebung», «Variablen», «Umgebungsvariablen» |
| Sicherheit | «Security» (Navigation, Reiter), «Security-Header», aber «Befund», «Note», «Stufen» |
| öffentlich weg | «Offline nehmen», «Pausieren», «Ganz offline nehmen», «Nicht mehr öffentlich» |
| Zugangsschlüssel | «Tokens» (Navigation), «Token» (Einzahl), «API-Token» in Texten |
| Tailscale | «Tailnet» (Adressen, Schalter), «Tailscale» (Hinweise) |

## Glossar mit zwei Varianten

- **(a) alles deutsch:** jedes Wort der Oberfläche deutsch; englisch nur Eigennamen (Cloudflare,
  GitHub, Caddy, Trivy, ZAP, Nuclei, Let’s Encrypt, Claude, MCP) und Header-Namen, die man so in
  den Browser-Werkzeugen sieht (CSP, HSTS).
- **(b) feste Liste bleibt englisch:** Fachwörter, die in Docker, Git, Browsern und bei Claude genau
  so heissen, bleiben englisch (Liste unten); alles andere deutsch.

| Heute | (a) alles deutsch | (b) feste Liste englisch | Wo |
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

**Feste Liste für (b):** Deploy, Deployment, deployen, Rollback, Security, Scan, Score, Header,
Report-Only, Healthcheck, Container, Image, Compose, Dockerfile, Repo, Commit, Pull Request, Merge,
Log/Logs, Audit-Log, Token, Auto-Deploy, Upload, Tunnel; dazu die Eigennamen.
Alles, was nicht auf der Liste steht, ist deutsch.

## Empfehlung: (b)

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
Entscheid dazu; alles andere wird deutsch. Die Uneinheitlichkeiten oben werden auf **ein** Wort
gebracht (z. B. immer «Audit-Log», immer «Umgebungsvariablen», immer «Rollback» im Text und
«Zurückrollen» als Knopf).

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
| Blau (`--info`) | läuft gerade / Hinweis | deployt gerade, Scan läuft, Hinweise |
| Grau (`--ink-dim`, `--muted`) | neutral | niedrige Befunde, übersprungen, gestoppt, nicht deployt |

**Schweregrade** haben je eine eigene Form, nicht nur eine eigene Farbe – die Reihenfolge ist
auch ohne Farbe lesbar:

| Stufe | Darstellung |
|---|---|
| kritisch | gefüllt rot, Schrift in der Grundfarbe, fett |
| hoch | rot getönt, rote Schrift |
| mittel | gelb getönt, gelbe Schrift |
| niedrig | neutral grau |

Immer mit dem Wort («kritisch», «hoch», «mittel», «niedrig»). Die Bausteine zeigt `/design`.

**Schriftgrössen** kommen nur aus der Skala (`--fs-12` … `--fs-44`); nichts unter 12 px.
