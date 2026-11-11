// Zuerst die feste Uhr, dann die Fixtures (sie rechnen beim Import mit Date.now())
import { FIXED_NOW } from './fixed-clock.js'
import { test, expect } from '@playwright/test'
import { contextOptions, installRoutes, openShot, shots } from '../design-shots/shoot.js'
import { VISUAL_PORT } from './playwright.config.js'
import { VISUAL_SCENES } from './scenes.js'

/** Hauptseiten und wichtige Zustände (Liste in visual/scenes.ts), je Hell und Dunkel. */
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
