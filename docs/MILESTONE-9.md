# Meilenstein 9 – Umgebungen

Stand: 10. November 2026

Umfang laut [SPEC.md](SPEC.md), Abschnitt «Umgebungen». Alle offenen Entscheidungen 1–14 gelten wie dort empfohlen. Gebaut in fünf Etappen auf dem Branch `milestone-9` (abgezweigt von `main` @ `62b5eac`, mit dem Konzept vom Branch `umgebungen`), ein Commit pro Etappe. Nicht gepusht.

**Nicht im Umfang:** die Adresse der Oberfläche. Sie bleibt `deployer.int.jherren.com` (`UI_HOST_LABEL`); der Umzug auf `airlock.int…` kommt separat.

**Parallel auf `main`:** Das Zusammenführen von `csp-fix` belegt Migration `0014_csp_checks.sql`. M9 nimmt deshalb **`0015_environments.sql`**. Beim Zusammenführen sind Konflikte in `db/schema.ts`, `drivers/caddy-config.ts`, `security/header-service.ts` und `http/routes/fix.ts` zu erwarten.

## 1. Grundsätze

- **Nach aussen ändert sich für die heutige Installation nichts.** Gleiche Adressen, gleiches Zertifikat ohne neuen ACME-Auftrag, gleicher Tunnel und Container, MCP-Tokens gelten weiter.
- **Eine Umgebung ist nie implizit.** Jede Abfrage auf Projekte, Domains, externe Ziele, Tokens und Audit braucht einen Scope. Ohne Scope geht es nur über ausdrücklich benannte Server-Funktionen (`…ForServerJob`).
- **Nicht gefunden statt verboten.** Ein Objekt einer fremden Umgebung verhält sich wie ein unbekanntes: gleiche Meldung, gleicher Status (404), gleiche Laufzeit-Reihenfolge der Prüfungen.
- **Fehler bleiben in ihrer Umgebung.** Ein Zertifikats-, DNS- oder Tunnelproblem in einer Umgebung blockiert keine andere: eigene TLS-Phase, eigene Token-Datei, eigene Automatisierungsregel in Caddy, eigener Rate-Limit-Schutz.

## 2. Befund vorab: Tunnel und Konten

Frage aus Etappe 3: Geht ein proxied CNAME auf `<tunnel>.cfargotunnel.com` aus einer Zone eines **anderen** Cloudflare-Kontos?

**Nein.** Die Cloudflare-Dokumentation zu Tunnel-DNS-Einträgen sagt ausdrücklich, dass `cfargotunnel.com` nur Verkehr für DNS-Einträge im selben Konto weiterleitet; ein Eintrag in einem anderen Konto endet mit Fehler 1014 («CNAME Cross-User Banned»). Quellen: [Cloudflare Tunnel – DNS records](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/), [Error 1014](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1014). Das bestätigt Entscheidung 1: **ein Tunnel pro Cloudflare-Konto**, Umgebungen im selben Konto teilen ihn.

## 3. Architektur

### Laufzeit-Register

Heute hält `config.ts` genau einen Satz Cloudflare-Werte (`cf.*`: Token, Basisdomain, TLS, Konto, Tunnel). Neu:

- `domain/environments.ts` lädt alle Umgebungen mit Konto und Tunnel und hält sie als **Register im Speicher** (`envRuntime(envId)`: Slug, Name, Kürzel, Hauptzone, interne Basis, TLS an/aus, ACME-CA, E-Mails, Access-Standard, Token, Konto, Tunnel). Jede Änderung lädt das Register neu.
- `cf.*` bleibt als Sicht auf die **Standard-Umgebung** für das, was serverweit ist: Adresse der Oberfläche, nip.io, Rückfall auf die alten `.env`-Variablen.
- Adressen pro Umgebung: `hostSettingsFor(envId)`, `primaryHostIn(envId, label)`, `urlForHostIn(envId, host)`. Die reinen Funktionen in `lib/hostnames.ts` bleiben unverändert.
- Die Tailscale-IP ist serverweit (`app_settings.server_network`), nicht pro Umgebung.

### Datenmodell (Migration 0015)

