/**
 * Menü-Animation prüfen und aufnehmen (Profilmenü, «…» der Projektkarten).
 * Startet Vite selbst, die API kommt aus fixtures.ts. Nur Desktop (1440 px).
 *
 *   pnpm --filter @airlock/web exec tsx design-shots/menu-motion.ts            # Prüfungen + GIF
 *   pnpm --filter @airlock/web exec tsx design-shots/menu-motion.ts --no-gif   # nur Prüfungen
 *
 * Prüft: Esc, Klick daneben und Auswahl schliessen gleich (Fokus zurück auf
 * den Auslöser), schnelles Auf/Zu/Auf bleibt weder hängen noch flackert,
 * Ursprung je nach Seite, Staffel der Einträge, reduzierte Bewegung (nur
 * Deckkraft, 80 ms). Das GIF (10× verlangsamt aufgenommen, 3× langsamer als
 * echt abgespielt) landet in docs/design-cal/menue-animation-<theme>.gif;
 * zum Zusammensetzen braucht es python3 mit Pillow.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright'
import * as fx from './fixtures.js'

const { values: args } = parseArgs({ options: { 'no-gif': { type: 'boolean' } } })
const here = fileURLToPath(new URL('.', import.meta.url))
const webRoot = resolve(here, '..')
const repo = resolve(webRoot, '../..')
const PORT = 5197
const BASE = `http://localhost:${PORT}`

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

function apiBody(pathname: string): unknown {
  const p = pathname.replace(/^\/api\/v1/, '')
  let m: RegExpMatchArray | null
  if (p === '/auth/me') return { ...fx.me, theme: 'light' }
  if (p === '/projects') return { projects: fx.projects }
  if ((m = p.match(/^\/projects\/([^/]+)\/health$/))) return fx.health(m[1]!)
  if (p === '/audit') return { events: fx.audit() }
  if (p === '/system/status') return fx.system
  if (p === '/domains') return fx.domains
  if (p === '/notifications') return fx.notifications
  return {}
}

async function newContext(browser: Browser, opts: { reduced?: boolean; theme?: 'light' | 'dark'; scale?: number } = {}) {
  const theme = opts.theme ?? 'light'
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: opts.scale ?? 1,
    reducedMotion: opts.reduced ? 'reduce' : 'no-preference',
    locale: 'de-CH',
    timezoneId: 'Europe/Zurich',
    colorScheme: theme,
  })
  await ctx.addInitScript({ content: `try { localStorage.setItem('airlock.theme', '${theme}') } catch {}` })
  // tsx/esbuild hängt an benannte Funktionen __name(); in page.evaluate gibt es das nicht
  await ctx.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === 'localhost' && url.port === String(PORT)) {
      if (url.pathname.startsWith('/api/')) {
        if (route.request().method() === 'GET' || url.pathname === '/api/v1/auth/me') return json(route, apiBody(url.pathname))
        return json(route, {})
      }
      return route.continue()
    }
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '' })
  })
  return ctx
}

async function openPage(ctx: BrowserContext, path = '/projekte') {
  const page = await ctx.newPage()
  await page.goto(BASE + path, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  await page.locator('.profile-trigger').waitFor()
  return page
}

// --- Prüfungen ------------------------------------------------------------------------

let failures = 0
function check(ok: boolean, what: string, detail?: unknown) {
  if (ok) console.log(`  ✓ ${what}`)
  else {
    failures++
    console.log(`  ✗ ${what}${detail === undefined ? '' : `\n      ${JSON.stringify(detail)}`}`)
  }
}

type Step = 'toggle' | 'esc' | 'outside'
type Sample = { t: number; opacity: number; display: string; open: boolean; closing: boolean }

/**
 * Führt Schritte zu festen Zeitpunkten im Browser aus und misst jedes Bild
 * Deckkraft und display der Liste. Die Schritte laufen über echte DOM-Events
 * (click, keydown, mousedown), damit das Timing auf die Millisekunde stimmt.
 */
