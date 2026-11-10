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