| Tabelle | Felder |
| --- | --- |
| `cloudflare_accounts` | `id`, `cf_account_id`, `name`, `token_enc`, `token_saved_at`, `last_check` (jsonb), `created_at` |
| `tunnels` | `id`, `cloudflare_account_id` (eindeutig), `cf_tunnel_id`, `name`, `token_enc`, `cloudflared_image`, `container_name`, `created_at` |
| `environments` | `id`, `slug` (eindeutig), `name`, `short`, `is_default` (Teilindex: genau eine), `zone_name`, `internal_prefix` (Standard `int`), `cloudflare_account_id`, `tls_state` (jsonb, wie heute `cloudflare.tls`), `tunnel_skipped`, `tailnet_record_id`, `pause_page` (jsonb), `access_default`, `access_emails`, `acme_email`, `notify_muted`, `legacy_imported_at`, `created_at` |
| `header_rule_templates` | `id`, `environment_id`, `header`, `value`, `mode`; eindeutig je Umgebung und Header |
| `route_redirects` | `id`, `environment_id`, `from_host`, `to_host`, `until` – interne Weiterleitung nach dem Verschieben |

Dazu `environment_id` (Pflicht) an `projects`, `domains`, `external_targets`, `api_tokens`; nullable an `audit_events` (leer = Server-Ereignis). `header_rules.mode` kennt zusätzlich `off`. `domains.is_default` bleibt in der Tabelle (Rückfall), wird aber nicht mehr gelesen; die Hauptzone steht in `environments.zone_name`.

Die Migration legt **eine** Umgebung an (vorläufig `standard`) und ordnet ihr alle bestehenden Zeilen zu, damit die Spalten sofort `NOT NULL` sein können. Audit-Einträge mit Ziel `project`, `domain`, `token`, `external_target`, `dns` kommen in die Standard-Umgebung, alle übrigen bleiben Server-Ereignisse.

### Start-Schritt (TypeScript, einmalig, wiederholbar)

`importLegacySettings()` beim Start, bevor irgendetwas Adressen braucht:

1. Läuft nur, solange die Standard-Umgebung `legacy_imported_at` leer hat; jeder Teilschritt prüft, ob sein Ziel schon gefüllt ist (wiederholbar nach Abbruch).
2. `app_settings.cloudflare` → Token und Konto in `cloudflare_accounts`, Tunnel in `tunnels` (Container-Name `airlock-cloudflared`, wie heute), Basis `int.jherren.com` → Hauptzone `jherren.com` + Präfix `int`, TLS-Zustand samt `prodCert`/`prodAttemptAt`, Access- und ACME-E-Mail, `tunnelSkipped`. Die Tailscale-IP geht nach `app_settings.server_network`.
3. `app_settings.pause_page` → `environments.pause_page`.
4. Name, Slug und Kürzel aus der Hauptzone: `jherren.com` → Name «jherren.com», Slug `jherren`, Kürzel «JH». Ohne Hauptzone bleibt «Standard».
5. `app_settings.cloudflare` und `pause_page` **bleiben stehen** (Rückfall für eine Version); ein Hinweis im Log nennt sie.

Die verschlüsselten Werte werden nur umkopiert, nicht neu verschlüsselt (gleicher Schlüssel).

### Caddy

- `buildCaddyConfig` bekommt statt einer `tls`-Option eine **Liste** (eine pro Umgebung mit TLS). Server `srv1` (:443) bedient die Namen aller Basen; `apps.tls.automation.policies` hat **eine Regel pro Basis**, jede mit ihrer CA und ihrer Token-Datei.
- Token-Dateien: `cloudflare_token` für das Konto der Standard-Umgebung (unverändert), `cloudflare_token_<konto-id>` für weitere Konten.
- `needsCacheEvict` und das Leeren des Zertifikats-Caches pro Basis.
- Die Zertifikats-Einrichtung (`runTls`, Probelauf, Rate-Limit-Schutz aus `lib/tls-plan.ts`) läuft **pro Umgebung** mit eigenem Lauf, eigenen Schritten, eigener Sperre.
- Weiterleitungen nach dem Verschieben: eigene Routen mit 308 auf den neuen Namen, gleicher IP-Filter, bis `until`.

### Tunnel

