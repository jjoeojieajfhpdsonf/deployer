/**
 * Vergleichsbilder: Airlock (links) neben dem passenden cal.com-Ausschnitt
 * (rechts), je Hell und Dunkel, 1440 px breit. Erwartet die Bilder von
 * shoot.ts (--out docs/design-cal/aktuell) und reference.ts (docs/prototype-cal/referenz).
 *
 *   pnpm --filter @airlock/web exec tsx design-shots/compare.ts
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = resolve(here, '../../..')
const shots = resolve(repo, 'docs/design-cal/aktuell')
const refs = resolve(repo, 'docs/prototype-cal/referenz')
const out = resolve(repo, 'docs/design-cal')
const img = (p: string) => `data:image/png;base64,${readFileSync(p).toString('base64')}`

/** Welche Seite neben welchem cal.com-Ausschnitt – und worauf es dabei ankommt */
const pairs: { key: string; shot: string; ref: string; what: string }[] = [
  { key: 'projekte', shot: 'projekte', ref: 'cal-preise.png', what: 'Karten im Raster, Bento-Kennzahlen, Buttons' },
  { key: 'projektdetail', shot: 'projekt-uebersicht', ref: 'cal-features.png', what: 'grosse weisse Karten, eingelassene Felder' },
  { key: 'security', shot: 'projekt-security', ref: 'cal-preise.png', what: 'Bento-Ergebnis, Pillen statt Rahmen' },
  { key: 'system', shot: 'system-cloudflare', ref: 'cal-features.png', what: 'Schritte als Karten: aktiv weiss, erledigt grau' },
  { key: 'formular', shot: 'neues-projekt-validierung', ref: 'cal-hero.png', what: 'Buttons, Felder, Titel' },
  { key: 'kopf', shot: 'shell-profilmenue', ref: 'cal-hero.png', what: 'Kopfzeile, Navigation, Menü' },
]

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
for (const p of pairs) {
  for (const theme of ['hell', 'dunkel'] as const) {
    const dark = theme === 'dunkel'
    await page.setContent(`<!doctype html><html><body style="margin:0;background:${dark ? '#0a0a0b' : '#f3f4f6'};font:500 14px/1.4 system-ui;color:${dark ? '#c4c4c8' : '#374151'}">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px">
        <figure style="margin:0"><figcaption style="margin:0 0 8px">Airlock · ${theme}</figcaption>
          <div style="height:1100px;overflow:hidden;border-radius:12px;box-shadow:0 0 0 1px rgba(127,127,127,.25)"><img src="${img(resolve(shots, `${p.shot}-${theme}.png`))}" style="width:100%;display:block"></div></figure>
        <figure style="margin:0"><figcaption style="margin:0 0 8px">Referenz cal.com · ${p.what}</figcaption>
          <div style="height:1100px;overflow:hidden;border-radius:12px;background:#fff;box-shadow:0 0 0 1px rgba(127,127,127,.25)"><img src="${img(resolve(refs, p.ref))}" style="width:100%;display:block"></div></figure>
      </div></body></html>`)
    await page.waitForTimeout(100)
    await page.screenshot({ path: resolve(out, `vergleich-${p.key}-${theme}.png`), fullPage: true })
    console.log(`✓ vergleich-${p.key}-${theme}.png`)
  }
}
await browser.close()