function runSequence(page: Page, menu: string, steps: Array<[number, Step]>, tail = 350) {
  return page.evaluate(
    ({ menu, steps, tail }) =>
      new Promise<{ samples: Sample[]; marks: Record<number, number> }>((done) => {
        const root = document.querySelector(menu)!
        const trigger = root.querySelector<HTMLButtonElement>('button[aria-haspopup]')!
        const list = root.querySelector<HTMLElement>('.menu-list')!
        const samples: Sample[] = []
        const marks: Record<number, number> = {}
        const t0 = performance.now()
        const end = Math.max(...steps.map((s) => s[0])) + tail
        steps.forEach(([at, step], i) =>
          setTimeout(() => {
            marks[i] = performance.now() - t0
            if (step === 'toggle') trigger.click()
            if (step === 'esc') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
            if (step === 'outside') document.querySelector('h1')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
          }, at),
        )
        const frame = () => {
          const cs = getComputedStyle(list)
          samples.push({ t: performance.now() - t0, opacity: Number(cs.opacity), display: cs.display, open: list.hasAttribute('data-open'), closing: list.classList.contains('closing') })
          if (performance.now() - t0 < end) requestAnimationFrame(frame)
          else done({ samples, marks })
        }
        requestAnimationFrame(frame)
      }),
    { menu, steps, tail },
  )
}

const listState = (page: Page, menu: string) =>
  page.evaluate((menu) => {
    const list = document.querySelector(`${menu} .menu-list`) as HTMLElement
    const cs = getComputedStyle(list)
    return { display: cs.display, opacity: Number(cs.opacity), open: list.hasAttribute('data-open'), closing: list.classList.contains('closing'), focus: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? null }
  }, menu)

/** Nach dem Wiederöffnen darf die Deckkraft nur noch steigen (kein Neustart bei 0). */
function noFlicker(samples: Sample[], from: number) {
  const after = samples.filter((s) => s.t >= from)
  for (let i = 1; i < after.length; i++) if (after[i]!.opacity < after[i - 1]!.opacity - 0.01) return { at: after[i]!.t, from: after[i - 1]!.opacity, to: after[i]!.opacity }
  return null
}