Ein Tunnel und ein `cloudflared`-Container pro Konto. Der Tunnel des Kontos der Standard-Umgebung behält den Container `airlock-cloudflared`; weitere heissen `airlock-cloudflared-<kurz-id>`, alle im Netz `airlock_tunnel`, das nur Caddy erreicht. Der Ingress-Abgleich eines Tunnels sammelt die öffentlichen Namen aller Umgebungen dieses Kontos.

### Durchsetzung

- `Scope` = `{ kind: 'env', envId }` (API-Token, Listen in einer Umgebung) oder `{ kind: 'session' }` (Anmeldung: Einzelobjekte aller Umgebungen). Erzeugt nur über `inEnvironment(envId)` und `sessionScope()`.
- Alle Service-Funktionen auf Projekten, Domains, externen Zielen, Tokens und Audit nehmen einen Scope als ersten Parameter. Funktionen ohne Scope heissen `…ForServerJob` (wöchentlicher Rescan, Ablauf, Caddy-Abgleich, Monitor).
- REST: `request.scope` setzt der Auth-Guard (Token → seine Umgebung, Session → `session`). MCP: Scope aus dem Token.
- Eine fremde Umgebung ergibt `notFound` mit derselben Meldung wie ein unbekanntes Objekt.

### Oberfläche

- Pfade `/u/<umgebung>/…`; alte Pfade leiten in die zuletzt gewählte, sonst die Standard-Umgebung. Die letzte Wahl steht in `ui_prefs.lastEnvironment`.
- Umschalter neben «Airlock»: Kürzel und Pfeil; die Liste zeigt Name, Domain, Projekte, kritische Befunde (Zahl mit Wort). Kein zusätzlicher Kopfblock in der Seitenleiste; der Name der Umgebung steht im Pfad oben.
- Seitenleiste: Umgebungs-Einträge, Trenner «Server · für alle Umgebungen», darunter «Server».
- Neue Seiten: «Umgebung anlegen» (Assistent, 7 Schritte), «Umgebungen verwalten», Einstellungen der Umgebung (Allgemein, Cloudflare & HTTPS, Standards), Karte «In andere Umgebung verschieben» im Projekt.

## 4. Etappen

| Etappe | Inhalt | Abnahme |
| --- | --- | --- |
| 1 Datenmodell und Migration | Migration 0015, Schema, Start-Schritt, Register | Test gegen ein Wegwerf-Postgres im Zustand von heute (Dump mit Cloudflare-Einstellungen, Projekten, Tokens): danach eine Umgebung «jherren.com»/`jherren`/«JH», gleiche Hostnamen aller Routen, gleiche TLS-Optionen für Caddy (Subject `*.int.jherren.com`, CA Produktion, keine Probe), gleicher Tunnel und Container-Name, Tokens weiter gültig; zweiter Start ändert nichts |
| 2 Durchsetzung | Scope in der Service-Schicht, REST und MCP | Tests mit zwei Umgebungen: Projekt aus A über Token aus B weder lesbar noch änderbar, für **jedes** MCP-Tool mit Projekt-Parameter und jeden REST-Endpunkt unter `/projects/:id`, `/deployments/:id`, `/external-targets/:id`, `/tokens`, `/audit`; Antwort identisch zu einem unbekannten Projekt |
| 3 Caddy, Zertifikate, DNS, Tunnel | TLS-Liste, Einrichtung pro Umgebung, Tailnet pro Hauptzone, Tunnel pro Konto, Weiterleitungen | Echtes Caddy im Wegwerf-Container mit zwei Basen und Pebble bzw. Attrappe: Fehler (falsches Token) in Basis B lässt Basis A mit gültigem Zertifikat weiterlaufen; Tailnet-Eintrag in beiden Zonen nach IP-Wechsel |
| 4 Oberfläche | Umschalter, Pfade, Assistent, Verwalten, Einstellungen, Verschieben, Tokens/Audit pro Umgebung | Typecheck, Tests, Build; Screenshots hell und dunkel in `docs/design-cal/m9-etappe4/`; Impeccable (detect + Durchsicht) |
| 5 MCP und REST | MCP-Anweisungen mit Umgebung, REST laut SPEC, Abnahme | Abnahmetest mit zwei Umgebungen (zweite mit Cloudflare-Attrappe), dokumentiert unten |

Jede Etappe: `pnpm typecheck`, `pnpm test`, `pnpm build`, Screenshots hell/dunkel (wo sich die Oberfläche ändert), Impeccable als Gutachter.

