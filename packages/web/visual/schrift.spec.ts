// Zuerst die feste Uhr, dann die Fixtures (sie rechnen beim Import mit Date.now())
import { FIXED_NOW } from './fixed-clock.js'
import { test, expect, type Page } from '@playwright/test'
import { contextOptions, installRoutes, openShot, shots } from '../design-shots/shoot.js'
import { VISUAL_PORT } from './playwright.config.js'
import { A11Y_SCENES } from './scenes.js'

/**
 * UI-Qualität 7: nichts unter 12 px. Geprüft wird die berechnete Schriftgrösse
 * jedes sichtbaren Elements mit eigenem Text, jedes Formularfelds (Wert und
 * Platzhalter) und jedes ::before/::after mit Inhalt – in allen Szenen und
 * zusätzlich mit eingeklappter Seitenleiste.
 */
const small = (page: Page) => page.evaluate(() => {
  const out: string[] = []
  const tooSmall = (px: string) => parseFloat(px) < 12
  const visible = (el: Element) => {
    const st = getComputedStyle(el)
    if (st.display === 'none' || st.visibility === 'hidden') return false
    const r = el.getBoundingClientRect()
    // sr-only (1×1 px) zählt nicht als sichtbar
    return r.width > 1 && r.height > 1
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
    if (!visible(el)) continue
    const st = getComputedStyle(el)
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '')
    const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
    if ((own || field) && tooSmall(st.fontSize)) out.push(`${el.tagName.toLowerCase()}.${el.className} ${st.fontSize} «${(el.textContent ?? (el as HTMLInputElement).placeholder ?? '').trim().slice(0, 30)}»`)
    for (const pseudo of ['::before', '::after'] as const) {
      const ps = getComputedStyle(el, pseudo)
      // Nur Pseudo-Elemente mit Text (nicht leere Flächen wie Punkte aus Hintergrundfarbe)
      const content = ps.content.replace(/^["']|["']$/g, '')
      if (ps.content === 'none' || ps.content === 'normal' || content.trim() === '') continue
      if (tooSmall(ps.fontSize)) out.push(`${el.tagName.toLowerCase()}.${el.className}${pseudo} ${ps.fontSize} «${content.slice(0, 20)}»`)
    }
  }
  return [...new Set(out)].slice(0, 10)
})

async function check(name: string, collapsed = false) {
  return async ({ browser }: { browser: import('@playwright/test').Browser }) => {
    const s = shots.find((x) => x.name === name)!
    const ctx = await browser.newContext(contextOptions('light'))
    try {
      await installRoutes(ctx, s, 'light', VISUAL_PORT)
      if (collapsed) await ctx.addInitScript({ content: "try { localStorage.setItem('airlock.rail.collapsed', '1') } catch {}" })
      const page = await ctx.newPage()
      await page.clock.setFixedTime(FIXED_NOW)
      await openShot(page, s, VISUAL_PORT)
      expect(await small(page), `Schrift unter 12 px in ${name}${collapsed ? ' (Seitenleiste eingeklappt)' : ''}`).toEqual([])
    } finally {
      await ctx.close()
    }
  }
}

for (const name of A11Y_SCENES) test(`Schrift ≥ 12 px · ${name}`, await check(name))
test('Schrift ≥ 12 px · Seitenleiste eingeklappt', await check('projekte', true))
