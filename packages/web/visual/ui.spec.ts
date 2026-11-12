// Zuerst die feste Uhr, dann die Fixtures (sie rechnen beim Import mit Date.now())
import { FIXED_NOW } from './fixed-clock.js'
import { test, expect } from '@playwright/test'
import { contextOptions, installRoutes, openShot, shots } from '../design-shots/shoot.js'
import { VISUAL_PORT } from './playwright.config.js'
import { TERMINAL_SCENES, VISUAL_SCENES, WIN95_SCENES } from './scenes.js'

/** Hauptseiten und wichtige Zustände (Liste in visual/scenes.ts), je Hell und Dunkel; einige auch in «Windows 95». */
const RUNS = [
  { theme: 'hell', t: 'light', scenes: VISUAL_SCENES },
  { theme: 'dunkel', t: 'dark', scenes: VISUAL_SCENES },
  { theme: 'win95', t: 'win95', scenes: WIN95_SCENES },
  { theme: 'terminal', t: 'terminal', scenes: TERMINAL_SCENES },
] as const
for (const { theme, t, scenes } of RUNS) {
  for (const name of scenes) {
    test(`${name} · ${theme}`, async ({ browser }) => {
      const s = shots.find((x) => x.name === name)
      if (!s) throw new Error(`Szene ${name} fehlt in design-shots/shoot.ts`)
      const ctx = await browser.newContext(contextOptions(t))
      try {
        await installRoutes(ctx, s, t, VISUAL_PORT)
        const page = await ctx.newPage()
        await page.clock.setFixedTime(FIXED_NOW)
        await openShot(page, s, VISUAL_PORT)
        // Scroll-Spy der Sprungnavigation (Einstellungen) setzt den aktiven Eintrag kurz nach dem Laden
        await page.waitForTimeout(300)
        const file = `${name}-${theme}.png`
        const tol = s.maxDiff ? { maxDiffPixels: s.maxDiff } : {}
        if (s.el) await expect(page.locator(s.el).first()).toHaveScreenshot(file, tol)
        else await expect(page).toHaveScreenshot(file, { fullPage: s.full !== false, ...tol })
      } finally {
        await ctx.close()
      }
    })
  }
}
