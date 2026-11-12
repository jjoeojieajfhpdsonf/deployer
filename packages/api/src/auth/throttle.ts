/**
 * Anmeldeversuche begrenzen – rein, mit eingespritzter Uhr (testbar).
 *
 * Je Schlüssel («ip:…», «user:…») zählen Fehlversuche. Nach maxFailures
 * Fehlversuchen ist der Schlüssel gesperrt: zuerst baseLockMs (15 Min.),
 * jede weitere Sperre doppelt so lang (exponentiell), höchstens maxLockMs.
 * Ein Erfolg setzt alles zurück; nach resetAfterMs ohne Fehlversuch beginnt
 * die Stufe wieder von vorn.
 */

export interface ThrottleOptions {
  maxFailures: number
  baseLockMs: number
  maxLockMs: number
  resetAfterMs: number
  /** Höchstzahl gemerkter Schlüssel (Schutz vor unbegrenztem Speicher) */
  maxKeys: number
}

export const DEFAULT_THROTTLE: ThrottleOptions = {
  maxFailures: 5,
  baseLockMs: 15 * 60_000,
  maxLockMs: 24 * 60 * 60_000,
  resetAfterMs: 24 * 60 * 60_000,
  maxKeys: 10_000,
}

interface Entry {
  failures: number
  /** Anzahl bisheriger Sperren (für die Verdopplung) */
  level: number
  lockedUntil: number
  lastFailure: number
}

export type ThrottleCheck = { locked: false } | { locked: true; retryAfterMs: number }

export class LoginThrottle {
  private entries = new Map<string, Entry>()

  constructor(private readonly now: () => number, private readonly opts: ThrottleOptions = DEFAULT_THROTTLE) {}

  private entry(key: string): Entry | undefined {
    const e = this.entries.get(key)
    if (!e) return undefined
    const t = this.now()
    if (e.lockedUntil <= t && t - e.lastFailure > this.opts.resetAfterMs) {
      this.entries.delete(key)
      return undefined
    }
    return e
  }

  check(key: string): ThrottleCheck {
    const e = this.entry(key)
    const t = this.now()
    if (e && e.lockedUntil > t) return { locked: true, retryAfterMs: e.lockedUntil - t }
    return { locked: false }
  }

  /** Der längste laufende Sperrzeitraum mehrerer Schlüssel */
  checkAll(keys: string[]): ThrottleCheck {
    let worst: ThrottleCheck = { locked: false }
    for (const k of keys) {
      const c = this.check(k)
      if (c.locked && (!worst.locked || c.retryAfterMs > worst.retryAfterMs)) worst = c
    }
    return worst
  }

  /** Fehlversuch zählen; gibt die neue Sperrdauer zurück, wenn er eine Sperre auslöst */
  fail(key: string): { lockedMs: number | null; failures: number } {
    const t = this.now()
    let e = this.entry(key)
    if (!e) {
      if (this.entries.size >= this.opts.maxKeys) {
        // Ältesten Eintrag ohne laufende Sperre verwerfen
        for (const [k, v] of this.entries) {
          if (v.lockedUntil <= t) { this.entries.delete(k); break }
        }
      }
      e = { failures: 0, level: 0, lockedUntil: 0, lastFailure: t }
      this.entries.set(key, e)
    }
    e.lastFailure = t
    e.failures++
    if (e.failures >= this.opts.maxFailures) {
      const ms = Math.min(this.opts.baseLockMs * 2 ** e.level, this.opts.maxLockMs)
      e.level++
      e.failures = 0
      e.lockedUntil = t + ms
      return { lockedMs: ms, failures: this.opts.maxFailures }
    }
    return { lockedMs: null, failures: e.failures }
  }

  succeed(key: string): void {
    this.entries.delete(key)
  }

  /** Alle Sperren aufheben (Notausgang, Tests) */
  clear(): void {
    this.entries.clear()
  }
}

/** Minuten, aufgerundet, für Meldungen */
export const minutesOf = (ms: number): number => Math.max(1, Math.ceil(ms / 60_000))
