# Bildmarke für Airlock – drei Varianten

**Entschieden: Variante 1 (Doppeltor)** (Frage 6 in `docs/FRAGEN-NACHT.md`). Sie steht im Favicon,
auf der Anmeldeseite und in der Seitenleiste vor «Airlock»; der Knopf zum Einklappen bleibt daneben.
Variante 3 wird nicht verwendet (wirkt bei 16 px wie ein Pause-Symbol). Entworfen nach dem Taste
Skill (design-taste-frontend).

Alle drei: `viewBox="0 0 32 32"`, Kanten auf geraden Koordinaten (bei 16 px ganze Pixel), nur
`currentColor` (`variante-n.svg`); die Favicons (`favicon-n.svg`) tragen #242424 (hell) bzw. #f2f2f3
(dunkel) über `prefers-color-scheme`. Proben je Variante: `vn-uebersicht-hell.png` / `-dunkel.png`
(16, 32, 128 px und die 16- und 32-px-Rasterung achtfach vergrössert); Favicons im Browser:
`favicons-hell.png` / `favicons-dunkel.png`.

## Variante 1 – Doppeltor

Ein Rundbogen-Portal, in dem ein zweites, geschlossenes Tor steht: Tor hinter Tor, wie beim Blick in
eine Schleuse. Das Projekt muss erst durch das äussere, dann durch das innere. Bei 16 px bleiben
Bogen und inneres Tor getrennt (2 px Bogen, 2 px Luft); der Scheitel wird leicht weich.

## Variante 2 – Kammer

Die Schleusenkammer von oben: eine Wand mit zwei versetzten Öffnungen, links unten hinein und rechts
oben hinaus, sodass nie ein gerader Weg durchführt; in der Mitte das Projekt als Block. Der höhere
Ausgang deutet den Weg nach aussen an (intern → Tailnet → öffentlich). Bei 16 px sind beide
Öffnungen als 3-px-Lücken lesbar.

## Variante 3 – Schiebetore

Ein Block, in zwei Torflügel geteilt und gegeneinander verschoben; der Spalt dazwischen ist der
Durchgang – der Moment, in dem die Schleuse aufgeht. Bei 16 px die robusteste der drei: zwei volle
Flächen mit 2 px Spalt.

## Worauf beim Taste Skill geachtet wurde

- Gefüllte, einfache geometrische Formen in einer Farbe, keine Umrisslinien, keine Schrift im
  Zeichen; der Name steht daneben in Cal Sans.
- Eigenständig, keine Anlehnung an bestehende Marken (geprüft und vermieden: Rundquadrat mit Kreis –
  erinnert an eine bekannte Kamera-Marke –, Pause-Zeichen, Wolke, Punkte-Raster).
- Rundungen passend zur weichen Skala der Oberfläche; ein Farbwert, kein Akzent, kein Verlauf.
