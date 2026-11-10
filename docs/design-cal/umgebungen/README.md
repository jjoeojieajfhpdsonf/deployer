# Prototyp «Umgebungen»

Konzept: `docs/SPEC.md`, Abschnitt «Umgebungen». Noch nicht umgesetzt.

Die Bilder sind eine Fixture-Variante des Screenshot-Werkzeugs: `packages/web/design-shots/umgebungen.ts`
blendet Umschalter, Einstellungen und «Projekt verschieben» per DOM über die echte Oberfläche, mit den
Tokens und Klassen aus `styles.css`. Der Produktivcode ist unverändert. «example.ch» steht für die heutige
Installation (nach der Migration «jherren.com»), «Verein» und «Labor» sind erfundene weitere Umgebungen.

| Bild | Zeigt |
| --- | --- |
| `umgebungen-projekte-*` | Umschalter zu: Kürzel neben «Airlock», darunter Name der Umgebung; Server-Teil abgesetzt |
| `umgebungen-umschalter-*` | Umschalter offen: Umgebungen mit Domain, Projekten, kritischen Befunden (Zahl mit Wort) |
| `umgebungen-cloudflare-*` | Einstellungen → Cloudflare & HTTPS: Hauptzone, interne Basis, Zertifikat, Tailnet, lokaler DNS, Token, Tunnel |
| `umgebungen-standards-*` | Einstellungen → Standards: Header-Vorlagen, Access, Pause-Seite |
| `umgebungen-verschieben-*` | Projekt → Einstellungen: in andere Umgebung verschieben, mit Vorschau der Folgen |

Neu erzeugen:

```bash
pnpm --filter @deployer/web exec tsx design-shots/shoot.ts --out docs/design-cal/umgebungen --only umgebungen
```

**Zum Umschalter neben dem Logo:** In der 256 px breiten Seitenleiste passt neben «Airlock» nur das Kürzel.
Name und Zahl der Projekte stehen deshalb als Kopf der Navigation direkt darunter, und der Pfad oben beginnt
mit der Umgebung. Eingeklappt bleibt nur das Kürzel unter dem Zeichen.
