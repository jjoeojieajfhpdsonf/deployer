// Zuerst die feste Uhr, dann die Fixtures (sie rechnen beim Import mit Date.now())
import { FIXED_NOW } from './fixed-clock.js'
import { test, expect, type Browser, type Page } from '@playwright/test'
import { contextOptions, installRoutes, openShot, type Shot } from '../design-shots/shoot.js'
import { VISUAL_PORT } from './playwright.config.js'

/**
 * Besucher zusammen: Der frühere Reiter «Zugriffe» ist die Ansicht
 * «Einzelaufrufe» im Reiter «Besucher». Alte Adressen leiten dorthin weiter
 * (Filter, die es weiter gibt, kommen mit); Container-Projekte behalten
 * ihren Reiter «Logs». Rein geprüft in src/lib/access-view.test.ts, hier im
 * Browser mit Router und geladenem Projekt.
 */

async function open(browser: Browser, path: string): Promise<Page> {
  const s: Shot = { group: 'weiterleitung', name: 'weiterleitung', path }
  const ctx = await browser.newContext(contextOptions('light'))
  await installRoutes(ctx, s, 'light', VISUAL_PORT)
  const page = await ctx.newPage()
  await page.clock.setFixedTime(FIXED_NOW)
  await openShot(page, s, VISUAL_PORT)
  return page
}

test('Statische Seite: ?tab=logs (Reiter «Zugriffe») → Besucher › Einzelaufrufe, Filter bleiben', async ({ browser }) => {
  const page = await open(browser, '/projekte/p-hallo?tab=logs&status=abgewiesen&zeit=1h&zeile=z-gw')
  await expect(page).toHaveURL(/[?&]tab=besucher&ansicht=einzeln&status=abgewiesen&zeile=z-gw$/)
  await expect(page.getByRole('tab', { name: 'Besucher' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'Einzelaufrufe' })).toHaveAttribute('aria-selected', 'true')
  // Statische Seiten haben keinen Reiter «Logs» und keinen «Zugriffe» mehr
  await expect(page.getByRole('tab', { name: /^(Logs|Zugriffe)/ })).toHaveCount(0)
  await expect(page.locator('.acc-detail-title')).toContainText('2 Aufrufe')
  await page.context().close()
})

test('Alte Adressen …/zugriffe und ?tab=zugriffe → Einzelaufrufe', async ({ browser }) => {
  const page = await open(browser, '/projekte/p-hallo/zugriffe')
  await expect(page).toHaveURL(/\/projekte\/p-hallo\?tab=besucher&ansicht=einzeln$/)
  await expect(page.getByRole('tab', { name: 'Einzelaufrufe' })).toHaveAttribute('aria-selected', 'true')
  await page.goto(`http://localhost:${VISUAL_PORT}/projekte/p-hallo?tab=zugriffe&suche=wp`)
  await expect(page).toHaveURL(/[?&]tab=besucher&ansicht=einzeln&suche=wp$/)
  await page.context().close()
})

test('Container-Projekt: ?tab=logs bleibt der Reiter «Logs»', async ({ browser }) => {
  const page = await open(browser, '/projekte/p-foto?tab=logs')
  await expect(page.getByRole('tab', { name: /^Logs/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(/[?&]tab=logs$/)
  await page.context().close()
})
