# Prototyp «Umgebungen»

Konzept: `docs/SPEC.md`, Abschnitt «Umgebungen». Die Umsetzung läuft als Meilenstein 9 (Branch `milestone-9`).

Die Bilder sind eine Fixture-Variante des Screenshot-Werkzeugs: Das Skript `packages/web/design-shots/umgebungen.ts`
blendet Umschalter, Einstellungen und «Projekt verschieben» per DOM über die echte Oberfläche, mit den
Tokens und Klassen aus `styles.css`. Der Produktivcode ist unverändert. Auf `main` liegen nur die Bilder; das
Skript steht auf dem Branch `umgebungen`, da es mit der echten Umsetzung entfällt. «example.ch» steht für die heutige
Installation (nach der Migration «jherren.com»), «Verein» und «Labor» sind erfundene weitere Umgebungen.

| Bild | Zeigt |
| --- | --- |
| `umgebungen-projekte-*` | Umschalter zu: Kürzel neben «Airlock»; Server-Teil unten abgesetzt |
| `umgebungen-umschalter-*` | Umschalter offen: Umgebungen mit Domain, Projekten, kritischen Befunden (Zahl mit Wort) |
| `umgebungen-cloudflare-*` | Einstellungen → Cloudflare & HTTPS: Hauptzone, interne Basis, Zertifikat, Tailnet, lokaler DNS, Token, Tunnel |
| `umgebungen-standards-*` | Einstellungen → Standards: Header-Vorlagen, Access, Pause-Seite |
| `umgebungen-verschieben-*` | Projekt → Einstellungen: in andere Umgebung verschieben, mit Vorschau der Folgen |

Neu erzeugen (auf dem Branch `umgebungen`):

```bash
pnpm --filter @deployer/web exec tsx design-shots/shoot.ts --out docs/design-cal/umgebungen --only umgebungen
```

**Zum Umschalter neben dem Logo:** In der 256 px breiten Seitenleiste passt neben «Airlock» nur das Kürzel.
Name und Domain zeigt das geöffnete Menü; der Pfad oben beginnt mit der Umgebung. Einen zweiten Block mit dem
Namen der Umgebung über der Navigation gibt es nicht mehr – er wiederholte nur den Umschalter. Eingeklappt
bleibt nur das Kürzel unter dem Zeichen.
