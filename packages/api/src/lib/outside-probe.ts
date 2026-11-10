import type { OutsideCheckDto } from '@deployer/shared'

/**
 * Prüfung eines öffentlichen Namens von aussen: eine Anfrage an
 * https://<name>/, wie sie ein Besucher stellt – über den öffentlichen DNS
 * zu Cloudflare, durch den Tunnel zu Caddy. Bewusst ohne config.ts, damit
 * die Einordnung ohne Umgebung testbar bleibt.
 */

export type Expect = 'live' | 'paused' | 'gone'

export interface Observation {
  status: number | null
  /** Antwort trägt cf-ray: kam über Cloudflare */
  cfRay: boolean
  /** Wartungsseite von deployer (X-Deployer-State: paused) */
  maintenance: boolean
  location?: string | null
  /** Anfang des Bodys (Caddys eigene 403/404 erkennen) */
  body?: string
  /** Netzfehler: DNS, Zeitüberschreitung, TLS */
  error?: string
}

export type Verdict = OutsideCheckDto & { final: boolean }

const CADDY_404 = 'Kein Projekt unter diesem Namen.'
const CADDY_403 = 'Kein Zugriff von'

/** Ergebnis einer Beobachtung gegen die Erwartung; final = weiteres Warten bringt nichts. */
export function classify(o: Observation, expect: Expect, opts: { access?: boolean } = {}): Verdict {
  const base = { status: o.status, viaCloudflare: o.cfRay }
  const notCf = o.status !== null && !o.cfRay ? ' Die Antwort kam allerdings nicht über Cloudflare – zeigt ein lokaler DNS den Namen direkt auf den Server?' : ''

  if (expect === 'gone') {
    if (o.error) return { ...base, ok: true, final: true, message: 'Der Name ist von aussen nicht mehr erreichbar.' }
    if (o.status === 530 || o.status === 404 || (o.status !== null && o.status >= 520 && o.status <= 527)) {
      return { ...base, ok: true, final: true, message: `Cloudflare liefert nichts mehr aus (HTTP ${o.status}).` }
    }
    return { ...base, ok: false, final: false, message: `Der Name antwortet noch (HTTP ${o.status}). Cloudflare und DNS-Caches brauchen dafür manchmal einige Minuten.` }
  }

  if (o.error) {
    return { ...base, ok: false, final: false, message: `Von aussen noch nicht erreichbar (${o.error}). Ein neuer DNS-Eintrag braucht manchmal einige Minuten.` }
  }
  const s = o.status!

  if (expect === 'paused') {
    if (s === 503 && o.maintenance) return { ...base, ok: true, final: true, message: `Besucher sehen die Wartungsseite (HTTP 503).${notCf}` }
    return { ...base, ok: false, final: false, message: `Noch nicht die Wartungsseite (HTTP ${s}).${notCf}` }
  }

  // live
  if (o.maintenance) return { ...base, ok: false, final: false, message: 'Es kommt noch die Wartungsseite.' }
  if (opts.access && (s === 302 || s === 303) && /cloudflareaccess\.com/.test(o.location ?? '')) {
    return { ...base, ok: true, final: true, message: 'Erreichbar – Cloudflare Access fragt zuerst nach dem Login.' }
  }
  if (s >= 530 || (s >= 520 && s <= 527)) return { ...base, ok: false, final: false, message: `Cloudflare erreicht den Tunnel noch nicht (HTTP ${s}).` }
  if (s === 404 && o.body?.startsWith(CADDY_404)) return { ...base, ok: false, final: false, message: 'Caddy kennt den Namen noch nicht (HTTP 404).' }
  if (s === 403 && o.body?.startsWith(CADDY_403)) return { ...base, ok: false, final: true, message: 'Caddy lehnt ab: die Anfrage kam nicht von cloudflared (HTTP 403).' }
  if (s === 502 || s === 503 || s === 504) return { ...base, ok: false, final: false, message: `Das Projekt antwortet nicht (HTTP ${s}). Läuft es?` }
  return { ...base, ok: true, final: true, message: `Von aussen erreichbar (HTTP ${s}).${notCf}` }
}

/** Eine Anfrage; Netzfehler werden zur Beobachtung, nicht zur Ausnahme. */
export async function observe(hostname: string, timeoutMs = 6000): Promise<Observation> {
  try {
    const res = await fetch(`https://${hostname}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'deployer-outside-check', 'cache-control': 'no-cache' },
    })
    const body = (await res.text().catch(() => '')).slice(0, 200)
    return {
      status: res.status,
      cfRay: res.headers.has('cf-ray'),
      maintenance: res.headers.get('x-deployer-state') === 'paused',
      location: res.headers.get('location'),
      body,
    }
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } }
    const code = e.cause?.code
    const error = code === 'ENOTFOUND' ? 'Name löst nicht auf' : e.name === 'TimeoutError' ? 'keine Antwort' : code ?? e.message
    return { status: null, cfRay: false, maintenance: false, error }
  }
}

/** Wiederholt, bis die Erwartung erfüllt ist, ein endgültiges Ergebnis kommt oder die Zeit um ist. */
export async function checkFromOutside(
  hostname: string,
  expect: Expect,
  opts: { access?: boolean; deadlineMs?: number; intervalMs?: number; look?: typeof observe } = {},
): Promise<OutsideCheckDto> {
  const until = Date.now() + (opts.deadlineMs ?? (expect === 'gone' ? 12_000 : 25_000))
  const look = opts.look ?? observe
  for (;;) {
    const v = classify(await look(hostname), expect, opts)
    if (v.ok || v.final || Date.now() >= until) {
      const { final: _f, ...dto } = v
      return dto
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 2500))
  }
}
