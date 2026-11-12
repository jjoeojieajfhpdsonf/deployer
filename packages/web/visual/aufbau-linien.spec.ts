// Zuerst die feste Uhr, dann die Fixtures (sie rechnen beim Import mit Date.now())
import { FIXED_NOW } from './fixed-clock.js'
import { test, expect, type Page } from '@playwright/test'
import { contextOptions, installRoutes, openShot, shots } from '../design-shots/shoot.js'
import { VISUAL_PORT } from './playwright.config.js'

/**
 * Reiter «Aufbau»: Jeder Endpunkt einer Linie sitzt am Rand seiner Zielkarte –
 * auf der Seite und im Dialog «Vergrössern». Mit Bewegung (nicht «reduce» wie die
 * Bildvergleiche): Der Dialog blendet von scale(0.97) ein, und eine Messung in dieser
 * Zeit hatte alle Linien um 3 % zur Mitte verschoben – auf den Bildern nicht sichtbar.
 */

async function edgesMatchCards(page: Page, scope: string): Promise<void> {
  const r = await page.evaluate((scope) => {
    const root = document.querySelector(scope)!
    const body = root.querySelector('.topo-body')!.getBoundingClientRect()
    const nodes = [...root.querySelectorAll<HTMLElement>('.topo-body .topo-node')].map((n) => {
      const b = n.getBoundingClientRect()
      return { l: b.left - body.left, r: b.right - body.left, cy: b.top + b.height / 2 - body.top }
    })
    const dots = [...root.querySelectorAll('.topo-edges circle')].map((c) => ({ x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')) }))
    return { nodes, dots }
  }, scope)
  expect(r.dots.length, 'Linien gezeichnet').toBeGreaterThan(0)
  for (const d of r.dots) {
    // Endpunkt am linken (Spalte zu Spalte) oder rechten Rand (Datenbank → Volume) einer Karte, auf halber Höhe
    const hit = r.nodes.some((n) => (Math.abs(n.l - d.x) < 1.5 || Math.abs(n.r - d.x) < 1.5) && Math.abs(n.cy - d.y) < 1.5)
    expect(hit, `Endpunkt ${d.x.toFixed(1)} / ${d.y.toFixed(1)} liegt an keinem Kartenrand`).toBe(true)
  }
}

for (const width of [1440, 1920]) {
  test(`Aufbau: Linien enden am Kartenrand, Seite und vergrössert · ${width} px`, async ({ browser }) => {
    const s = { ...shots.find((x) => x.name === 'aufbau')!, prepare: undefined }
    const ctx = await browser.newContext({ ...contextOptions('light'), reducedMotion: 'no-preference', viewport: { width, height: 1000 } })
    await installRoutes(ctx, s, 'light', VISUAL_PORT)
    const page = await ctx.newPage()
    await page.clock.setFixedTime(FIXED_NOW)
    await openShot(page, s, VISUAL_PORT)
    await edgesMatchCards(page, '.page-project')
    await page.getByRole('button', { name: 'Vergrössern' }).click()
    await page.locator('.dialog-full .topo-edges circle').first().waitFor()
    // Nach der Einblendung (200 ms) – die Linien wurden währenddessen gemessen
    await page.waitForTimeout(400)
    await edgesMatchCards(page, '.dialog-full')
    await ctx.close()
  })
}