## 5. Ergebnisse

### Etappe 1 – Datenmodell und Migration

- Migration `0015_environments.sql`, Schema in `db/schema.ts`, Register und Übernahme in `domain/environments.ts`.
- `domain/cloudflare-settings.ts` liest und schreibt nicht mehr `app_settings.cloudflare`, sondern Umgebung, Konto und Tunnel (`load`/`persist`); die Arbeitsform `Stored` und der übrige Ablauf (Token, Tunnel, Zertifikat) sind unverändert und gelten vorerst für die Standard-Umgebung. Die Tailscale-IP liegt serverweit in `app_settings.server_network`.
- Pause-Seiten-Vorlage aus `environments.pause_page` (Rückfall: alter Eintrag).
- Audit-Einträge bekommen die Umgebung aus ihrem Ziel (Projekt, Token, Domain, externes Ziel); ohne Ziel bleiben sie Server-Ereignisse.
- Neue Projekte, Tokens, externe Ziele und gespiegelte Zonen landen vorläufig in der Standard-Umgebung (Etappe 2: aus dem Scope).

**Geprüft** (Stand 10.11.2026): Typecheck, 603 Unit-Tests (4 neu: Basis zerlegen, Namen aus der Zone), Build. Dazu `scripts/m9-migration-e2e.ts` gegen ein Wegwerf-Postgres mit einer Datenbank im Zustand vor M9 (Cloudflare-Einstellungen mit verschlüsseltem Token, Tunnel, produktivem Zertifikat, Projekten mit internen und öffentlichen Routen, MCP-Token, Audit): **25 von 25 Prüfungen** – eine Umgebung «jherren.com»/`jherren`/«JH», gleiche Hostnamen aller Routen, gleiche TLS-Optionen für Caddy (`*.int.jherren.com`, Produktion, Wildcard, Phase «done» → keine neue Bestellung), gleiche Token-Datei, gleicher Tunnel und Container `airlock-cloudflared`, MCP-Token gültig, Audit richtig zugeordnet, alte Einträge bleiben stehen; zweiter Start und abgebrochene Übernahme ändern nichts; Laden → Speichern → Laden verlustfrei.

**Nicht geprüft:** gegen den laufenden Stack (läuft von `main`). Keine Oberfläche geändert, daher keine Screenshots und kein Impeccable-Durchgang in dieser Etappe.

### Etappe 2 – Durchsetzung

- `lib/scope.ts`: `Scope` = `env` (Token, Liste) | `session` (Anmeldung) | `server` (benannter Job). Erzeugt nur über `inEnvironment()`, `sessionScope()`, `serverJob('<name>')`. Listen nehmen nur `env` oder `server` (Typ `ListScope`) – eine Anmeldung muss für eine Liste eine Umgebung wählen.
- Service-Schicht mit Pflicht-Scope als erstem Parameter: `findProject`, `listProjects`, `createProject`, `deleteProject`, Deploy/Rollback/Neu erstellen, Start/Stop, Dateien (lesen, ändern, exportieren, pushen), Header-Regeln, Scan starten, Fix-Hinweis/-Kontext/-Vorschlag/-Liste/übernehmen/verwerfen, externe Ziele (finden, anlegen, prüfen, ändern, löschen), Tokens (anlegen, auflisten, widerrufen), Domains (auflisten, Standard), Audit.
- Ohne Umgebung nur benannt: `findProjectForServerJob` (Deploy-Ablauf, Scan-Ablauf) und `serverJob('auto-deploy' | 'ablauf' | 'wöchentlicher-rescan' | 'scan-nach-deploy' | 'fix-assistent' | 'nachweis-vor-scan' | 'cloudflare-aufräumen')`.
- REST: Der Auth-Guard setzt `request.scope`; `http/scope.ts` prüft **zentral** jeden Pfad mit Objekt (`/projects/:id…`, `/deployments/:id…`, `/scans/:id…`, `/findings/:id`, `/external-targets/:id…`, `/tokens/:id`, `/environments/:env…`) vor dem Handler. Listen und Anlegen unter `/environments/:env/…` oder mit `?environment=`; ohne Angabe die Standard-Umgebung, ein Token immer seine. `/system/hosts` nur noch mit Anmeldung (nennt Namen aller Umgebungen).
- MCP: Scope aus dem Token für jedes Werkzeug; MCP-Aufrufe stehen im Audit der Umgebung des Tokens.
- Audit-Liste: Einträge der Umgebung plus Server-Ereignisse (`server: true`), nie Einträge anderer Umgebungen.

