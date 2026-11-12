# Vorlage: Datenschutz-Absatz für öffentliche Seiten

Zum Kopieren in die Datenschutzerklärung einer Seite, die über Airlock läuft. Der Text beschreibt,
was Airlock (Besucher-Auswertung, Stand «Besucher neu») tatsächlich erfasst. Platzhalter in
`[eckigen Klammern]` ersetzen; Absätze zu Funktionen, die du nicht nutzt, streichen.

Keine Rechtsberatung – die Vorlage beschreibt die Technik. Ob für deine Seite zusätzlich etwas nötig
ist (z. B. Angaben zu Cloudflare als Auftragsbearbeiter oder zu Inhalten Dritter), prüfst du selbst.

---

## Zugriffsstatistik

Diese Website wird auf einem eigenen Server von [Name / Betreiber] betrieben. Beim Aufruf einer Seite
verarbeitet der Webserver technisch notwendige Angaben: IP-Adresse, Zeitpunkt, aufgerufene Adresse,
Statuscode, Browserkennung (User-Agent), Spracheinstellung des Browsers und die verweisende Seite
(Referrer).

Für eine anonyme Zugriffsstatistik werden daraus **nur Zähler je Stunde** gebildet:

- Anzahl Seitenaufrufe und eindeutiger Besucher je Tag
- aufgerufene Seite (Pfad ohne Parameter), Statuscode
- Land (von unserem Netzwerkdienstleister Cloudflare) und gegebenenfalls Stadt
- Name der verweisenden Website (ohne Pfad und Suchbegriffe)
- Gerätetyp (Computer, Handy, Tablet), Browser- und Systemfamilie mit Hauptversion
  (z. B. «Safari 18», «iOS 18»), erste bevorzugte Sprache (z. B. «Deutsch (Schweiz)»)
- Internetanbieter bzw. Netz (z. B. «Swisscom»), um Zugriffe aus Rechenzentren als Bots zu erkennen
- Kampagnenangaben aus Links (`utm_source`, `utm_medium`, `utm_campaign`), falls vorhanden
- Einstiegs- und Ausstiegsseite eines Besuchs

**IP-Adressen werden nicht gespeichert.** Um eindeutige Besucher zu zählen, wird aus IP-Adresse,
Browserkennung und einem zufälligen, täglich wechselnden Schlüssel ein Prüfwert gebildet. Er und der
Schlüssel existieren nur im Arbeitsspeicher des Servers und werden spätestens um Mitternacht verworfen;
gespeichert wird nur, ob ein Aufruf der erste des Tages war. Ein Wiedererkennen über mehrere Tage ist
damit nicht möglich.

Es werden **keine Cookies** gesetzt und **kein Skript** zur Messung in die Seite eingebunden.
Koordinaten, Postleitzahlen und der vollständige Browser-User-Agent werden nicht gespeichert; weitere
Parameter in der Adresse (z. B. Suchbegriffe) ebenfalls nicht.

Wenn dein Browser «Do Not Track» oder «Global Privacy Control» sendet, zählt dein Aufruf in den Summen
mit, wird aber nicht einem Besuchsverlauf (Einstiegs- und Ausstiegsseite) zugeordnet.

Die Protokolldatei des Webservers mit den Rohdaten wird nach höchstens [2] Tagen automatisch gelöscht.
Die Zähler werden nach 13 Monaten gelöscht. Eine Weitergabe an Dritte findet nicht statt.
[Optional: Die Zuordnung von IP-Adressen zu Stadt und Anbieter erfolgt lokal mit den freien Datenbanken
«IP to City Lite» und «IP to ASN Lite» von DB-IP (db-ip.com, CC BY 4.0); dabei wird keine Anfrage an
DB-IP gesendet.]

Rechtsgrundlage ist unser berechtigtes Interesse an einem sicheren und funktionierenden Betrieb der
Website und an einer anonymen Reichweitenmessung [Schweiz: Art. 31 Abs. 1 DSG; EU: Art. 6 Abs. 1 lit. f DSGVO].

---

## Hinweise zum Anpassen

- **Cloudflare:** Läuft die Seite öffentlich, gehen alle Anfragen über den Cloudflare-Tunnel. Cloudflare
  verarbeitet dabei IP-Adressen nach eigenen Bedingungen – das gehört in einen eigenen Absatz
  («Content Delivery Network / Cloudflare»), unabhängig von Airlock.
- **Stadt:** Ohne Städte-Datenbank und ohne Cloudflares «Visitor Location Headers» erfasst Airlock nur
  das Land – dann «und gegebenenfalls Stadt» streichen.
- **Anbieter:** Ohne Provider-Datenbank (Server › Besucher) den Punkt «Internetanbieter bzw. Netz» und
  den optionalen Satz zu DB-IP entsprechend kürzen.
- **Aufbewahrung der Rohdaten:** Caddy rotiert das Zugriffs-Log bei 20 MB, behält 2 alte Dateien und
  höchstens 2 Tage (Konfiguration in Airlock). Wer das ändert, passt die Zahl an.
- **Interne Projekte** (nur Tailnet/Heimnetz) brauchen den Absatz in der Regel nicht.