async function checks(browser: Browser) {
  const ctx = await newContext(browser)
  const page = await openPage(ctx)
  const P = '.menu.profile'
  const trigger = page.locator('.profile-trigger')
  const wait = (ms: number) => page.waitForTimeout(ms)

  console.log('Profilmenü: Öffnen und die drei Wege zu')
  await trigger.click()
  await wait(250)
  let s = await listState(page, P)
  check(s.open && s.display === 'block' && s.opacity === 1, 'offen: sichtbar, Deckkraft 1', s)
  check(s.focus === 'Konto', 'erster Eintrag hat den Fokus', s.focus)
  const timing = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.menu.profile .menu-list')!)
    return { duration: cs.transitionDuration, easing: cs.transitionTimingFunction, origin: cs.transformOrigin }
  })
  check(timing.duration.startsWith('0.15s, 0.15s') && timing.easing.includes('cubic-bezier(0.23, 1, 0.32, 1)'), 'Öffnen 150 ms, cubic-bezier(.23,1,.32,1)', timing)

  await page.keyboard.press('Escape')
  s = await listState(page, P)
  check(s.closing && s.display === 'block', 'Esc: blendet aus (closing, noch sichtbar)', s)
  const closeTiming = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.menu.profile .menu-list')!)
    return { duration: cs.transitionDuration, easing: cs.transitionTimingFunction }
  })
  check(closeTiming.duration.startsWith('0.1s, 0.1s') && closeTiming.easing.startsWith('ease-in'), 'Schliessen 100 ms ease-in', closeTiming)
  await wait(250)
  s = await listState(page, P)
  check(!s.open && !s.closing && s.display === 'none', 'Esc: danach weg (display none)', s)
  check(s.focus?.startsWith('Profil-Menü') ?? false, 'Esc: Fokus zurück auf den Auslöser', s.focus)

  await trigger.click()
  await wait(250)
  await page.mouse.click(700, 500)
  s = await listState(page, P)
  check(s.closing && s.display === 'block', 'Klick daneben: blendet gleich aus', s)
  await wait(250)
  s = await listState(page, P)
  check(s.display === 'none' && !s.closing, 'Klick daneben: danach weg', s)

  await trigger.click()
  await wait(250)
  await page.getByRole('menuitem', { name: 'Konto' }).click()
  s = await listState(page, P)
  check(s.closing && s.display === 'block', 'Auswahl: blendet gleich aus', s)
  check(s.focus?.startsWith('Profil-Menü') ?? false, 'Auswahl: Fokus zurück auf den Auslöser', s.focus)
  await wait(250)
  s = await listState(page, P)
  check(s.display === 'none', 'Auswahl: danach weg', s)
  await page.goto(BASE + '/projekte', { waitUntil: 'networkidle' })

  console.log('Schnelles Auf/Zu/Auf')
  for (const gap of [16, 40, 70]) {
    const r = await runSequence(page, P, [[0, 'toggle'], [gap, 'toggle'], [gap * 2, 'toggle']])
    const last = r.samples.at(-1)!
    const hidden = r.samples.filter((x) => x.t > r.marks[0]! + 1 && x.display === 'none')
    check(last.open && !last.closing && last.display === 'block' && last.opacity === 1, `auf/zu/auf (${gap} ms): bleibt offen, Deckkraft 1`, last)
    check(hidden.length === 0, `auf/zu/auf (${gap} ms): nie zwischendurch display none`, hidden[0])
    const flick = noFlicker(r.samples, r.marks[2]!)
    check(flick === null, `auf/zu/auf (${gap} ms): kein Flackern nach dem Wiederöffnen`, flick)
    // wieder zu für den nächsten Durchgang
    await runSequence(page, P, [[0, 'esc']], 300)
  }
  for (const gap of [16, 40, 70]) {
    await trigger.click()
    await wait(250)
    const r = await runSequence(page, P, [[0, 'esc'], [gap, 'toggle'], [gap * 2, 'outside']])
    const last = r.samples.at(-1)!
    check(!last.open && !last.closing && last.display === 'none', `Esc/auf/daneben (${gap} ms): landet geschlossen, nichts hängt`, last)
  }
  {
    const steps = Array.from({ length: 11 }, (_, i) => [i * 12, 'toggle'] as [number, Step])
    const r = await runSequence(page, P, steps, 400)
    const last = r.samples.at(-1)!
    check(last.open && last.opacity === 1 && !last.closing, '11 Klicks im 12-ms-Takt: ungerade Zahl -> offen, sauber', last)
    await runSequence(page, P, [[0, 'esc']], 300)
  }

  console.log('Staffel der Einträge (nur beim Öffnen)')
  await trigger.click()
  const delays = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.menu.profile .menu-list > :not(.menu-sep)')].map((el) => getComputedStyle(el).transitionDelay.split(',')[0]!.trim()),
  )
  check(JSON.stringify(delays) === JSON.stringify(['0s', '0.02s', '0.036s', '0.05s', '0.062s', '0.072s'].slice(0, delays.length)), 'Verzögerungen 0/20/36/50/62/72 ms, Abstand ≤ 20 ms, ab dem 6. gleich', delays)
  await wait(250)
  await page.keyboard.press('Escape')
  const closingDelays = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.menu.profile .menu-list > :not(.menu-sep)')].map((el) => getComputedStyle(el).opacity),
  )
  check(closingDelays.every((o) => o === '1'), 'Schliessen: Einträge bleiben stehen, die Liste blendet gemeinsam aus', closingDelays)
  await wait(250)

  console.log('Zeilenmenü «…»: Ursprung je nach Seite')
  const rowTriggers = page.locator('.pcard .button-icon[aria-haspopup="menu"]')
  await rowTriggers.first().click()
  await wait(250)
  let side = await page.evaluate(() => {
    const l = document.querySelector<HTMLElement>('.pcard .menu-list[data-open]')!
    return { side: l.dataset.side, origin: getComputedStyle(l).transformOrigin, z: getComputedStyle(l.closest('.pcard')!).zIndex }
  })
  check(side.side === 'bottom' && side.origin.endsWith('0px') && side.z === '10', 'nach unten: Ursprung oben rechts, Karte darüber', side)
  await page.keyboard.press('Escape')
  const zDuringClose = await page.evaluate(() => getComputedStyle(document.querySelector('.pcard:has(.menu-list.closing)') ?? document.body).zIndex)
  check(zDuringClose === '10', 'beim Ausblenden bleibt die Karte über den Nachbarn', zDuringClose)
  await wait(250)
  // Auslöser nahe an den unteren Rand bringen
  await page.evaluate(() => {
    const b = document.querySelector('.pcard .button-icon[aria-haspopup="menu"]')!.getBoundingClientRect()
    window.scrollBy(0, b.bottom - (window.innerHeight - 120))
  })
  const low = await page.evaluate(() => window.innerHeight - document.querySelector('.pcard .button-icon[aria-haspopup="menu"]')!.getBoundingClientRect().bottom)
  if (low < 260) {
    await rowTriggers.first().click()
    side = await page.evaluate(() => {
      const l = document.querySelector<HTMLElement>('.pcard .menu-list[data-open]')!
      return { side: l.dataset.side, origin: getComputedStyle(l).transformOrigin, z: '' }
    })
    const h = await page.evaluate(() => document.querySelector<HTMLElement>('.pcard .menu-list[data-open]')!.offsetHeight)
    check(side.side === 'top' && side.origin.endsWith(`${h}px`), 'nach oben: Ursprung unten rechts (schon im ersten Bild)', { ...side, h })
    await page.keyboard.press('Escape')
    await wait(250)
    check(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Aktionen für') ?? false), 'Esc: Fokus zurück auf «…»')
  } else console.log(`  · Seite zu kurz zum Testen von «nach oben» (Abstand ${Math.round(low)} px)`)
  await ctx.close()

  console.log('Rückfall ohne allow-discrete (Klasse «closing» bis transitionend)')
  const fctx = await newContext(browser)
  const fpage = await openPage(fctx)
  // Nachbau eines Browsers ohne display-Transition: so greift der @supports-not-Zweig
  await fpage.addStyleTag({
    content: `.menu-list { transition: opacity 100ms ease-in, transform 100ms ease-in !important; }
      .menu-list[data-open] { transition: opacity 150ms cubic-bezier(0.23, 1, 0.32, 1), transform 150ms cubic-bezier(0.23, 1, 0.32, 1) !important; }
      .menu-list.closing { display: block; }`,
  })
  {
    const r = await runSequence(fpage, P, [[0, 'toggle'], [250, 'esc']], 300)
    const fading = r.samples.filter((x) => x.t > r.marks[1]! && x.display === 'block' && x.opacity > 0.05 && x.opacity < 0.95)
    check(fading.length > 0, 'Schliessen animiert (sichtbar, Zwischenwerte)', fading.length)
    check(r.samples.at(-1)!.display === 'none' && !r.samples.at(-1)!.closing, 'danach weg, Klasse entfernt', r.samples.at(-1))
    const q = await runSequence(fpage, P, [[0, 'toggle'], [40, 'toggle'], [80, 'toggle']])
    check(q.samples.at(-1)!.opacity === 1 && noFlicker(q.samples, q.marks[2]!) === null, 'auf/zu/auf: offen, kein Flackern', q.samples.at(-1))
  }
  await fctx.close()

  console.log('Reduzierte Bewegung')
  const rctx = await newContext(browser, { reduced: true })
  const rpage = await openPage(rctx)
  const r = await runSequence(rpage, P, [[0, 'toggle'], [200, 'esc']], 250)
  const transforms = await rpage.evaluate(() => getComputedStyle(document.querySelector('.menu.profile .menu-list')!).transform)
  const rtiming = await rpage.evaluate(() => getComputedStyle(document.querySelector('.menu.profile .menu-list')!).transitionDuration)
  check(transforms === 'none', 'keine Skalierung, kein Versatz', transforms)
  check(rtiming.startsWith('0.08s'), 'nur Deckkraft, 80 ms', rtiming)
  const fading = r.samples.filter((x) => x.opacity > 0.05 && x.opacity < 0.95)
  check(fading.length > 0, 'blendet trotzdem weich (Zwischenwerte gemessen)', fading.length)
  check(r.samples.at(-1)!.display === 'none', 'danach weg', r.samples.at(-1))
  await rctx.close()
}

