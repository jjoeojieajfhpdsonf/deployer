/**
 * Vergleichsbilder: Prototyp-Screenshot (links) neben dem passenden
 * cal.com-Ausschnitt (rechts), je Hell und Dunkel, 1440 px breit.
 * Erwartet die Bilder von shoot.ts und reference.ts in docs/prototype-cal.
 *
 *   pnpm --filter @deployer/web exec tsx design-shots/compare.ts
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = fileURLToPath(new URL('.', import.meta.url))
const docs = resolve(here, '../../../docs/prototype-cal')
const img = (f: string) => `data:image/png;base64,${readFileSync(resolve(docs, f)).toString('base64')}`

/** Welche Prototyp-Seite neben welchem cal.com-Ausschnitt – und worauf es dabei ankommt */
const pairs: { key: string; proto: string; ref: string; what: string }[] = [
  { key: 'projekte', proto: '01-projekte', ref: 'cal-preise.png', what: 'Karten im Raster, eine dunkle hervorgehobene Karte, Buttons' },
  { key: 'projektdetail', proto: '02-projekt-uebersicht', ref: 'cal-features.png', what: 'grosse weisse Karten, eingelassene Felder, Titel' },
  { key: 'security', proto: '03-projekt-security', ref: 'cal-preise.png', what: 'Karten pro Eintrag, Pillen statt Rahmen' },
  { key: 'system', proto: '04-system-cloudflare', ref: 'cal-features.png', what: 'Schritte als Karten: eine aktive weisse, die übrigen zurückgenommen' },
  { key: 'formular', proto: '05-formular-validierung', ref: 'cal-hero.png', what: 'Buttons, Felder, Titel' },
  { key: 'kopf', proto: '06-profilmenue', ref: 'cal-hero.png', what: 'Kopfzeile, Navigation, Primär-Button' },
]

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
for (const p of pairs) {
  for (const theme of ['hell', 'dunkel'] as const) {
    const dark = theme === 'dunkel'
    await page.setContent(`<!doctype html><html><body style="margin:0;background:${dark ? '#0a0a0b' : '#e5e7eb'};font:500 14px/1.4 system-ui;color:${dark ? '#c4c4c8' : '#374151'}">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px">
        <figure style="margin:0"><figcaption style="margin:0 0 8px">deployer · Prototyp «cal» · ${theme}</figcaption>
          <div style="height:1100px;overflow:hidden;border-radius:12px;box-shadow:0 0 0 1px rgba(127,127,127,.25)"><img src="${img(`${p.proto}-${theme}-desktop.png`)}" style="width:100%;display:block"></div></figure>
        <figure style="margin:0"><figcaption style="margin:0 0 8px">Referenz cal.com · ${p.what}</figcaption>
          <div style="height:1100px;overflow:hidden;border-radius:12px;background:#fff;box-shadow:0 0 0 1px rgba(127,127,127,.25)"><img src="${img(`referenz/${p.ref}`)}" style="width:100%;display:block"></div></figure>
      </div></body></html>`)
    await page.waitForTimeout(100)
    const file = resolve(docs, `vergleich-${p.key}-${theme}.png`)
    await page.screenshot({ path: file, fullPage: true })
    console.log(`✓ vergleich-${p.key}-${theme}.png`)
  }
}
await browser.close()