**Bewusste Grenze (Etappe 2):** Slugs und Hostnamen externer Ziele sind serverweit eindeutig (Entscheidung 3). Wer in B einen Slug oder Hostnamen anlegen will, den A schon nutzt, bekommt «schon vergeben» – das verrät nur, dass der Name belegt ist, keinen Inhalt.

**Geprüft** (Stand 10.11.2026): Typecheck, 607 Unit-Tests (4 neu: Scope), Build. `scripts/m9-scope-e2e.ts` gegen ein Wegwerf-Postgres mit zwei Umgebungen: **21 von 21 Prüfungen** – alle 64 REST-Pfade mit Objekt (aus der Liste der registrierten Routen, nicht von Hand) antworten dem Token aus B für Objekte aus A byte-gleich wie für ein unbekanntes Objekt; jeder Pfad mit Objekt fällt unter die zentrale Prüfung; alle 22 MCP-Werkzeuge mit Projekt oder Hostname (aus `tools/list`) ebenso; Listen (Projekte, externe Ziele, Domains, Audit, `list_projects`) zeigen nur B; nichts in A verändert; MCP-Audit in B. Migrationstest weiter 25 von 25.

### Etappe 3 – Caddy, Zertifikate, DNS, Tunnel

- **Cloudflare-Einstellungen pro Umgebung** (`domain/cloudflare-settings.ts`): ein Stand je Umgebung; `withCloudflareEnv(envId, fn)` bestimmt die Umgebung über `AsyncLocalStorage`, auch für die minutenlange Zertifikats-Einrichtung im Hintergrund. Ohne Angabe die Standard-Umgebung – die bisherigen Endpunkte unter `/system/cloudflare` arbeiten unverändert für sie. Einrichtung, Sperre und Rate-Limit-Schutz je Umgebung (`tlsRuns`), Audit in der Umgebung.
- **Caddy** (`drivers/caddy-config.ts`): `tls` ist eine Liste; je Basis eine Automatisierungsregel mit eigener CA und eigener Token-Datei, eigene http→https-Weiterleitung, HSTS je Basis. Cache leeren je Basis. Neue Route-Art `redirect` (308) für die Weiterleitung nach dem Verschieben (`route_redirects`).
- **Token-Dateien:** `cloudflare_token` für das Konto der Standard-Umgebung (wie vorher), `cloudflare_token_<konto-id>` für weitere; nicht mehr gebrauchte werden entfernt.
- **Adressen:** `hostSettingsFor(envId)`, `primaryHostIn`, `aliasHostsIn`, `urlForHostIn`; Routen, Aliase, URLs, Pause-Vorlage und Probe-Adresse nach der Umgebung des Projekts. `rehostRoutes(envId)` nur für die geänderte Umgebung.
- **Tailnet:** ein Eintrag `*.int.<hauptzone>` je Umgebung mit ihrem Token; bei einem Wechsel der Tailscale-IP werden alle nachgezogen (`domain/network.ts`).
- **Tunnel:** einer pro Konto (Befund in Abschnitt 2). Ingress eines Tunnels aus den öffentlichen Namen aller Umgebungen dieses Kontos; CNAME, Access-Apps und DNS mit Token und Konto der Projekt-Umgebung; Zustand je Tunnel; cloudflared-Container `airlock-cloudflared` für das Konto der Standard-Umgebung, sonst `airlock-cloudflared-<kurz-id>`. Trennen einer Umgebung mit geteiltem Konto lässt Tunnel und Token stehen.
- **Zonen:** gespiegelt in die Umgebung, deren Token abgeglichen wird; aufgeräumt nur unter Umgebungen desselben Kontos. Eine Zone desselben Kontos wechselt beim Wählen als Hauptzone in die Umgebung (`claimZone`), ausser sie ist anderswo Hauptzone oder öffentlich benutzt.
- Eine noch unbenannte Standard-Umgebung (frische Installation) bekommt beim Wählen der Hauptzone Name, Slug und Kürzel daraus – wie bei der Übernahme.

