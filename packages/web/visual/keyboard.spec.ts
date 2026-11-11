// Zuerst die feste Uhr, dann die Fixtures (sie rechnen beim Import mit Date.now())
import { FIXED_NOW } from './fixed-clock.js'
import { test, expect, type Browser, type Page } from '@playwright/test'
import { contextOptions, installRoutes, openShot, shots } from '../design-shots/shoot.js'
import { VISUAL_PORT } from './playwright.config.js'

/**
 * Bedienung nur mit der Tastatur: Menüs, Reiter, Befehlspalette, Dialoge.
 * Jeder Ablauf prüft auch, wo der Fokus danach steht (nie auf <body>).
 */

async function open(browser: Browser, scene: string): Promise<Page> {
  const s = shots.find((x) => x.name === scene)
  if (!s) throw new Error(`Szene ${scene} fehlt`)
  const ctx = await browser.newContext(contextOptions('light'))
  await installRoutes(ctx, { ...s, prepare: undefined }, 'light', VISUAL_PORT)
  const page = await ctx.newPage()
  await page.clock.setFixedTime(FIXED_NOW)
  await openShot(page, { ...s, prepare: undefined }, VISUAL_PORT)
  return page
}

const focused = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null
  return { tag: el?.tagName ?? null, label: el?.getAttribute('aria-label') ?? el?.textContent?.trim().slice(0, 40) ?? null, role: el?.getAttribute('role') ?? null }
})

test('Profilmenü: öffnen, Pfeiltasten, Esc gibt den Fokus zurück', async ({ browser }) => {
  const page = await open(browser, 'projekte')
  await page.locator('.profile-trigger').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu', { name: 'Profil' })).toBeVisible()
  expect((await focused(page)).role).toMatch(/menuitem/)
  const first = await focused(page)
  await page.keyboard.press('ArrowDown')
  expect((await focused(page)).label).not.toBe(first.label)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: 'Profil' })).toBeHidden()
  expect((await focused(page)).label).toMatch(/Profil-Menü/)
  await page.context().close()
})

test('Zeilenmenü einer Projektkarte: Enter öffnet, Esc schliesst', async ({ browser }) => {
  const page = await open(browser, 'projekte')
  const trigger = page.getByRole('button', { name: 'Aktionen für Haushaltsbuch' })
  await trigger.focus()
  await page.keyboard.press('Enter')
  expect((await focused(page)).role).toBe('menuitem')
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await page.context().close()
})

test('Rückfrage im Menü: Fokus auf die Antwort, Esc setzt zurück, Tab schliesst', async ({ browser }) => {
  const page = await open(browser, 'projekt-uebersicht')
  const trigger = page.getByRole('button', { name: 'Weitere Aktionen' })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const stop = page.getByRole('menuitem', { name: /^Stoppen/ })
  await stop.focus()
  await page.keyboard.press('Enter')
  // Der Eintrag «Stoppen …» ist weg – der Fokus steht auf der Antwort, nicht auf <body>
  await expect(page.getByRole('menuitem', { name: 'Ja, stoppen' })).toBeFocused()
  await expect(page.getByRole('menuitem', { name: 'Ja, stoppen' })).toHaveAttribute('aria-describedby', /menu-confirm-/)
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  // Wieder öffnen: normale Einträge, keine alte Rückfrage
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: /^Stoppen/ })).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('menu', { name: 'Weitere Aktionen' })).toBeHidden()
  await expect(trigger).toBeFocused()
  await page.context().close()
})

test('Reiter der Projektseite: Pfeiltasten wechseln und fokussieren', async ({ browser }) => {
  const page = await open(browser, 'projekt-uebersicht')
  await page.getByRole('tab', { name: /^Übersicht/ }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: /^Security/ })).toBeFocused()
  await expect(page.getByRole('tab', { name: /^Security/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('End')
  await expect(page.getByRole('tab', { name: /Einstellungen/ })).toBeFocused()
  await page.context().close()
})

test('Befehlspalette: öffnen, suchen, mit Enter zur Seite, Fokus im Inhalt', async ({ browser }) => {
  const page = await open(browser, 'projekte')
  await page.keyboard.press('ControlOrMeta+k')
  const box = page.getByRole('combobox', { name: 'Seite, Projekt oder Aktion suchen' })
  await expect(box).toBeFocused()
  await page.keyboard.type('audit')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/audit$/)
  await expect(page.getByRole('dialog', { name: 'Befehle und Suche' })).toBeHidden()
  // Fokus folgt im nächsten Frame nach dem close-Ereignis des Dialogs
  await expect.poll(async () => (await focused(page)).tag, { timeout: 2000 }).toBe('MAIN')
  await page.context().close()
})

test('Befehlspalette: Rückfrage «Offline nehmen», Esc führt zurück zur Liste', async ({ browser }) => {
  const page = await open(browser, 'projekte')
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('offline haus')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Abbrechen' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('combobox', { name: 'Seite, Projekt oder Aktion suchen' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Befehle und Suche' })).toBeHidden()
  await page.context().close()
})

test('Kürzel: «?» öffnet die Übersicht, Esc schliesst; «/» springt in die Suche; «g a» zum Audit-Log', async ({ browser }) => {
  const page = await open(browser, 'projekte')
  await page.locator('h1').click()
  await page.keyboard.press('Shift+?')
  await expect(page.getByRole('dialog', { name: 'Tastaturkürzel' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Tastaturkürzel' })).toBeHidden()
  await page.keyboard.press('/')
  await expect(page.getByRole('searchbox', { name: /Projekte durchsuchen/ })).toBeFocused()
  // Im Feld tippt «g» nur Text
  await page.keyboard.type('ga')
  await expect(page).toHaveURL(/\/projekte$/)
  await page.locator('h1').click()
  await page.keyboard.press('g')
  await page.keyboard.press('a')
  await expect(page).toHaveURL(/\/audit$/)
  await page.context().close()
})

test('Fokus ist überall sichtbar (Tab durch den Kopf)', async ({ browser }) => {
  const page = await open(browser, 'projekte')
  await page.locator('body').press('Tab')
  for (let i = 0; i < 6; i++) {
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement
      const cs = getComputedStyle(el)
      return { tag: el.tagName, outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2, ring: cs.boxShadow !== 'none' }
    })
    expect(outline.outline || outline.ring, `sichtbarer Fokus auf ${outline.tag}`).toBe(true)
    await page.keyboard.press('Tab')
  }
  await page.context().close()
})
