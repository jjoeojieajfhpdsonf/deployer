import { createHash, randomBytes } from 'node:crypto'
import { localDay, type TrafficWay } from '@airlock/shared'

/**
 * Eindeutige Besucher ohne Cookie und ohne gespeicherte IP: Hash aus
 * Tagessalz, IP und User-Agent. Das Salz entsteht zufällig, liegt nur im
 * Speicher und wird beim Tageswechsel (Ortszeit) ersetzt – danach lässt sich
 * aus keinem Hash mehr auf eine IP schliessen, und derselbe Besucher ist am
 * nächsten Tag ein neuer. Auch die Hashes selbst verlassen den Speicher nie:
 * gespeichert wird nur, ob eine Anfrage die erste des Besuchers an diesem
 * Tag war (Zähler «visitors»).
 *
 * «Besucher neu»: Einstieg und Ausstieg. Zu jedem Hash merkt sich Airlock im
 * Speicher den letzten Pfad und die Zeit. Ein Besuch beginnt mit dem ersten
 * Aufruf (Einstieg) und endet nach 30 Minuten ohne Aufruf, beim Tageswechsel
 * oder beim Beenden (Ausstieg = letzter Pfad). In die Datenbank gehen nur die
 * Zähler je Pfad. Wer «Do Not Track» oder «Global Privacy Control» sendet,
 * zählt als Aufruf und Besucher, aber ohne Besuchsverlauf (track = false).
 *
 * Nach einem Neustart von Airlock gibt es ein neues Salz: wer an diesem Tag
 * schon da war, zählt dann noch einmal. Bewusst so – ein Salz auf der Platte
 * wäre das, was Personendaten wieder verknüpfbar macht.
 */

export { localDay }

/** Höchstens so viele Hashes je Projekt und Tag im Speicher; darüber zählt jeder als neu */
const MAX_SEEN = 200_000
/** Höchstens so viele offene Besuche (alle Projekte); darüber kein Verlauf für neue */
const MAX_VISITS = 100_000
/** Ein Besuch endet nach so langer Pause */
export const VISIT_IDLE_MS = 30 * 60_000

/** Ein beendeter Besuch: sein letzter Pfad ist ein Ausstieg */
export interface VisitEnd {
  projectId: string
  /** Zeitpunkt des letzten Aufrufs (ms) */
  at: number
  way: TrafficWay
  path: string
}

interface Visit {
  projectId: string
  at: number
  way: TrafficWay
  path: string
}

export class VisitorCounter {
  private salt: Buffer
  private day: string
  private seen = new Map<string, Set<string>>()
  private visits = new Map<string, Visit>()
  private ended: VisitEnd[] = []

  constructor(
    private readonly timeZone: string,
    now = Date.now(),
    /** Für Tests: Salz vorgeben */
    private readonly newSalt: () => Buffer = () => randomBytes(32),
  ) {
    this.salt = this.newSalt()
    this.day = localDay(now, timeZone)
  }

  /** Neuer Tag (Ortszeit): offene Besuche beenden, neues Salz, alle Hashes vergessen */
  private rotate(at: number): void {
    const d = localDay(at, this.timeZone)
    if (d === this.day) return
    // Nur vorwärts: eine verspätete Zeile von gestern dreht nicht zurück
    if (d < this.day) return
    this.closeAll()
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
    return this.see(projectId, ip, userAgent, at).first
  }

  /**
   * Ein erfolgreicher Seitenaufruf. first: erster des Tages (zählt als
   * Besucher). entry: erster eines Besuchs (Einstiegsseite) – nur mit
   * track. Beendet dabei einen abgelaufenen Besuch desselben Besuchers.
   */
  see(
    projectId: string, ip: string, userAgent: string, at = Date.now(),
    visit?: { path: string; way: TrafficWay; track: boolean },
  ): { first: boolean; entry: boolean } {
    const h = this.hash(ip, userAgent, at)
    let set = this.seen.get(projectId)
    if (!set) {
      set = new Set()
      this.seen.set(projectId, set)
    }
    const first = !set.has(h)
    if (first && set.size < MAX_SEEN) set.add(h)
    if (!visit?.track) return { first, entry: false }
    const key = `${projectId}\u0001${h}`
    const open = this.visits.get(key)
    if (open && at - open.at <= VISIT_IDLE_MS) {
      // Verspätete Zeile: Verlauf nicht zurückdrehen
      if (at >= open.at) {
        open.at = at
        open.path = visit.path
        open.way = visit.way
      }
      return { first, entry: false }
    }
    if (open) this.ended.push({ projectId: open.projectId, at: open.at, way: open.way, path: open.path })
    else if (this.visits.size >= MAX_VISITS) return { first, entry: true }
    this.visits.set(key, { projectId, at, way: visit.way, path: visit.path })
    return { first, entry: true }
  }

  /** Besuche ohne Aufruf seit VISIT_IDLE_MS beenden */
  sweep(now = Date.now()): void {
    for (const [k, v] of this.visits) {
      if (now - v.at <= VISIT_IDLE_MS) continue
      this.visits.delete(k)
      this.ended.push({ projectId: v.projectId, at: v.at, way: v.way, path: v.path })
    }
  }

  /** Alle offenen Besuche beenden (Tageswechsel, Herunterfahren) */
  closeAll(): void {
    for (const v of this.visits.values()) this.ended.push({ projectId: v.projectId, at: v.at, way: v.way, path: v.path })
    this.visits.clear()
  }

  /** Beendete Besuche abholen (Ausstiege) */
  takeEnded(): VisitEnd[] {
    const out = this.ended
    this.ended = []
    return out
  }

  /** Für Tests: aktueller Tag des Salzes */
  get currentDay(): string {
    return this.day
  }

  /** Für Tests: offene Besuche */
  get openVisits(): number {
    return this.visits.size
  }
}
