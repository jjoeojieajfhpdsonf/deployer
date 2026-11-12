import { createHash, randomBytes } from 'node:crypto'

/**
 * Eindeutige Besucher ohne Cookie und ohne gespeicherte IP: Hash aus
 * Tagessalz, IP und User-Agent. Das Salz entsteht zufällig, liegt nur im
 * Speicher und wird beim Tageswechsel (Ortszeit) ersetzt – danach lässt sich
 * aus keinem Hash mehr auf eine IP schliessen, und derselbe Besucher ist am
 * nächsten Tag ein neuer. Auch die Hashes selbst verlassen den Speicher nie:
 * gespeichert wird nur, ob eine Anfrage die erste des Besuchers an diesem
 * Tag war (Zähler «visitors»).
 *
 * Nach einem Neustart von Airlock gibt es ein neues Salz: wer an diesem Tag
 * schon da war, zählt dann noch einmal. Bewusst so – ein Salz auf der Platte
 * wäre das, was Personendaten wieder verknüpfbar macht.
 */

/** Höchstens so viele Hashes je Projekt und Tag im Speicher; darüber zählt jeder als neu */
const MAX_SEEN = 200_000

/** Tag in der Zeitzone der Anzeige als «JJJJ-MM-TT» */
export function localDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
}

export class VisitorCounter {
  private salt: Buffer
  private day: string
  private seen = new Map<string, Set<string>>()

  constructor(
    private readonly timeZone: string,
    now = Date.now(),
    /** Für Tests: Salz vorgeben */
    private readonly newSalt: () => Buffer = () => randomBytes(32),
  ) {
    this.salt = this.newSalt()
    this.day = localDay(now, timeZone)
  }

  /** Neuer Tag (Ortszeit): neues Salz, alle Hashes vergessen */
  private rotate(at: number): void {
    const d = localDay(at, this.timeZone)
    if (d === this.day) return
    // Nur vorwärts: eine verspätete Zeile von gestern dreht nicht zurück
    if (d < this.day) return
    this.day = d
    this.salt.fill(0)
    this.salt = this.newSalt()
    this.seen.clear()
  }

  /** Hash eines Besuchers (nur für Tests und den Vergleich gedacht, nie speichern) */
  hash(ip: string, userAgent: string, at = Date.now()): string {
    this.rotate(at)
    return createHash('sha256').update(this.salt).update('\0').update(ip).update('\0').update(userAgent).digest('base64url').slice(0, 22)
  }

  /** Erste Anfrage dieses Besuchers heute an dieses Projekt? */
  firstToday(projectId: string, ip: string, userAgent: string, at = Date.now()): boolean {
    const h = this.hash(ip, userAgent, at)
    let set = this.seen.get(projectId)
    if (!set) {
      set = new Set()
      this.seen.set(projectId, set)
    }
    if (set.has(h)) return false
    if (set.size < MAX_SEEN) set.add(h)
    return true
  }

  /** Für Tests: aktueller Tag des Salzes */
  get currentDay(): string {
    return this.day
  }
}