**Befund unterwegs – ein Token kann alle Umgebungen lahmlegen.** `caddy-dns/cloudflare` prüft das Format des Tokens beim Laden; lehnt es ein Token ab («API token … appears invalid»), lädt Caddy die **ganze** Konfiguration nicht – auch die Zertifikate aller anderen Basen (im Test gegen echtes Caddy nachgestellt). Airlock prüfte beim Speichern bisher nur «30–200 Zeichen» und hätte z. B. ein 31-Zeichen-Token angenommen. Jetzt:
- `lib/cf-token-format.ts` prüft genau wie das Modul (altes Format 35–50 Zeichen, neues `cfut_`/`cfat_` mit 32–256);
- «Token speichern» lehnt alles andere ab;
- der Caddy-Abgleich lässt eine Basis mit unbrauchbarem Token weg (Warnung im Log), statt alle mitzureissen.

**Geprüft** (Stand 10.11.2026): Typecheck, 617 Unit-Tests (10 neu: Caddy mit zwei Basen, Token-Format), Build.
- `scripts/m9-caddy-two-bases-e2e.ts` gegen **echtes Caddy** (Image aus `caddy/Dockerfile`): **13 von 13** – Gegenprobe: ein abgelehntes Token in B verhindert das Laden ganz, mit dem Filter von Airlock lädt Caddy und liefert A aus; B mit falschem Token (gültiges Format) scheitert beim Bezug laut Log, A liefert dabei, nach erneutem Laden, während eines Probelaufs von B und ohne Regel für B weiter das eigene produktive Zertifikat; mit Zertifikat für B laufen beide. B nutzt die Staging-CA, damit der fehlschlagende Bezug keinen Auftrag bei der Produktions-CA erzeugt.
- `scripts/m9-cloudflare-e2e.ts` gegen zwei Cloudflare-Attrappen (zwei Konten) und ein Wegwerf-Postgres: **19 von 19** – Zonen je Umgebung, Tailnet-Eintrag in jeder Hauptzone und nach IP-Wechsel überall nachgezogen, ein Tunnel je Konto (A und C teilen, B eigener), Container-Namen, Ingress je Tunnel nur mit den Namen seines Kontos, CNAME von B in der Zone von B auf den Tunnel von B, Offline in B ohne Wirkung auf Konto 1, Trennen von C ohne Wirkung auf A, Token-Dateien und TLS-Optionen je Konto bzw. Basis.
- Die bestehenden Prüfungen gegen echtes Caddy (`caddy-tls-e2e.ts`, `caddy-headers-e2e.ts`) bestehen weiter; Migrationstest 25/25, Scope-Test 21/21.

**Nicht geprüft:** echter Bezug bei Let's Encrypt (kein Netz zur Produktions-CA im Test), echte cloudflared-Container (kein Docker-Socket im Test), Cloudflare selbst.

### Etappe 4 – Oberfläche

