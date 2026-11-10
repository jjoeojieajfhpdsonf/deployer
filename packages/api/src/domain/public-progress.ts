import type { PublicOp, PublicProgressDto, PublicStepDto, PublicStepState } from '@airlock/shared'

/**
 * Fortschritt eines Übergangs der Veröffentlichung (veröffentlichen,
 * pausieren, fortsetzen, ganz offline nehmen), nur im Speicher. Die Karte
 * fragt ihn ab, solange ihr Aufruf läuft. Pro Projekt höchstens ein
 * Übergang zugleich.
 */

type Key = PublicStepDto['key']

const LABELS: Record<Key, string> = {
  check: 'Schwelle und Name prüfen',
  dns: 'DNS-Eintrag',
  access: 'Cloudflare Access',
  tunnel: 'Tunnel-Regel',
  caddy: 'Caddy',
  outside: 'Prüfung von aussen über Cloudflare',
}

/** Schritte je Übergang, in der Reihenfolge, in der sie laufen. */
export function stepsFor(op: PublicOp, opts: { access?: boolean } = {}): Key[] {
  switch (op) {
    case 'publish':
      return ['check', 'dns', ...(opts.access ? (['access'] as Key[]) : []), 'tunnel', 'caddy', 'outside']
    case 'access':
      return ['check', 'access', 'outside']
    case 'pause':
      return ['caddy', 'outside']
    case 'resume':
      return ['check', 'caddy', 'outside']
    case 'unpublish':
      return ['dns', 'access', 'tunnel', 'caddy', 'outside']
  }
}

export const stepLabel = (op: PublicOp, key: Key): string => {
  if (key === 'caddy') return op === 'pause' ? 'Wartungsseite einschalten' : op === 'resume' ? 'Wartungsseite ausschalten' : op === 'unpublish' ? 'Caddy-Route entfernen' : 'Caddy-Route'
  if (key === 'dns' && op === 'unpublish') return 'DNS-Eintrag entfernen'
  if (key === 'tunnel' && op === 'unpublish') return 'Tunnel-Regel entfernen'
  if (key === 'access' && op === 'unpublish') return 'Access-App entfernen'
  return LABELS[key]
}

export class Progress {
  readonly dto: PublicProgressDto

  constructor(op: PublicOp, hostname: string | null, keys: Key[], now = new Date()) {
    this.dto = {
      op, hostname,
      steps: keys.map((key) => ({ key, label: stepLabel(op, key), state: 'todo' as PublicStepState })),
      startedAt: now.toISOString(), finishedAt: null, ok: null,
    }
  }

  private step(key: Key): PublicStepDto | undefined {
    return this.dto.steps.find((s) => s.key === key)
  }

  /** Schritt beginnt; ein noch laufender davor gilt als erledigt. */
  start(key: Key): void {
    for (const s of this.dto.steps) if (s.state === 'current' && s.key !== key) s.state = 'done'
    const s = this.step(key)
    if (s) s.state = 'current'
  }

  set(key: Key, state: PublicStepState, detail?: string): void {
    const s = this.step(key)
    if (!s) return
    s.state = state
    if (detail !== undefined) s.detail = detail
  }

  hostname(h: string): void {
    this.dto.hostname = h
  }

  /** Ende: offene Schritte nach Ergebnis abschliessen. */
  finish(ok: boolean, error?: string, now = new Date()): void {
    for (const s of this.dto.steps) {
      if (s.state === 'current') s.state = ok ? 'done' : 'failed'
      else if (s.state === 'todo') s.state = 'skipped'
      if (!ok && s.state === 'failed' && error && !s.detail) s.detail = error
    }
    this.dto.ok = ok
    this.dto.finishedAt = now.toISOString()
    if (error) this.dto.error = error
  }
}

const store = new Map<string, Progress>()

export function progressOf(projectId: string): PublicProgressDto | null {
  return store.get(projectId)?.dto ?? null
}

export const isRunning = (projectId: string) => store.get(projectId)?.dto.ok === null

/**
 * Übergang mit Fortschritt ausführen. Läuft schon einer für dieses Projekt,
 * scheitert der zweite sofort (der Aufrufer meldet 409).
 */
export async function withProgress<T>(
  projectId: string,
  op: PublicOp,
  hostname: string | null,
  keys: Key[],
  run: (p: Progress) => Promise<T>,
  onBusy: () => Error,
): Promise<T> {
  if (isRunning(projectId)) throw onBusy()
  const p = new Progress(op, hostname, keys)
  store.set(projectId, p)
  try {
    const r = await run(p)
    p.finish(true)
    return r
  } catch (err) {
    p.finish(false, (err as Error).message)
    throw err
  }
}
