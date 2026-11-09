/**
 * Screenshots des Frontends in Hell und Dunkel bei 1440 px (nur Desktop).
 * Startet Vite selbst; die API kommt aus fixtures.ts (page.route), externe
 * Adressen antworten leer.
 *
 *   pnpm --filter @deployer/web exec tsx prototype-shots/shoot.ts --out docs/design-cal/3a-shell --only shell,login
 *
 *   --out    Zielordner relativ zum Repo (Standard docs/prototype-cal)
 *   --base   Pfad-Präfix, z. B. /prototype (Standard leer)
 *   --only   Komma-Liste von Gruppen oder Namen (Standard: alle)
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'
import { chromium, type Page, type Route } from 'playwright'
import * as fx from './fixtures.js'

const { values: args } = parseArgs({ options: { out: { type: 'string' }, base: { type: 'string' }, only: { type: 'string' } } })
const here = fileURLToPath(new URL('.', import.meta.url))
const webRoot = resolve(here, '..')
const repo = resolve(webRoot, '../..')
const outDir = resolve(repo, args.out ?? 'docs/prototype-cal')
const base = args.base ?? ''
mkdirSync(outDir, { recursive: true })

const PORT = 5199
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

/** Antwort der API aus den Fixtures; unbekannte Pfade: leeres Objekt. */
function api(path: string, method: string, loggedIn: boolean, theme: 'light' | 'dark'): { status?: number; body: unknown } {
  const u = new URL(path, 'http://x')
  const p = u.pathname.replace(/^\/api\/v1/, '')
  if (p === '/auth/me') return { body: loggedIn ? { ...fx.me, theme } : { loggedIn: false, theme: null } }
  if (method !== 'GET') return { body: {} }
  let m: RegExpMatchArray | null
  if (p === '/projects') return { body: { projects: fx.projects } }
  if ((m = p.match(/^\/projects\/([^/]+)$/))) return { body: { project: fx.projects.find((x) => x.id === m![1]) ?? fx.projects[0], env: fx.env(m[1]!) } }
  if ((m = p.match(/^\/projects\/([^/]+)\/deployments$/))) return { body: { deployments: fx.deployments(m[1]!) } }
  if ((m = p.match(/^\/deployments\/([^/]+)$/))) {
    const d = fx.projects.flatMap((x) => fx.deployments(x.id)).find((x) => x.id === m![1])
    return { body: { deployment: d, log: d?.status === 'failed' ? fx.failedLog : fx.deployLog } }
  }
  if ((m = p.match(/^\/projects\/([^/]+)\/health$/))) return { body: fx.health(m[1]!) }
  if ((m = p.match(/^\/projects\/([^/]+)\/logs$/))) return { body: { logs: fx.appLogs } }
  if ((m = p.match(/^\/projects\/([^/]+)\/files$/))) return { body: { commit: null, files: [] } }
  if ((m = p.match(/^\/projects\/([^/]+)\/scans\/latest$/))) return { body: { report: fx.scan(m[1]!) } }
  if (p === '/audit') return { body: { events: fx.audit(u.searchParams.get('targetId') ?? undefined) } }
  if (p === '/system/status') return { body: fx.system }
  if (p === '/system/cloudflare') return { body: fx.cloudflare }
  if (p === '/domains') return { body: fx.domains }
  if (p === '/notifications') return { body: fx.notifications }
  if (p === '/tokens') return { body: { tokens: fx.tokens } }
  if (p === '/external-targets') return { body: { targets: fx.externalTargets } }
  if ((m = p.match(/^\/external-targets\/([^/]+)\/scans\/latest$/))) return { body: { report: fx.externalScan } }
  return { body: {} }
}