// --- Aufnahme ---------------------------------------------------------------------------

async function record(browser: Browser, theme: 'light' | 'dark') {
  const ctx = await newContext(browser, { theme, scale: 2 })
  const page = await openPage(ctx)
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Animation.enable')
  const RATE = 0.1
  await cdp.send('Animation.setPlaybackRate', { playbackRate: RATE })
  const dir = mkdtempSync(join(tmpdir(), 'menue-'))
  const box = await page.locator('.profile-trigger').boundingBox()
  const clip = { x: Math.round(box!.x + box!.width - 340), y: Math.round(box!.y - 16), width: 360, height: 400 }
  const frames: Array<{ file: string; t: number }> = []
  const t0 = Date.now()
  let busy = true
  const loop = (async () => {
    while (busy) {
      const file = join(dir, `${String(frames.length).padStart(4, '0')}.png`)
      await page.screenshot({ path: file, clip })
      frames.push({ file, t: Date.now() - t0 })
    }
  })()
  // Zeiten in Animationszeit (ms); real 10× länger
  const at = (ms: number) => page.waitForTimeout(ms / RATE)
  const trigger = page.locator('.profile-trigger')
  await at(120)
  await trigger.click() // auf
  await at(350)
  await page.keyboard.press('Escape') // zu
  await at(300)
  await trigger.click() // auf
  await at(60)
  await trigger.click() // schnell zu …
  await at(50)
  await trigger.click() // … und wieder auf: kehrt um, kein Neustart
  await at(350)
  await page.mouse.click(700, 600) // Klick daneben
  await at(250)
  busy = false
  await loop
  await ctx.close()
  const out = join(repo, 'docs/design-cal', `menue-animation-${theme === 'light' ? 'hell' : 'dunkel'}.gif`)
  mkdirSync(join(repo, 'docs/design-cal'), { recursive: true })
  // Abspielen 3× langsamer als echt: Bildabstand real × RATE × 3
  const durations = frames.map((f, i) => Math.max(20, Math.round(((frames[i + 1]?.t ?? f.t + 400) - f.t) * RATE * 3)))
  try {
    execFileSync('python3', [join(here, 'frames-to-gif.py'), out, JSON.stringify(frames.map((f) => f.file)), JSON.stringify(durations)], { stdio: 'inherit' })
    console.log(`✓ ${out.replace(repo + '/', '')} (${frames.length} Bilder)`)
  } catch {
    console.log('✗ GIF nicht erstellt (python3 mit Pillow nötig)')
    failures++
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const server = await createServer({ root: webRoot, logLevel: 'error', server: { port: PORT, strictPort: true } })
await server.listen()
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' })
try {
  await checks(browser)
  if (!args['no-gif']) for (const theme of ['light', 'dark'] as const) await record(browser, theme)
} finally {
  await browser.close()
  await server.close()
}
console.log(failures ? `${failures} Prüfung(en) fehlgeschlagen` : 'Alle Prüfungen bestanden')
process.exit(failures ? 1 : 0)
