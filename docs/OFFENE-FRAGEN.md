# Offene Fragen und getroffene Annahmen

Während der Nacht vom 6. auf den 7. November 2026 gab es niemanden zum Fragen. Wo etwas unklar war, habe ich die vernünftigste Annahme getroffen und hier festgehalten. Jede Zeile lässt sich umentscheiden; der Verweis zeigt, wo die Annahme im Code oder Plan steckt.

Format: **Frage** – getroffene Annahme – *wo*.

## Allgemein

- **Meilenstein 7?** Die SPEC kennt nur sechs Meilensteine. Der Auftrag «M7 nicht» ist damit ohne Wirkung; nichts über M6 hinaus wurde gebaut. – *docs/SPEC.md, Meilensteine*
- **Installierte Skills einchecken?** Nein. `.agents/` und `.claude/skills/` (zusammen rund 77 MB) lassen sich aus `skills-lock.json` wiederherstellen und sind wie `node_modules` ignoriert. Eingecheckt sind `skills-lock.json` und `.claude/agents/`. – *.gitignore*
- **Git-Repository anlegen?** Der Ordner war kein Repository; für die verlangten Commits habe ich `git init` ausgeführt. Commits nur lokal, kein Remote, keine Co-Authored-By-Zeile (globale Regel). – *.git*
- **Arbeitsdateien.** Testdaten und Zwischenstände liegen in `.tmp/` im Projektordner (ignoriert), damit nichts ausserhalb des Ordners geschrieben wird. Ausnahmen, die sich nicht vermeiden lassen: Docker-Images, -Container, -Volumes und -Netze auf dem lokalen Docker sowie der pnpm-Paketspeicher. – *.tmp/*
- **Wechselnde IP des Servers.** In der Nacht hat der Mac per DHCP eine neue Adresse bekommen; die nip.io-Adressen änderten sich mit. Der deployer zieht beim Neustart nach (`SERVER_LAN_IP` anpassen), aber Links in Lesezeichen brechen. Annahme: Der Server bekommt eine feste IP oder eine DHCP-Reservierung. – *.env, SERVER_LAN_IP*

## Meilenstein 2

- **Private Repos?** Nicht in M2. Nur öffentliche Repos über `https://` (oder `http://` im LAN). Zugangsdaten in der URL werden abgelehnt, weil sie sonst in Logs und Datenbank landen. Für private Repos wäre ein Deploy-Key pro Projekt der saubere Weg. – *lib/repo-url.ts*
- **Weiterleitungen bei Git?** Werden nicht verfolgt (`http.followRedirects=false`): Die geprüfte Adresse wird für den Clone festgeschrieben, eine Weiterleitung auf einen anderen Host würde diese Prüfung umgehen. Folge: `http://` auf einen Server, der nach `https://` umleitet, scheitert – dann gleich die `https://`-URL angeben. – *lib/git.ts*
- **Symlinks im Repo?** Werden als einfache Textdatei ausgecheckt (`core.symlinks=false`). Sonst könnte ein Repo z.B. `env_file` auf `/proc/self/environ` zeigen lassen und die Umgebung des deployers in einen Container leiten. Repos, die Symlinks wirklich brauchen, funktionieren damit nicht. – *lib/git.ts, lib/repo-files.ts*
- **Compose ohne Ausfall?** Nein, an Ort und Stelle (`up -d`). Ein zweites Compose-Projekt neben dem alten würde benannte Volumes gleichzeitig benutzen – eine Datenbank liefe zweimal auf denselben Dateien. Geänderte Dienste starten kurz neu. Image-, Dockerfile- und statische Projekte schalten ohne Ausfall um. – *deploy/pipeline.ts, runCompose*
- **Bind-Mounts in Compose, auch relativ ins Repo?** Abgelehnt. Die CLI läuft im deployer-Container und gäbe dem Host-Daemon Pfade wie `/data/work/...`, die es auf dem Host nicht gibt – der Dienst bekäme einen leeren Ordner. Konfigurationsdateien gehören ins Image. – *lib/compose.ts*
- **`${VAR}` in einer compose.yaml?** Wird nicht ersetzt, `$` bleibt wörtlich. Compose nähme die Werte sonst aus der Umgebung des deployers (Datenbank-URL, Passwörter). Werte kommen über die Projekt-Env. Ebenso abgelehnt: `environment`-Einträge ohne Wert. – *lib/compose.ts, drivers/compose-cli.ts*
- **Grenzen bei Compose.** Jeder Dienst bekommt die Grenzen des Projekts (z.B. 512 MB), nicht einen Anteil davon. Drei Dienste können zusammen also das Dreifache belegen. Eigene `mem_limit`/`deploy`-Angaben werden abgelehnt. – *lib/compose.ts*
- **Volumes beim Löschen.** Benannte Volumes (z.B. einer Datenbank) bleiben beim Löschen erhalten, ausser der Haken «Auch die Daten-Volumes löschen» ist gesetzt. Ein neues Projekt mit demselben Slug fände die alten Daten wieder. – *domain/projects.ts*
- **Env bei statischen Builds.** Der Build-Container bekommt nur die nicht-geheimen Variablen: was dort hineingeht, kann in der ausgelieferten Seite landen. – *domain/env.ts, resolvePublicEnv*
- **Grenzen für Builds.** 2 GB Speicher, 2 CPUs, 10 Minuten – als Konstanten, nicht pro Projekt einstellbar. – *deploy/sources/dockerfile.ts*
- **Quellenart wechseln?** Nicht per PATCH: Compose-Dienste werden anders verwaltet als einzelne Container, beim Wechsel blieben Reste. Für eine andere Art ein neues Projekt anlegen. – *http/routes/projects.ts*
- **Rollback und Umgebungsvariablen.** Ein Rollback nimmt die heutigen Variablen, nicht die damaligen. Dafür liegen in den aufbewahrten Artefakten keine Secrets. – *deploy/sources/compose.ts*
- **Aufbewahrung.** Die letzten 5 erfolgreichen Fassungen (Rollback-Ziele) und die letzten 10 fehlgeschlagenen Versuche (wegen ihrer Logs). – *deploy/pipeline.ts, pruneOldDeployments*
