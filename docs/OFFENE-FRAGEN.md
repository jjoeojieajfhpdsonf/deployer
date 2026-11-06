# Offene Fragen und getroffene Annahmen

Während der Nacht vom 6. auf den 7. November 2026 gab es niemanden zum Fragen. Wo etwas unklar war, habe ich die vernünftigste Annahme getroffen und hier festgehalten. Jede Zeile lässt sich umentscheiden; der Verweis zeigt, wo die Annahme im Code oder Plan steckt.

Format: **Frage** – getroffene Annahme – *wo*.

## Allgemein

- **Meilenstein 7?** Die SPEC kennt nur sechs Meilensteine. Der Auftrag «M7 nicht» ist damit ohne Wirkung; nichts über M6 hinaus wurde gebaut. – *docs/SPEC.md, Meilensteine*
- **Installierte Skills einchecken?** Nein. `.agents/` und `.claude/skills/` (zusammen rund 77 MB) lassen sich aus `skills-lock.json` wiederherstellen und sind wie `node_modules` ignoriert. Eingecheckt sind `skills-lock.json` und `.claude/agents/`. – *.gitignore*
- **Git-Repository anlegen?** Der Ordner war kein Repository; für die verlangten Commits habe ich `git init` ausgeführt. Commits nur lokal, kein Remote, keine Co-Authored-By-Zeile (globale Regel). – *.git*
- **Arbeitsdateien.** Testdaten und Zwischenstände liegen in `.tmp/` im Projektordner (ignoriert), damit nichts ausserhalb des Ordners geschrieben wird. Ausnahmen, die sich nicht vermeiden lassen: Docker-Images, -Container, -Volumes und -Netze auf dem lokalen Docker sowie der pnpm-Paketspeicher. – *.tmp/*