type Shot = { name: string; group: string; path: string; loggedIn?: boolean; full?: boolean; prepare?: (page: Page) => Promise<void> }
const P = fx.detailProjectId
const S = fx.securityProjectId
const W = 'p-wetter'
const shots: Shot[] = [
  { group: 'shell', name: 'shell-profilmenue', path: '/projekte', full: false, prepare: async (pg) => { await pg.locator('.profile-trigger').click(); await pg.waitForTimeout(250) } },
  { group: 'login', name: 'login', path: '/projekte', loggedIn: false },
  { group: 'projekte', name: 'projekte', path: '/projekte' },
  { group: 'projekte', name: 'projekt-uebersicht', path: `/projekte/${P}` },
  { group: 'projekte', name: 'projekt-fehler', path: `/projekte/${W}` },
  { group: 'projekte', name: 'projekt-deployments', path: `/projekte/${P}?tab=deployments` },
  { group: 'projekte', name: 'projekt-logs', path: `/projekte/${P}?tab=logs` },
  { group: 'projekte', name: 'projekt-security', path: `/projekte/${S}?tab=security` },
  { group: 'projekte', name: 'projekt-einstellungen', path: `/projekte/${P}?tab=einstellungen` },
  {
    group: 'formulare', name: 'neues-projekt-validierung', path: '/projekte/neu',
    prepare: async (pg) => { await pg.locator('form button[type="submit"]').click(); await pg.waitForTimeout(200); await pg.evaluate(() => window.scrollTo(0, 0)) },
  },
  { group: 'formulare', name: 'konto', path: '/konto' },
  { group: 'security', name: 'security-global', path: '/security' },
  { group: 'security', name: 'externe-ziele', path: '/extern' },
  { group: 'verwaltung', name: 'domains', path: '/domains' },
  { group: 'verwaltung', name: 'tokens', path: '/tokens' },
  { group: 'verwaltung', name: 'audit', path: '/audit' },
  { group: 'system', name: 'system-uebersicht', path: '/system' },
  { group: 'system', name: 'system-cloudflare', path: '/system/cloudflare' },
  { group: 'system', name: 'system-benachrichtigungen', path: '/system/benachrichtigungen' },
  { group: 'zustaende', name: 'nicht-gefunden', path: '/gibt-es-nicht' },
  {
    group: 'zustaende', name: 'bestaetigung-stoppen', path: `/projekte/${P}`, full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: /^Stoppen/ }).first().click(); await pg.waitForTimeout(250) },
  },
  {
    group: 'zustaende', name: 'menue-zeile', path: '/projekte', full: false,
    prepare: async (pg) => { await pg.locator('.button-icon[aria-haspopup="menu"]').first().click(); await pg.waitForTimeout(250) },
  },
]

const only = args.only?.split(',').map((s) => s.trim()).filter(Boolean)
const selected = only ? shots.filter((s) => only.includes(s.group) || only.includes(s.name)) : shots

const server = await createServer({ root: webRoot, logLevel: 'error', server: { port: PORT, strictPort: true } })
await server.listen()
// Installiertes Chrome (kein Browser-Download nötig); PW_CHANNEL=chromium für Playwrights eigenen
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' })
let n = 0
try {
  for (const theme of ['hell', 'dunkel'] as const) {
    const t = theme === 'hell' ? 'light' : 'dark'
    for (const s of selected) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce', locale: 'de-CH', timezoneId: 'Europe/Zurich', colorScheme: t })
      await ctx.addInitScript({ content: `try { localStorage.setItem('deployer.theme', '${t}') } catch {}` })
      await ctx.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if ((url.port === String(PORT) && url.hostname === 'localhost') || url.hostname === '127.0.0.1') {
          if (url.pathname.startsWith('/api/')) {
            const r = api(url.pathname + url.search, route.request().method(), s.loggedIn !== false, t)
            return json(route, r.body, r.status)
          }
          if (url.pathname === '/health') return json(route, { ok: true })
          return route.continue()
        }
        // Erreichbarkeits-Prüfungen der Oberfläche: antworten, ohne das Netz zu fragen
        return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '' })
      })
      const page = await ctx.newPage()
      const sep = s.path.includes('?') ? '&' : '?'
      const themeParam = base ? `${sep}theme=${t}` : ''
      await page.goto(`http://localhost:${PORT}${base}${s.path}${themeParam}`, { waitUntil: 'networkidle' })
      // Der Testdaten-Umschalter des Dev-Servers gehört nicht ins Bild
      await page.addStyleTag({ content: '[aria-label="Testdaten (nur Entwicklung)"]{display:none!important}' })
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(300)
      if (s.prepare) await s.prepare(page)
      const file = join(outDir, `${s.name}-${theme}.png`)
      await page.screenshot({ path: file, fullPage: s.full !== false })
      n++
      console.log(`✓ ${file.replace(repo + '/', '')}`)
      await ctx.close()
    }
  }
} finally {
  await browser.close()
  await server.close()
}
console.log(`${n} Screenshots in ${outDir.replace(repo + '/', '')}`)
