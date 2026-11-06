# Nacht-Log

Arbeit ohne Rückfragen, Nacht vom 6. auf den 7. November 2026. Pro Meilenstein: Stand, was getestet ist, was nicht, bekannte Probleme. Annahmen stehen in [OFFENE-FRAGEN.md](OFFENE-FRAGEN.md).

Reihenfolge laut Auftrag: M2, M3, M6, danach Code für M4 und M5 (ohne echte Domain, Token oder Server, also ungetestet).

## Ausgangslage: Meilenstein 1

**Stand:** fertig, als erster Commit eingecheckt. Details und Abnahme in [MILESTONE-1.md](MILESTONE-1.md).

**Getestet:** 56 Unit-Tests; Abnahme lokal mit Docker Desktop (13 von 14 Kriterien).

**Nicht getestet:** IP-Filter auf dem Linux-Server; die Ansichten nach dem Login und der Hell-Modus nicht im Browser angesehen.

**Letzte Änderung vor dem Commit:** Ohne Basisdomain zeigt die Oberfläche jetzt die nip.io-Adresse statt des Platzhalters `int.example.ch`. Wird die Basisdomain später gesetzt, ziehen bestehende Projekte beim Start mit.
