// Zuerst die feste Uhr, dann die Fixtures (sie rechnen beim Import mit Date.now())
import { FIXED_NOW } from './fixed-clock.js'
import { test, expect, type Browser } from '@playwright/test'
import { contextOptions, installRoutes, openShot, shots } from '../design-shots/shoot.js'
import { VISUAL_PORT } from './playwright.config.js'

/**
 * UI-Qualität 3: Anfragen pro Minute an die API, wenn die Seite einfach offen
 * steht. Die Uhr des Browsers läuft künstlich 60 s weiter (page.clock), die
 * Abfragen der Oberfläche feuern dabei wie in echt.
 *
 * - «Ereignisstrom verbunden»: EventSource ist offen (nachgebaut, die
 *   Screenshot-Umgebung hat keinen Server) → Polling ruht.
 * - «ohne Ereignisstrom»: /api/v1/events antwortet nicht als Strom → Rückfall
 *   auf 60-s-Polling.
 *
 * Die Zahlen stehen in der Testausgabe und in docs/MILESTONE-UI-QUALITAET.md.
 */

const PAGES = [
  { name: 'Projektliste', path: '/projekte' },
  { name: 'Projektseite', path: '/projekte/p-foto' },
] as const

/** Offener Ereignisstrom, ohne Server: öffnet und bleibt offen */
const FAKE_SSE = `
  window.EventSource = class {
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = {};
      setTimeout(() => { this.readyState = 1; this.onopen?.({}); (this.listeners.open || []).forEach((f) => f({})) }, 0) }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f) }
    removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f) }
    close() { this.readyState = 2 }
  }
`

/** Tab versteckt (wie beim Wechsel in einen anderen Tab) */
const HIDE = () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  document.dispatchEvent(new Event('visibilitychange'))
}

async function perMinute(browser: Browser, path: string, sse: boolean, hidden = false): Promise<{ total: number; byPath: Record<string, number> }> {
  const s = { ...shots.find((x) => x.name === 'projekte')!, path, prepare: undefined }
  const ctx = await browser.newContext(contextOptions('light'))
  try {
    await installRoutes(ctx, s, 'light', VISUAL_PORT)
    if (sse) await ctx.addInitScript(FAKE_SSE)
    const page = await ctx.newPage()
    await page.clock.install({ time: FIXED_NOW })
    await openShot(page, s, VISUAL_PORT)
    // Anlaufen lassen (erste Abfragen, Verbindungsaufbau), dann eine Minute zählen
    await page.clock.runFor(5_000)
    if (hidden) await page.evaluate(HIDE)
    const byPath: Record<string, number> = {}
    let total = 0
    page.on('request', (r) => {
      const u = new URL(r.url())
      if (!u.pathname.startsWith('/api/v1/')) return
      const key = u.pathname.replace(/\/p-[\w-]+/, '/:id').replace(/\/[\w-]+-d\d+/, '/:dep')
      byPath[key] = (byPath[key] ?? 0) + 1
      total++
    })
    // In Sekundenschritten, mit kurzer echter Pause: Antworten kommen an, bevor die nächste Abfrage fällig ist
    for (let i = 0; i < 60; i++) {
      await page.clock.runFor(1_000)
      await page.waitForTimeout(25)
    }
    return { total, byPath }
  } finally {
    await ctx.close()
  }
}

/*
 * Gemessen vor UI-Qualität 3 (Polling alle 3–15 s): Projektliste 42/min, Projektseite 59/min.
 * Danach: mit Strom 2 bzw. 3/min (nur Messwerte: System, Cloudflare/Tunnel, Health), ohne Strom
 * 6 bzw. 9/min. Die Grenzen unten lassen etwas Luft, fangen aber ein Zurückfallen auf
 * Sekunden-Polling.
 */
const LIMIT = { sse: 4, fallback: 12 }

for (const p of PAGES) {
  for (const sse of [true, false]) {
    test(`Anfragen pro Minute · ${p.name} · ${sse ? 'Ereignisstrom verbunden' : 'ohne Ereignisstrom'}`, async ({ browser }) => {
      const r = await perMinute(browser, p.path, sse)
      test.info().annotations.push({ type: 'Anfragen pro Minute', description: `${r.total} ${JSON.stringify(r.byPath)}` })
      console.log(`[anfragen] ${p.name} · ${sse ? 'mit SSE' : 'ohne SSE'}: ${r.total}/min ${JSON.stringify(r.byPath)}`)
      expect(r.total).toBeLessThanOrEqual(sse ? LIMIT.sse : LIMIT.fallback)
      // Ohne Strom fragt jede Abfrage höchstens einmal pro Minute
      for (const [path, n] of Object.entries(r.byPath)) if (path !== '/api/v1/events') expect(n, path).toBeLessThanOrEqual(1)
    })
  }
}

for (const sse of [true, false]) {
  test(`Versteckter Tab: kein Polling · ${sse ? 'Ereignisstrom verbunden' : 'ohne Ereignisstrom'}`, async ({ browser }) => {
    const r = await perMinute(browser, '/projekte/p-foto', sse, true)
    console.log(`[anfragen] Projektseite · versteckt, ${sse ? 'mit' : 'ohne'} SSE: ${r.total}/min ${JSON.stringify(r.byPath)}`)
    const polls = Object.entries(r.byPath).filter(([path]) => path !== '/api/v1/events').reduce((a, [, n]) => a + n, 0)
    expect(polls).toBe(0)
  })
}
