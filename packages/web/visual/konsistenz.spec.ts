// Zuerst die feste Uhr, dann die Fixtures (sie rechnen beim Import mit Date.now())
import { FIXED_NOW } from './fixed-clock.js'
import { test, expect, type Browser, type Page } from '@playwright/test'
import { contextOptions, installRoutes, openShot, shots } from '../design-shots/shoot.js'
import { VISUAL_PORT } from './playwright.config.js'
import * as fx from '../design-shots/fixtures.js'

/**
 * UI-Qualität 1: Dieselbe Zahl offener Befunde und derselbe Zustand überall –
 * Kopf, Zähler-Pillen, Reiter-Badge, Seitenleiste, Projektkarte, Security-Karte.
 * Liest die Zahlen aus der fertigen Oberfläche und vergleicht sie miteinander.
 */

async function open(browser: Browser, path: string): Promise<Page> {
  const s = { ...shots.find((x) => x.name === 'projekte')!, path, prepare: undefined }
  const ctx = await browser.newContext(contextOptions('light'))
  await installRoutes(ctx, s, 'light', VISUAL_PORT)
  const page = await ctx.newPage()
  await page.clock.setFixedTime(FIXED_NOW)
  await openShot(page, s, VISUAL_PORT)
  return page
}

const num = (s: string | null) => Number((s ?? '').replace(/[^\d]/g, '') || 0)

for (const p of fx.allProjects.filter((x) => x.security && x.security.grade !== null)) {
  test(`offene Befunde stimmen überall überein · ${p.name}`, async ({ browser }) => {
    // Projektseite: Reiter-Badge und Security-Karte der Übersicht
    const page = await open(browser, `/projekte/${p.id}`)
    const tab = page.getByRole('tab', { name: /^Security/ })
    // Ohne offene Befunde zeigt der Reiter keinen Zähler (= 0)
    const badge = (await tab.locator('.tab-count').count()) ? num(await tab.locator('.tab-count').textContent()) : 0
    // Reiter Security: Summe der Zähler-Pillen
    await tab.click()
    await page.locator('.sev-chips').first().waitFor()
    const chips = await page.locator('.sev-chips').first().locator('.sev-chip-n').allTextContents()
    const perSev = chips.map(num)
    const chipSum = perSev.reduce((a, b) => a + b, 0)
    expect(chipSum, 'Zähler-Pillen = Reiter-Badge').toBe(badge)
    // Stufen: Summe der gefundenen Befunde je Stufe deckt die Befundliste (offen + akzeptiert)
    const listed = await page.locator('#befunde ~ * .finding, .finding').count()
    expect(listed).toBeGreaterThanOrEqual(chipSum)
    // Projektliste: Karte nennt dieselbe Zahl kritischer bzw. hoher Befunde (nur Projekte der Standardliste)
    if (!fx.projects.some((x) => x.id === p.id)) { await page.context().close(); return }
    await page.goto(`http://localhost:${VISUAL_PORT}/projekte`)
    await page.locator('.pcards').waitFor()
    const card = page.locator('.pcard').filter({ hasText: p.name }).first()
    const cell = (await card.locator('.grade-cell').textContent()) ?? ''
    const [crit, high] = perSev
    if (crit) expect(cell).toContain(`${crit} kritisch`)
    else if (high) expect(cell).toContain(`${high} hoch`)
    else expect(cell).not.toMatch(/kritisch|hoch/)
    await page.context().close()
  })
}

test('Seitenleiste und Security-Seite zählen dieselben kritischen und hohen Befunde', async ({ browser }) => {
  const page = await open(browser, '/security')
  await page.locator('.stats').waitFor()
  const statCrit = num(await page.locator('.stat').filter({ hasText: 'Kritisch' }).locator('.stat-value').textContent())
  const statHigh = num(await page.locator('.stat').filter({ hasText: 'Hoch' }).locator('.stat-value').textContent())
  const rail = num(await page.locator('.rail-nav a', { hasText: 'Security' }).locator('.rail-count').textContent().catch(() => '0'))
  expect(rail, 'Seitenleiste = kritisch + hoch').toBe(statCrit + statHigh)
  await page.context().close()
})

test('Kennzahl «laufen» = Zähler des Filters «Laufen»', async ({ browser }) => {
  const page = await open(browser, '/projekte')
  await page.locator('.stats').waitFor()
  const sub = (await page.locator('.stat').filter({ hasText: 'Projekte' }).first().locator('.stat-sub').textContent()) ?? ''
  const stat = Number(/(\d+) laufen/.exec(sub)?.[1] ?? -1)
  const filter = num(await page.getByRole('button', { name: /^Laufen/ }).locator('.num').textContent())
  expect(stat).toBe(filter)
  await page.context().close()
})

test('Tab-Titel: Seite bzw. Projekt · Airlock, mit Präfix für laufende Vorgänge; Favicon-Punkt', async ({ browser }) => {
  const page = await open(browser, '/projekte/p-foto')
  // In den Fixtures laufen zwei Vorgänge (Deploy Rezepte-API, Zertifikat) – wie die Anzeige im Kopf
  const n = num(await page.locator('.activity-trigger, [aria-label$="Vorgänge laufen"]').first().textContent().catch(() => '0'))
  const expected = n > 1 ? `${n} Vorgänge laufen · Fotoalbum · Airlock` : n === 1 ? /läuft · Fotoalbum · Airlock$|wird .* · Fotoalbum · Airlock$/ : 'Fotoalbum · Airlock'
  await expect(page).toHaveTitle(expected)
  // Gescheiterter Deploy (Wetterstation) und kritischer Befund (Kontoauszug): Punkt im Favicon
  const icon = await page.locator('link[rel="icon"]').getAttribute('href')
  expect(decodeURIComponent(icon ?? '')).toContain('<circle')
  await page.context().close()
})

test('Zustand: Pille der Karte = Pille im Projektkopf', async ({ browser }) => {
  const page = await open(browser, '/projekte')
  await page.locator('.pcards').waitFor()
  for (const p of fx.projects) {
    const card = page.locator('.pcard').filter({ hasText: p.name }).first()
    await expect(card.locator('.status')).toHaveText(p.state.label)
  }
  await page.goto(`http://localhost:${VISUAL_PORT}/projekte/p-wetter`)
  await expect(page.locator('.page-head .status, h1 + .status').first()).toHaveText('neue Version gescheitert, alte läuft weiter')
  await page.context().close()
})
