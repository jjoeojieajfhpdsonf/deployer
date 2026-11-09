/**
 * Screenshots des Prototyps «cal» (docs/prototype-cal): jede Seite in Hell und
 * Dunkel bei 1440 px (Desktop). Startet Vite selbst; die API kommt
 * aus fixtures.ts (page.route), externe Adressen antworten leer.
 *
 *   pnpm --filter @deployer/web exec tsx prototype-shots/shoot.ts
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, type Page, type Route } from 'playwright'
import * as fx from './fixtures.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const webRoot = resolve(here, '..')
const outDir = resolve(webRoot, '../../docs/prototype-cal')
mkdirSync(outDir, { recursive: true })

const PORT = 5199
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

/** Antwort der API aus den Fixtures; unbekannte Pfade: leeres Objekt. */
function api(path: string, method: string): unknown {
  const u = new URL(path, 'http://x')
  const p = u.pathname.replace(/^\/api\/v1/, '')
  if (method !== 'GET') return {}
  let m: RegExpMatchArray | null
  if (p === '/auth/me') return fx.me
  if (p === '/projects') return { projects: fx.projects }
  if ((m = p.match(/^\/projects\/([^/]+)$/))) return { project: fx.projects.find((x) => x.id === m![1]) ?? fx.projects[0], env: fx.env(m[1]!) }
  if ((m = p.match(/^\/projects\/([^/]+)\/deployments$/))) return { deployments: fx.deployments(m[1]!) }
  if ((m = p.match(/^\/deployments\/([^/]+)$/))) {
    const d = fx.projects.flatMap((x) => fx.deployments(x.id)).find((x) => x.id === m![1])
    return { deployment: d, log: fx.deployLog }
  }
  if ((m = p.match(/^\/projects\/([^/]+)\/health$/))) return fx.health(m[1]!)
  if ((m = p.match(/^\/projects\/([^/]+)\/logs$/))) return { logs: fx.appLogs }
  if ((m = p.match(/^\/projects\/([^/]+)\/scans\/latest$/))) return { report: fx.scan(m[1]!) }
  if (p === '/audit') return { events: fx.audit(u.searchParams.get('targetId') ?? undefined) }
  if (p === '/system/status') return fx.system
  if (p === '/system/cloudflare') return fx.cloudflare
  if (p === '/domains') return fx.domains
  if (p === '/notifications') return fx.notifications
  if (p === '/tokens') return { tokens: [] }
  if (p === '/external-targets') return { targets: [] }
  return {}
}

type Shot = { name: string; path: string; prepare?: (page: Page) => Promise<void> }
const shots: Shot[] = [
  { name: '01-projekte', path: '/prototype/projekte' },
  { name: '02-projekt-uebersicht', path: `/prototype/projekte/${fx.detailProjectId}` },
  { name: '03-projekt-security', path: `/prototype/projekte/${fx.securityProjectId}?tab=security` },
  { name: '04-system-cloudflare', path: '/prototype/system' },
  {
    name: '05-formular-validierung',
    path: '/prototype/projekte/neu',
    prepare: async (page) => {
      await page.locator('form button[type="submit"]').click()
      await page.waitForTimeout(200)
      await page.evaluate(() => window.scrollTo(0, 0))
    },
  },
  {
    name: '06-profilmenue',
    path: '/prototype/projekte',
    prepare: async (page) => {
      await page.locator('.profile-trigger').click()
      await page.waitForTimeout(250)
    },
  },
]

// Nur Desktop: deployer ist kein Werkzeug fürs Handy
const viewports = [{ key: 'desktop', width: 1440, height: 900 }]

const server = await createServer({ root: webRoot, logLevel: 'error', server: { port: PORT, strictPort: true } })
await server.listen()
// Installiertes Chrome (kein Browser-Download nötig); PW_CHANNEL=chromium für Playwrights eigenen
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' })
let n = 0
try {
  for (const vp of viewports) {
    for (const theme of ['hell', 'dunkel'] as const) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, reducedMotion: 'reduce', locale: 'de-CH', timezoneId: 'Europe/Zurich' })
      await ctx.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (url.port === String(PORT) && url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
          if (url.pathname.startsWith('/api/')) return json(route, api(url.pathname + url.search, route.request().method()))
          if (url.pathname === '/health') return json(route, { ok: true })
          return route.continue()
        }
        // Erreichbarkeits-Prüfungen der Oberfläche: antworten, ohne das Netz zu fragen
        return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '' })
      })
      const page = await ctx.newPage()
      for (const s of shots) {
        const sep = s.path.includes('?') ? '&' : '?'
        await page.goto(`http://localhost:${PORT}${s.path}${sep}theme=${theme === 'hell' ? 'light' : 'dark'}`, { waitUntil: 'networkidle' })
        // Der Testdaten-Umschalter des Dev-Servers gehört nicht ins Bild
        await page.addStyleTag({ content: '[aria-label="Testdaten (nur Entwicklung)"]{display:none!important}' })
        await page.evaluate(() => document.fonts.ready)
        await page.waitForTimeout(300)
        if (s.prepare) await s.prepare(page)
        const file = join(outDir, `${s.name}-${theme}-${vp.key}.png`)
        await page.screenshot({ path: file, fullPage: !s.name.includes('profilmenue') })
        n++
        console.log(`✓ ${file.replace(outDir + '/', '')}`)
      }
      await ctx.close()
    }
  }
} finally {
  await browser.close()
  await server.close()
}
console.log(`${n} Screenshots in ${outDir}`)
