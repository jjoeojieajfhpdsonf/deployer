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

test('Umschalter der Umgebung: Name im Knopf, Enter öffnet, Esc gibt den Fokus zurück', async ({ browser }) => {
  const page = await open(browser, 'm9-umschalter-domain')
  const trigger = page.getByRole('button', { name: 'Umgebung: VB Verein, verein-beispiel.ch – wechseln' })
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu', { name: 'Umgebungen' })).toBeVisible()
  expect((await focused(page)).role).toMatch(/menuitem/)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: 'Umgebungen' })).toBeHidden()
  await expect(trigger).toBeFocused()
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
  // Reihenfolge: Übersicht · Aufbau · Deployments · Logs · Security · Einstellungen
  await expect(page.getByRole('tab', { name: /^Aufbau/ })).toBeFocused()
  await expect(page.getByRole('tab', { name: /^Aufbau/ })).toHaveAttribute('aria-selected', 'true')
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

/* --- UI-Qualität 6: neue Orte ------------------------------------------------------- */

test('Security: Reiter «Externe Ziele» per Tastatur, Adresse und Brotkrumen stimmen', async ({ browser }) => {
  const page = await open(browser, 'security-global')
  await page.getByRole('link', { name: 'Externe Ziele' }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/security\/extern$/)
  await expect(page.getByRole('link', { name: 'Externe Ziele' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('navigation', { name: 'Pfad' })).toContainText('Airlock›Security›Externe Ziele')
  await page.context().close()
})

test('/domains leitet weiter: Einstellungen › Cloudflare & HTTPS der Umgebung, Fokus auf der Überschrift «Domains»', async ({ browser }) => {
  const page = await open(browser, 'domains')
  await expect(page).toHaveURL(/\/u\/example\/einstellungen\/cloudflare#domains$/)
  await expect.poll(async () => (await focused(page)).label).toBe('Domains')
  await page.context().close()
})

test('Cloudflare: Zusammenfassung ↔ Einrichtung, der Fokus bleibt nie auf <body>', async ({ browser }) => {
  const page = await open(browser, 'system-cloudflare-fertig')
  await page.getByRole('button', { name: 'Einrichtung anzeigen' }).focus()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await focused(page)).label).toBe('Zusammenfassung anzeigen')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await focused(page)).label).toMatch(/Cloudflare ist eingerichtet/)
  await page.context().close()
})

test('Cloudflare: «Token ersetzen» aus der Zusammenfassung fokussiert das Feld, «Abbrechen» führt zurück', async ({ browser }) => {
  const page = await open(browser, 'system-cloudflare-fertig')
  await page.getByRole('button', { name: 'Token ersetzen' }).click()
  await expect.poll(async () => (await focused(page)).tag).toBe('INPUT')
  await page.getByRole('button', { name: 'Abbrechen' }).click()
  await expect(page.getByRole('heading', { name: /Cloudflare ist eingerichtet/ })).toBeVisible()
  await expect.poll(async () => (await focused(page)).label).toMatch(/Cloudflare ist eingerichtet/)
  await page.context().close()
})

