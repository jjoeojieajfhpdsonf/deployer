/**
 * Referenz erfassen: https://cal.com/ bei 1440 px. Screenshots von Hero,
 * Feature-Karten und Preisbereich (nur zum Vergleich in docs, nicht in der
 * App) und die berechneten Styles der Bauteile als JSON.
 *
 *   pnpm --filter @deployer/web exec tsx design-shots/reference.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'

const here = fileURLToPath(new URL('.', import.meta.url))
const out = resolve(here, '../../../docs/prototype-cal/referenz')
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'de-CH', colorScheme: 'light' })
const page = await ctx.newPage()
// tsx/esbuild setzt __name() in Funktionen, die page.evaluate in den Browser schickt
await page.addInitScript({ content: 'window.__name = (f) => f' })
await page.goto('https://cal.com/', { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(1500)

// Cookie-Hinweise u. Ä. ausblenden (nur für saubere Bilder)
await page.addStyleTag({ content: '[id*="cookie" i],[class*="cookie" i],[aria-label*="cookie" i]{display:none!important}' })

// Einmal ganz nach unten scrollen, damit träge geladene Bereiche da sind
await page.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 700) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)) }
  window.scrollTo(0, 0)
})
await page.waitForTimeout(800)

async function shotAround(p: Page, file: string, find: () => Element | null) {
  const box = await p.evaluate((src) => {
    const el = (new Function(`return (${src})()`))() as Element | null
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { y: r.top + window.scrollY, h: r.height }
  }, find.toString())
  if (!box) { console.log(`– nicht gefunden: ${file}`); return }
  const y = Math.max(0, box.y - 40)
  await p.screenshot({ path: resolve(out, file), clip: { x: 0, y, width: 1440, height: Math.min(Math.max(box.h + 80, 700), 1200) }, fullPage: true })
  console.log(`✓ ${file}`)
}

await page.screenshot({ path: resolve(out, 'cal-hero.png'), clip: { x: 0, y: 0, width: 1440, height: 900 } })
console.log('✓ cal-hero.png')
// Feature-Karten: der erste Abschnitt mit mehreren weissen Karten mit Schatten
await shotAround(page, 'cal-features.png', () => {
  const cards = [...document.querySelectorAll('div,article,li,a')].filter((e) => {
    const s = getComputedStyle(e); const r = e.getBoundingClientRect()
    return s.boxShadow !== 'none' && r.width > 300 && r.height > 200 && r.top + scrollY > 900 && /rgb\(255, 255, 255\)|rgba\(255, 255, 255/.test(s.backgroundColor)
  })
  let el: Element | null = cards[0] ?? null
  while (el && el.parentElement && el.getBoundingClientRect().width < 1100) el = el.parentElement
  return el
})
// Berechnete Styles der Startseite (vor dem Wechsel auf /pricing)
const styles = await page.evaluate(collectStyles)
writeFileSync(resolve(out, 'styles.json'), JSON.stringify(styles, null, 2))
console.log(`cards ${styles.cards.length} · buttons ${styles.buttons.length} · badges ${styles.badges.length} · h1 ${styles.h1.length} · h2 ${styles.h2.length} · body ${styles.body.length}`)

// Die Startseite hat (Stand 9.11.2026) keinen Preisbereich mehr; die Preiskarten stehen auf /pricing
await page.goto('https://cal.com/pricing', { waitUntil: 'networkidle', timeout: 60_000 })
await page.addStyleTag({ content: '[id*="cookie" i],[class*="cookie" i],[aria-label*="cookie" i]{display:none!important}' })
await page.waitForTimeout(800)
await shotAround(page, 'cal-preise.png', () => {
  const price = [...document.querySelectorAll('span,div,p,h3,h4')].find((e) => e.children.length === 0 && /^\s*\$\s?\d+/.test(e.textContent ?? ''))
  let el: Element | null = price ?? null
  while (el && el.parentElement && el.getBoundingClientRect().width < 1100) el = el.parentElement
  return el
})
await browser.close()

/** Läuft im Browser: berechnete Styles je Bauteil (Karten, Buttons, Badges, Überschriften, Fliesstext). */
function collectStyles() {
  const pick = (e: Element) => {
    const s = getComputedStyle(e)
    const r = e.getBoundingClientRect()
    return {
      tag: e.tagName.toLowerCase(),
      w: Math.round(r.width), h: Math.round(r.height),
      radius: s.borderRadius, shadow: s.boxShadow, border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
      padding: s.padding, gap: s.gap, bg: s.backgroundColor, color: s.color,
      font: s.fontFamily.split(',')[0]!.replace(/["']/g, ''), size: s.fontSize, weight: s.fontWeight, ls: s.letterSpacing, lh: s.lineHeight,
    }
  }
  const visible = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const all = [...document.querySelectorAll('body *')].filter(visible)
  const isWhite = (c: string) => /rgba?\(255, 255, 255(, 1)?\)/.test(c)
  const cards = all.filter((e) => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return s.boxShadow !== 'none' && isWhite(s.backgroundColor) && r.width > 240 && r.height > 160 })
  const buttons = all.filter((e) => (e.tagName === 'A' || e.tagName === 'BUTTON') && (() => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return r.height >= 30 && r.height <= 56 && r.width < 320 && (s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.boxShadow !== 'none' || s.borderTopStyle !== 'none') && (e.textContent ?? '').trim().length > 1 })())
  const badges = all.filter((e) => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return r.height >= 18 && r.height <= 32 && r.width < 220 && parseFloat(s.borderRadius) >= 8 && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && e.children.length <= 2 && (e.textContent ?? '').trim().length > 1 && e.tagName !== 'A' && e.tagName !== 'BUTTON' })
  const heads = (sel: string) => [...document.querySelectorAll(sel)].filter(visible)
  const body = all.filter((e) => e.tagName === 'P' && (e.textContent ?? '').length > 60)
  const page = getComputedStyle(document.body)
  const main = [...document.querySelectorAll('main, body > div')].map((e) => getComputedStyle(e).backgroundColor).filter((c) => c !== 'rgba(0, 0, 0, 0)')
  return {
    page: { bg: page.backgroundColor, sectionBgs: [...new Set(main)].slice(0, 5) },
    cards: cards.map(pick), buttons: buttons.map(pick), badges: badges.map(pick),
    h1: heads('h1').map(pick), h2: heads('h2').map(pick), h3: heads('h3').map(pick), body: body.map(pick),
  }
}