- **Adressen:** alles einer Umgebung unter `/u/<slug>/…` (Projekte, Security, Domains, Externe Ziele, Tokens, Audit, Einstellungen, Einrichtung). Alte Adressen (`/projekte…`, `/security`, `/tokens`, …) führen in die zuletzt gewählte, sonst die Standard-Umgebung; `/system` → `/server`, `/system/cloudflare` → Einstellungen → Cloudflare & HTTPS, `/system/veroeffentlichung` → Einstellungen → Standards. Die letzte Wahl steht in `ui_prefs.lastEnvironment` (ohne Audit-Eintrag je Wechsel).
- **Umschalter** (`components/EnvSwitcher.tsx`) neben «Airlock»: Kürzel und Pfeil; Liste mit Name, Domain, Projekten und kritischen Befunden (Zahl mit Wort), «Umgebung anlegen …», «Umgebungen verwalten». Wechsel führt auf dieselbe Seite der anderen Umgebung (Projektseiten: zur Liste). Kein Kopfblock in der Seitenleiste; der Name der Umgebung steht als erste Brotkrume.
- **Seitenleiste:** Einträge der Umgebung, Trenner «Server · für alle Umgebungen», darunter «Server» (Übersicht, Benachrichtigungen, GitHub – die bisherige System-Seite ohne Cloudflare und Pause-Vorlage).
- **Daten je Umgebung:** `lib/env.tsx` stellt die API vor dem Rendern auf die Umgebung ein und entfernt beim Wechsel alle Abfragen ausser Konto, Umgebungen und Server – keine Seite zeigt kurz Daten der vorigen Umgebung.
- **Einstellungen der Umgebung** (`pages/EnvironmentSettings.tsx`): Allgemein (Name, Kürzel, stumm schalten, zur Standard-Umgebung machen mit Rückfrage, löschen nur leerer Umgebungen mit Begründung), Cloudflare & HTTPS (Hauptzone, interne Basis, Adresse; der bestehende Assistent je Umgebung; Tailnet und lokaler DNS mit Prüfung und kopierbarer Zeile), Standards (Header-Vorlagen mit «gilt für x von y Projekten», Access-Standard, Pause-Seite).
- **Umgebungen verwalten** (`pages/Environments.tsx`) und **Assistent** (`pages/NewEnvironment.tsx`) in den sieben Schritten der SPEC; Schritte 2–6 nutzen die Bausteine von «Cloudflare verbinden» (exportiert, unverändert), Schritt 2 kann das Token einer anderen Umgebung mitbenutzen, Schritt 7 übernimmt Standards.
- **Projekt verschieben** (`components/MoveProject.tsx`): Ziel wählen → Folgen laut SPEC-Tabelle (interne Adresse mit 30 Tagen Weiterleitung, öffentliche Adresse entfernt, geerbte Header, Tokens ohne Zugriff, Daten bleiben) → Bestätigung im gewohnten Muster (rot gefüllter Knopf).
- **Tokens/Audit:** Hinweis, dass ein Token nur für seine Umgebung gilt; Server-Ereignisse im Audit mit Pille «Server».
- **Server:** `domain/environment-admin.ts` und `http/routes/environments.ts` (Liste, anlegen, ändern, löschen, Standards kopieren, Header-Vorlagen, Vorlage je Projekt abschalten, Verschieben mit Vorschau, LAN-DNS-Prüfung), Cloudflare-Schritte unter `/environments/:env/cloudflare/…`. Header-Vorlagen gelten live im Caddy-Abgleich; `header_rules.mode = 'off'` schaltet eine Vorlage für ein Projekt ab. Neue öffentliche Projekte übernehmen den Access-Standard der Umgebung. HSTS-Bereitschaft nach dem Zertifikat der Projekt-Umgebung.

**Behoben unterwegs:** Bei mitbenutztem Token lagen die Zonen des Kontos bei der Umgebung, die zuerst abgeglichen hatte – die neue Umgebung hätte keine Hauptzone wählen können. Der Cloudflare-Status bietet jetzt zusätzlich die freien Zonen desselben Kontos an (nicht die Hauptzonen anderer Umgebungen); beim Speichern wechselt die Zone in die Umgebung.

**Geprüft** (Stand 10.11.2026): Typecheck, 617 Unit-Tests, Build. Screenshots hell und dunkel (Desktop 1440) in `docs/design-cal/m9-etappe4/` (12 Ansichten: Projekte, Umschalter offen, Einstellungen Allgemein/Cloudflare/Standards, Umgebungen verwalten, Assistent Schritt 1 und Einrichtung, Verschieben mit Bestätigung, Audit mit Server-Pille, Server, Tokens). Kontrast (`contrast.mjs`) alle erfüllt, tote CSS-Klassen 0 von 517, Impeccable `detect` ohne Befund (nur Regex-Prüfung, weil die Seiten ohne laufende API nicht prüfbar sind; die Durchsicht der Screenshots fand die doppelte Überschrift «Pause-Seite» – behoben). `m9-scope-e2e.ts` mit jetzt **86** REST-Pfaden mit Objekt: 21 von 21; `m9-cloudflare-e2e.ts` 20 von 20 (neu: angebotene Zonen bei geteiltem Token). Der DOM-Prototyp `design-shots/umgebungen.ts` ist entfernt, die Konzeptbilder bleiben.

**Nicht geprüft:** die Oberfläche gegen den laufenden Stack (nur mit Fixtures); Impeccable-Elementregeln gegen eine laufende Seite.