test('Fehlerbox «Grenze erhöhen» per Tastatur: Einstellungen › Container, RAM fokussiert mit dem Vorschlag', async ({ browser }) => {
  const page = await open(browser, 'fehler-speicher')
  await page.getByRole('button', { name: 'Grenze erhöhen' }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/tab=einstellungen/)
  const ram = page.locator('#ct-memoryLimitMb')
  await expect(ram).toBeFocused()
  // 512 MB verdoppelt; der Server hat genug frei
  await expect(ram).toHaveValue('1024')
  // «Abbrechen» zeigt wieder den gespeicherten Wert; der Fokus geht auf «Bearbeiten», nicht auf <body>
  await page.locator('#set-container').getByRole('button', { name: 'Abbrechen' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#set-container')).toContainText('512 MB')
  await expect(page.locator('#set-container').getByRole('button', { name: 'Bearbeiten' })).toBeFocused()
  await page.context().close()
})

test('ZAP-Befund zur CSP-Qualität: «Zum CSP-Ablauf» wechselt zu «Header & CSP» und fokussiert die CSP', async ({ browser }) => {
  const page = await open(browser, 'security-csp-qualitaet')
  await page.locator('.sec-row', { hasText: 'CSP: Failure to Define Directive' }).click()
  await page.locator('.sec-detail').getByRole('button', { name: 'Zum CSP-Ablauf' }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/ansicht=header/)
  await expect(page.locator('#header-caddy-csp-title')).toBeFocused()
  await page.context().close()
})

test('Security: Unternavigation mit Pfeiltasten, Befundliste mit Pfeiltasten, Enter in die Detailkarte', async ({ browser }) => {
  const page = await open(browser, 'projekt-security')
  // Segmente: Pfeil rechts wechselt die Ansicht (in der Adresse), Ende springt zu «Verlauf»
  await page.locator('#sec-tab-befunde').focus()
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/ansicht=header/)
  await expect(page.locator('#sec-tab-header')).toBeFocused()
  await page.keyboard.press('End')
  await expect(page).toHaveURL(/ansicht=verlauf/)
  await page.keyboard.press('Home')
  await expect(page).not.toHaveURL(/ansicht=/)
  // Liste: der schwerste Befund ist gewählt; Pfeil runter wählt den nächsten und zeigt ihn rechts
  const rows = page.locator('.sec-row')
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true')
  await rows.first().focus()
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(1)).toBeFocused()
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
  const title = (await rows.nth(1).locator('.sec-row-title').textContent()) ?? ''
  await expect(page.locator('.sec-detail-title')).toHaveText(title)
  await page.keyboard.press('Enter')
  await expect(page.locator('.sec-detail-title')).toBeFocused()
  await page.context().close()
})

test('Security unter 1100 px: Detail als Schublade, Escape schliesst und gibt den Fokus an die Zeile zurück', async ({ browser }) => {
  const page = await open(browser, 'projekt-security')
  await page.setViewportSize({ width: 1000, height: 900 })
  const row = page.locator('.sec-row').nth(1)
  await row.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.sec-drawer')).toHaveAttribute('data-open', 'true')
  await expect(page.locator('.sec-detail-title')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('.sec-drawer')).toHaveAttribute('data-open', 'false')
  await expect(row).toBeFocused()
  await page.context().close()
})

/* --- Antwort 12: ungespeicherte Änderungen, auch beim Zurück-Knopf des Browsers ------- */

test('Zurück im Browser mit ungespeicherten Änderungen: Rückfrage, Esc bleibt, «Verwerfen und weiter» geht zurück', async ({ browser }) => {
  const page = await open(browser, 'domains')
  await page.locator('td.cell-main').getByRole('link', { name: 'Haushaltsbuch' }).click()
  await expect(page).toHaveURL(/\/projekte\/[^/?]+\?tab=einstellungen$/)
  await page.locator('#set-umgebung').getByRole('button', { name: 'Variable hinzufügen' }).click()
  const name = page.locator('#set-umgebung .env-row').last().locator('input').first()
  await name.fill('API_KEY')
  const dialog = page.getByRole('dialog', { name: 'Änderungen verwerfen?' })
  const stay = dialog.getByRole('button', { name: 'Weiter bearbeiten' })
  await page.goBack()
  await expect(dialog).toBeVisible()
  await expect(stay).toBeFocused()
  // Esc = bleiben: Adresse und Eingabe unverändert, Fokus zurück im Feld
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/\?tab=einstellungen$/)
  await expect(name).toHaveValue('API_KEY')
  await expect(name).toBeFocused()
  // Noch einmal zurück, diesmal verwerfen: die Seite davor, keine zweite Rückfrage
  await page.goBack()
  await expect(dialog).toBeVisible()
  // Bleibt offen: das verspätete close-Ereignis der ersten Runde beantwortet die zweite nicht
  await page.waitForTimeout(100)
  await expect(dialog).toBeVisible()
  // Erst wenn der Fokus auf der sicheren Wahl steht (nächster Frame), weiter mit Tab
  await expect(stay).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Verwerfen und weiter' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/einstellungen\/cloudflare#domains$/)
  await page.waitForTimeout(300)
  await expect(dialog).toBeHidden()
  await page.context().close()
})

