// Zuerst die feste Uhr, dann die Fixtures (sie rechnen beim Import mit Date.now())
import { FIXED_NOW } from './fixed-clock.js'
import { test, expect } from '@playwright/test'
import { contextOptions, installRoutes, openShot, shots } from '../design-shots/shoot.js'
import { VISUAL_PORT } from './playwright.config.js'
import { A11Y_SCENES } from './scenes.js'

/**
 * UI-Qualität 7: nichts unter 12 px. Geprüft wird die berechnete Schriftgrösse
 * jedes sichtbaren Elements mit eigenem Text, in allen Szenen.
 */
for (const name of A11Y_SCENES) {
  test(`Schrift ≥ 12 px · ${name}`, async ({ browser }) => {
    const s = shots.find((x) => x.name === name)!
    const ctx = await browser.newContext(contextOptions('light'))
    try {
      await installRoutes(ctx, s, 'light', VISUAL_PORT)
      const page = await ctx.newPage()
      await page.clock.setFixedTime(FIXED_NOW)
      await openShot(page, s, VISUAL_PORT)
      const small = await page.evaluate(() => {
        const out: string[] = []
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
          // Nur Elemente mit eigenem, sichtbarem Text (nicht nur Kinder)
          const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '')
          if (!own) continue
          const st = getComputedStyle(el)
          if (st.display === 'none' || st.visibility === 'hidden') continue
          const r = el.getBoundingClientRect()
          // sr-only (1×1 px) zählt nicht als sichtbar
          if (r.width <= 1 || r.height <= 1) continue
          const size = parseFloat(st.fontSize)
          if (size < 11.95) out.push(`${el.tagName.toLowerCase()}.${el.className} ${size}px «${(el.textContent ?? '').trim().slice(0, 30)}»`)
        }
        return [...new Set(out)].slice(0, 10)
      })
      expect(small, `Schrift unter 12 px in ${name}`).toEqual([])
    } finally {
      await ctx.close()
    }
  })
}
