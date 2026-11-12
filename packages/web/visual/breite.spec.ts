// Zuerst die feste Uhr, dann die Fixtures (sie rechnen beim Import mit Date.now())
import { FIXED_NOW } from './fixed-clock.js'
import { test, expect } from '@playwright/test'
import { contextOptions, installRoutes, openShot, shots } from '../design-shots/shoot.js'
import { VISUAL_PORT } from './playwright.config.js'

/**
 * Nacht 3, Etappe 6 (Bildschirmbreite): keine waagrechte Scrollleiste von 360 bis 2560 px.
 * Nur gemessen, ohne Bilder – Airlock ist ein Desktop-Werkzeug, schmale Fenster werden nicht
 * gestaltet, sie dürfen aber nicht seitlich überlaufen. Die Seite wird einmal geladen und dann
 * auf jede Breite gezogen (wie beim Verkleinern des Fensters).
 */
const WIDTHS = [360, 768, 1024, 1280, 1440, 1920, 2560]
const PAGES = [
  'projekte-besucher', 'projekt-uebersicht', 'aufbau', 'besucher', 'm9-einstellungen-standards', 'audit', 'vorfaelle', 'speicher',
  'security-global', 'system-uebersicht', 'konto', 'neues-projekt-validierung',
]

for (const name of PAGES) {
  test(`keine waagrechte Scrollleiste 360–2560 px · ${name}`, async ({ browser }) => {
    const s = { ...shots.find((x) => x.name === name)!, prepare: undefined }
    const ctx = await browser.newContext(contextOptions('light'))
    try {
      await installRoutes(ctx, s, 'light', VISUAL_PORT)
      const page = await ctx.newPage()
      await page.clock.setFixedTime(FIXED_NOW)
      await openShot(page, s, VISUAL_PORT)
      const over: string[] = []
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 })
        await page.waitForTimeout(150)
        const r = await page.evaluate(() => {
          const doc = document.documentElement
          // Für die Meldung: das am weitesten nach rechts ragende Element (ohne solche in eigenen Scroll-Bereichen)
          let widest = ''
          let right = doc.clientWidth
          for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
            const b = el.getBoundingClientRect()
            if (b.width === 0 || b.right <= right + 0.5) continue
            let p = el.parentElement
            let clipped = false
            while (p && p !== document.body) {
              const o = getComputedStyle(p).overflowX
              if (o !== 'visible') { clipped = true; break }
              p = p.parentElement
            }
            if (clipped) continue
            right = b.right
            widest = `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`
          }
          return { scroll: doc.scrollWidth, client: doc.clientWidth, widest, right: Math.round(right) }
        })
        if (r.scroll > r.client) over.push(`${width} px: Seite ${r.scroll} px breit bei ${r.client} px – ${r.widest || '?'} (bis ${r.right} px)`)
      }
      expect(over, `waagrechte Scrollleiste in ${name}`).toEqual([])
    } finally {
      await ctx.close()
    }
  })
}

/**
 * Seitenleiste: Ein- und Ausklappen ändert nur die Breite. Knopf und Einträge bleiben auf
 * derselben Höhe (früher sprangen sie um ~9 px, weil der Schriftzug die Kopfzeile höher macht
 * und die Beschriftung «Server» eingeklappt samt Abstand verschwand).
 */
for (const theme of ['light', 'win95', 'terminal'] as const) {
  test(`Seitenleiste: Einträge bleiben beim Einklappen auf gleicher Höhe · ${theme}`, async ({ browser }) => {
    const s = { ...shots.find((x) => x.name === 'projekte')!, prepare: undefined }
    const ctx = await browser.newContext(contextOptions(theme))
    try {
      await installRoutes(ctx, s, theme, VISUAL_PORT)
      const page = await ctx.newPage()
      await page.clock.setFixedTime(FIXED_NOW)
      await openShot(page, s, VISUAL_PORT)
      const tops = () => page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.rail button.brand-mark, .rail-nav a')].map((el) => {
          const b = el.getBoundingClientRect()
          return Math.round(b.top + b.height / 2)
        }))
      const open = await tops()
      await page.getByRole('button', { name: 'Seitenleiste einklappen' }).click()
      await expect(page.locator('.rail-collapsed')).toBeVisible()
      const closed = await tops()
      expect(closed).toEqual(open)
    } finally {
      await ctx.close()
    }
  })
}