test('Reiterwechsel mit ungespeicherten Änderungen: genau eine Rückfrage', async ({ browser }) => {
  const page = await open(browser, 'projekt-einstellungen')
  await page.locator('#set-umgebung').getByRole('button', { name: 'Variable hinzufügen' }).click()
  await page.locator('#set-umgebung .env-row').last().locator('input').first().fill('API_KEY')
  const dialog = page.getByRole('dialog', { name: 'Änderungen verwerfen?' })
  await page.getByRole('tab', { name: /^Übersicht/ }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Verwerfen und weiter' }).click()
  await expect(page.getByRole('tab', { name: /^Übersicht/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page).not.toHaveURL(/tab=/)
  // Der Wechsel nach der Rückfrage läuft am Blocker vorbei (kein zweiter Dialog)
  await page.waitForTimeout(300)
  await expect(dialog).toBeHidden()
  await page.context().close()
})

test('Öffentliche Statusseite: ein Tab-Halt je Verlauf, Pfeiltasten wechseln den Tag, Tooltip sichtbar, Esc blendet ihn aus', async ({ browser }) => {
  const page = await open(browser, 'statusseite-oeffentlich')
  // Tab: Sprunglink, dann der heutige Tag des ersten Verlaufs (Störungen haben keine Bedienelemente)
  await page.keyboard.press('Tab')
  expect((await focused(page)).label).toBe('Zu den Diensten')
  await page.keyboard.press('Tab')
  const first = page.locator('.days').first()
  const today = first.locator('.day').last()
  await expect(today).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  const yesterday = first.locator('.day').nth(-2)
  await expect(yesterday).toBeFocused()
  await expect(yesterday.locator('.tip')).toHaveCSS('opacity', '1')
  expect(await first.locator('.day[tabindex="0"]').count()).toBe(1)
  await page.keyboard.press('Escape')
  await expect(yesterday.locator('.tip')).toHaveCSS('opacity', '0')
  await page.keyboard.press('Home')
  await expect(first.locator('.day').first()).toBeFocused()
  await expect(first.locator('.day').first().locator('.tip')).toContainText('keine Daten')
  // Nächster Tab: der nächste Verlauf (nicht 90 Tage einzeln)
  await page.keyboard.press('Tab')
  await expect(page.locator('.days').nth(1).locator('.day').last()).toBeFocused()
  await page.context().close()
})

test('Besucher: Ansicht per Pfeiltaste, Filter bleiben beim Wechsel', async ({ browser }) => {
  const page = await open(browser, 'besucher-heute')
  const evaluation = page.getByRole('tab', { name: 'Auswertung' })
  await evaluation.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Einzelaufrufe' })).toBeFocused()
  await expect(page).toHaveURL(/zeitraum=heute&ansicht=einzeln|ansicht=einzeln.*zeitraum=heute/)
  await expect(page.getByRole('group', { name: 'Zeitraum' }).getByRole('button', { name: 'Heute' })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('tab', { name: 'Auswertung' })).toBeFocused()
  await expect(page).not.toHaveURL(/ansicht=/)
  await page.context().close()
})

test('Besucher: Zeile der Auswertung per Tab und Enter → Einzelaufrufe mit Chip; ✕ entfernt den Filter', async ({ browser }) => {
  const page = await open(browser, 'besucher')
  const first = page.getByRole('list', { name: 'Länder' }).getByRole('link').first()
  await first.focus()
  await expect(first).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/ansicht=einzeln&land=CH/)
  await expect(page.getByRole('tab', { name: 'Einzelaufrufe' })).toHaveAttribute('aria-selected', 'true')
  const chip = page.getByRole('button', { name: /^Land: Schweiz/ })
  await expect(chip).toBeVisible()
  await chip.focus()
  await page.keyboard.press('Enter')
  await expect(page).not.toHaveURL(/land=/)
  await expect(page.getByRole('button', { name: /^Land: Schweiz/ })).toHaveCount(0)
  await page.context().close()
})

test('Besucher: Land auf der Karte ist ein Link (Enter öffnet die Einzelaufrufe)', async ({ browser }) => {
  const page = await open(browser, 'besucher')
  await page.getByRole('link', { name: /^Deutschland:.*Einzelaufrufe/ }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/ansicht=einzeln&land=DE/)
  await page.context().close()
})

test('Besucher: Karte zoomen per Knopf und Tasten, Pfeile verschieben, 0 setzt zurück', async ({ browser }) => {
  const page = await open(browser, 'besucher')
  const svg = page.locator('.vs-map-plot > svg')
  const world = await svg.getAttribute('viewBox')
  const zoom = page.getByRole('group', { name: 'Kartenzoom' })
  const reset = zoom.getByRole('button', { name: 'Ganzer Ausschnitt Welt' })
  await expect(reset).toHaveAttribute('aria-disabled', 'true')
  // Auf einem Land: + vergrössert um dieses Land, Pfeil verschiebt, 0 zurück zur Welt; der Fokus bleibt auf dem Land
  const de = page.getByRole('link', { name: /^Deutschland:/ })
  await de.focus()
  await page.keyboard.press('+')
  await page.keyboard.press('+')
  await expect(reset).toHaveAttribute('aria-disabled', 'false')
  const zoomed = await svg.getAttribute('viewBox')
  expect(zoomed).not.toBe(world)
  await page.keyboard.press('ArrowRight')
  await expect(svg).not.toHaveAttribute('viewBox', zoomed!)
  await expect(de).toBeFocused()
  await page.keyboard.press('0')
  await expect(svg).toHaveAttribute('viewBox', world!)
  await expect(de).toBeFocused()
  // Knöpfe: Vergrössern per Enter, «Ganzer Ausschnitt» zurück; an der Grenze bleibt der Fokus
  const minus = zoom.getByRole('button', { name: 'Verkleinern' })
  await zoom.getByRole('button', { name: 'Vergrössern' }).focus()
  await page.keyboard.press('Enter')
  await expect(svg).not.toHaveAttribute('viewBox', world!)
  await minus.focus()
  await page.keyboard.press('Enter')
  await expect(svg).toHaveAttribute('viewBox', world!)
  await expect(minus).toHaveAttribute('aria-disabled', 'true')
  await expect(minus).toBeFocused()
  await page.context().close()
})

test('Einzelaufrufe: Menü «Anzeige» per Tastatur, Zahl am Knopf, Esc gibt den Fokus zurück', async ({ browser }) => {
  const page = await open(browser, 'einzelaufrufe')
  const trigger = page.getByRole('button', { name: /^Anzeige/ })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu', { name: 'Anzeige der Einzelaufrufe' })
  await expect(menu).toBeVisible()
  expect((await focused(page)).role).toBe('menuitemcheckbox')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/bots=1/)
  await expect(menu.getByRole('menuitemcheckbox', { name: /^Bots zeigen/ })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()
  await expect(trigger).toHaveAccessibleName(/eine Einstellung geändert/)
  await page.context().close()
})

test('Besucher: «Wie gezählt wird» öffnet per Enter, Esc schliesst und gibt den Fokus zurück', async ({ browser }) => {
  const page = await open(browser, 'besucher')
  const btn = page.getByRole('button', { name: /^Wie gezählt wird/ })
  await btn.focus()
  await page.keyboard.press('Enter')
  await expect(btn).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('region', { name: 'Wie gezählt wird' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(btn).toHaveAttribute('aria-expanded', 'false')
  await expect(btn).toBeFocused()
  await page.context().close()
})

test('Einzelaufrufe: Pfeiltasten wechseln die Zeile (Adresse folgt), Enter setzt den Fokus ins Detail', async ({ browser }) => {
  const page = await open(browser, 'einzelaufrufe')
  const selected = page.locator('.acc-row[aria-current="true"]')
  await selected.focus()
  await expect(page.locator('.acc-detail-title')).toContainText('2 Aufrufe')
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.acc-row[aria-current="true"]')).toBeFocused()
  await expect(page.locator('.acc-detail-title')).toContainText('GET / um')
  await expect(page).toHaveURL(/zeile=z-iphone/)
  await page.keyboard.press('ArrowUp')
  await expect(page).toHaveURL(/zeile=z-gw/)
  await page.keyboard.press('Home')
  await expect(page).toHaveURL(/zeile=z-neu/)
  await page.keyboard.press('Enter')
  await expect(page.locator('.acc-detail-title')).toBeFocused()
  // Nur ein Tab-Stopp in der Tabelle (roving tabindex)
  expect(await page.locator('.acc-row[tabindex="0"]').count()).toBe(1)
  await page.context().close()
})

test('Kürzel «g s» führt zu Security', async ({ browser }) => {
  const page = await open(browser, 'projekte')
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('g')
  await page.keyboard.press('s')
  await expect(page).toHaveURL(/\/security$/)
  await page.context().close()
})
