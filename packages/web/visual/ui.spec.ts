// Zuerst die feste Uhr, dann die Fixtures (sie rechnen beim Import mit Date.now())
import { FIXED_NOW } from './fixed-clock.js'
import { test, expect } from '@playwright/test'
import { contextOptions, installRoutes, openShot, shots } from '../design-shots/shoot.js'
import { VISUAL_PORT } from './playwright.config.js'

/**
 * Hauptseiten und wichtige Zustände (Namen aus design-shots/shoot.ts).
 * Neue Ansicht: Szene in shoot.ts anlegen, Namen hier eintragen,
 * `pnpm test:visual:update` und die neuen Bilder bewusst ansehen.
 */
export const VISUAL_SCENES = [
  // Shell und Anmeldung
  'login', 'shell-profilmenue',
  // Projekte
  'projekte', 'projekt-uebersicht', 'projekt-fehler', 'projekt-deployments', 'projekt-logs', '5-zugriffe',
  'projekt-security', 'projekt-security-laeuft', 'projekt-einstellungen', 'veroeffentlichung-live', 'veroeffentlichung-pausiert',
  'neues-projekt-validierung', 'projekte-anzahl-0', 'projekte-anzahl-1',
  // Verwaltung und Security
  'security-global', 'externe-ziele', 'domains', 'tokens', 'audit', 'konto',
  // System
  'system-uebersicht', 'system-cloudflare', 'system-benachrichtigungen', 'system-github', 'pauseseite-vorlage',
  // Zustände (Etappe 1) und Rückmeldung (Etappe 2)
  'nicht-gefunden', 'fehlerseite', 'api-offline', 'laden-projekte', 'leer-projekte',
  'zustand-laden-projektseite', 'zustand-laden-audit', 'zustand-fehler-projekte', 'zustand-fehler-karte',
  'zustand-leer-audit', 'zustand-teilweise-scan', 'zustand-veraltet',
  'bestaetigung-stoppen', 'aktion-vorgaenge', 'aktion-knopf-laedt',
  // Komponenten-Übersicht (Etappe 4), Befehlspalette und Kürzel (Etappe 6)
  'design-bausteine', 'palette', 'palette-offline', 'kuerzel',
] as const

for (const theme of ['hell', 'dunkel'] as const) {
  const t = theme === 'hell' ? 'light' : 'dark'
  for (const name of VISUAL_SCENES) {
    test(`${name} · ${theme}`, async ({ browser }) => {
      const s = shots.find((x) => x.name === name)
      if (!s) throw new Error(`Szene ${name} fehlt in design-shots/shoot.ts`)
      const ctx = await browser.newContext(contextOptions(t))
      try {
        await installRoutes(ctx, s, t, VISUAL_PORT)
        const page = await ctx.newPage()
        await page.clock.setFixedTime(FIXED_NOW)
        await openShot(page, s, VISUAL_PORT)
        const file = `${name}-${theme}.png`
        if (s.el) await expect(page.locator(s.el).first()).toHaveScreenshot(file)
        else await expect(page).toHaveScreenshot(file, { fullPage: s.full !== false })
      } finally {
        await ctx.close()
      }
    })
  }
}
