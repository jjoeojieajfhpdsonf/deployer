// Zuerst die feste Uhr, dann die Fixtures (sie rechnen beim Import mit Date.now())
import { FIXED_NOW } from './fixed-clock.js'
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { contextOptions, installRoutes, openShot, shots } from '../design-shots/shoot.js'
import { VISUAL_PORT } from './playwright.config.js'
import { A11Y_SCENES, TERMINAL_SCENES, WIN95_SCENES } from './scenes.js'

/**
 * Barrierefreiheit mit axe-core: alle Hauptseiten und Zustände in Hell und
 * Dunkel, Regeln WCAG 2.2 A/AA. Jeder Befund lässt den Test scheitern; die
 * Meldung nennt Regel, Wirkung, Element und Hilfe-Link.
 */
// Dazu die Best-Practice-Regeln (Überschriftenfolge, Landmarks, ein h1); «incomplete» wird protokolliert
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

const RUNS = [
  { theme: 'hell', t: 'light', scenes: A11Y_SCENES },
  { theme: 'dunkel', t: 'dark', scenes: A11Y_SCENES },
  // Verstecktes Theme «Windows 95»: dieselben Regeln
  { theme: 'win95', t: 'win95', scenes: WIN95_SCENES },
  // Etappe 7: verstecktes Theme «Terminal»
  { theme: 'terminal', t: 'terminal', scenes: TERMINAL_SCENES },
] as const
for (const { theme, t, scenes } of RUNS) {
  for (const name of scenes) {
    test(`axe · ${name} · ${theme}`, async ({ browser }) => {
      const s = shots.find((x) => x.name === name)
      if (!s) throw new Error(`Szene ${name} fehlt in design-shots/shoot.ts`)
      const ctx = await browser.newContext(contextOptions(t))
      try {
        await installRoutes(ctx, s, t, VISUAL_PORT)
        const page = await ctx.newPage()
        await page.clock.setFixedTime(FIXED_NOW)
        await openShot(page, s, VISUAL_PORT)
        // Die Vorschau der Pause-Seite ist Inhalt des Nutzers in einem abgeschotteten iframe
        // (sandbox ohne Skripte) – nicht Teil der Oberfläche, axe käme dort ohnehin nicht hinein
        const result = await new AxeBuilder({ page }).withTags(TAGS).exclude('iframe[sandbox]').analyze()
        // Nicht entscheidbare Prüfungen (meist Kontrast auf Verläufen) im Bericht vermerken
        if (result.incomplete.length) test.info().annotations.push({ type: 'axe-unvollständig', description: result.incomplete.map((v) => `${v.id}: ${v.nodes.length}`).join(', ') })
        const report = result.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join('\n  ')}\n  ${v.helpUrl}`)
        expect(report, `axe-Befunde in ${name} · ${theme}`).toEqual([])
      } finally {
        await ctx.close()
      }
    })
  }
}
