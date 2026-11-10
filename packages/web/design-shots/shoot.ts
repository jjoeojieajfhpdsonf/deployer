/**
 * Screenshots des Frontends in Hell und Dunkel bei 1440 px (nur Desktop).
 * Startet Vite selbst; die API kommt aus fixtures.ts (page.route), externe
 * Adressen antworten leer.
 *
 *   pnpm --filter @deployer/web exec tsx design-shots/shoot.ts --out docs/design-cal/3a-shell --only shell,login
 *
 *   --out    Zielordner relativ zum Repo (Standard docs/design-cal/aktuell)
 *   --only   Komma-Liste von Gruppen oder Namen (Standard: alle)
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'
import { chromium, type Page, type Route } from 'playwright'
import * as fx from './fixtures.js'
import { DEFAULT_PAUSE_PAGE } from '@deployer/shared'

const { values: args } = parseArgs({ options: { out: { type: 'string' }, only: { type: 'string' } } })
const here = fileURLToPath(new URL('.', import.meta.url))
const webRoot = resolve(here, '..')
const repo = resolve(webRoot, '../..')
const outDir = resolve(repo, args.out ?? 'docs/design-cal/aktuell')
mkdirSync(outDir, { recursive: true })

const PORT = 5199
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

/** Antwort der API aus den Fixtures; unbekannte Pfade: leeres Objekt. */
function api(path: string, method: string, loggedIn: boolean, theme: 'light' | 'dark', count?: number): { status?: number; body: unknown } {
  const u = new URL(path, 'http://x')
  const p = u.pathname.replace(/^\/api\/v1/, '')
  if (p === '/auth/me') return { body: loggedIn ? { ...fx.me, theme } : { loggedIn: false, theme: null } }
  let m: RegExpMatchArray | null
  if (method === 'POST' && (m = p.match(/^\/projects\/([^/]+)\/public\/pause$/))) return { body: fx.pauseResult(m[1]!) }
  if (method !== 'GET') return { body: {} }
  if (p === '/settings/pause-page') return { body: { page: fx.pausePageTemplate, defaults: DEFAULT_PAUSE_PAGE } }
  if ((m = p.match(/^\/projects\/([^/]+)\/public$/))) return { body: fx.publicStatus(m[1]!) }
  if ((m = p.match(/^\/projects\/([^/]+)\/public\/progress$/))) return { body: { progress: fx.publishProgress(m[1]!) } }
  if (p === '/projects') return { body: { projects: count === undefined ? fx.projects : fx.projectsFor(count) } }
  if ((m = p.match(/^\/projects\/([^/]+)$/))) return { body: { project: fx.allProjects.find((x) => x.id === m![1]) ?? fx.projects[0], env: fx.env(m[1]!) } }
  if ((m = p.match(/^\/projects\/([^/]+)\/deployments$/))) return { body: { deployments: fx.deployments(m[1]!) } }
  if ((m = p.match(/^\/deployments\/([^/]+)$/))) {
    const d = fx.projects.flatMap((x) => [...fx.deployments(x.id), ...(x.lastDeployment ? [x.lastDeployment] : [])]).find((x) => x.id === m![1])
    return { body: { deployment: d, log: d?.status === 'failed' ? fx.failedLog : fx.deployLog } }
  }
  if ((m = p.match(/^\/projects\/([^/]+)\/health$/))) return { body: fx.health(m[1]!) }
  if ((m = p.match(/^\/projects\/([^/]+)\/logs$/))) return { body: { logs: fx.appLogs } }
  if ((m = p.match(/^\/projects\/([^/]+)\/files$/))) return { body: { commit: null, files: [] } }
  if ((m = p.match(/^\/projects\/([^/]+)\/scans\/latest$/))) return { body: { report: fx.scan(m[1]!, u.searchParams.get('done') === '1') } }
  // M8: Fix-Assistent
  if ((m = p.match(/^\/projects\/([^/]+)\/header-rules$/))) return { body: fx.headerRules(m[1]!) }
  if ((m = p.match(/^\/projects\/([^/]+)\/fix-requests$/))) return { body: { fixes: fx.fixRequests(m[1]!) } }
  if ((m = p.match(/^\/projects\/([^/]+)\/auto-deploy$/))) return { body: fx.autoDeploy(m[1]!) }
  if ((m = p.match(/^\/projects\/[^/]+\/findings\/([^/]+)\/fix-hint$/))) return { body: fx.fixHint(m[1]!) }
  if (p === '/audit') {
    const events = fx.audit(u.searchParams.get('targetId') ?? undefined)
    if (count === undefined) return { body: { events } }
    // Bei fester Projektanzahl nur Einträge zu Projekten, die es gibt
    const ids = new Set(fx.projectsFor(count).map((x) => x.id))
    return { body: { events: events.filter((e) => e.targetType !== 'project' || (e.targetId && ids.has(e.targetId))) } }
  }
  if (p === '/system/status') return { body: fx.system }
  if (p === '/system/cloudflare') return { body: fx.cloudflare }
  if (p === '/domains') return { body: fx.domains }
  if (p === '/notifications') return { body: fx.notifications }
  if (p === '/tokens') return { body: { tokens: fx.tokens } }
  if (p === '/external-targets') return { body: { targets: fx.externalTargets } }
  if ((m = p.match(/^\/external-targets\/([^/]+)\/scans\/latest$/))) return { body: { report: fx.externalScan } }
  return { body: {} }
}

type Shot = {
  name: string
  group: string
  path: string
  loggedIn?: boolean
  full?: boolean
  /** Leere Daten (keine Projekte, kein Audit) */
  empty?: boolean
  /** M8: GitHub App angelegt und installiert */
  githubConnected?: boolean
  /** API nicht erreichbar (/auth/me antwortet mit 502) */
  offline?: boolean
  /** Diese API-Pfade antworten nie (Ladezustand) */
  hang?: string[]
  /** Feste Anzahl Projekte (fixtures.projectsFor) statt der Standardliste */
  count?: number
  prepare?: (page: Page) => Promise<void>
}
const P = fx.detailProjectId
const S = fx.securityProjectId
const W = 'p-wetter'
const L = fx.liveProjectId
const Z = fx.pausedProjectId
const shots: Shot[] = [
  { group: 'shell', name: 'shell-profilmenue', path: '/projekte', full: false, prepare: async (pg) => { await pg.locator('.profile-trigger').click(); await pg.waitForTimeout(250) } },
  { group: 'login', name: 'login', path: '/projekte', loggedIn: false },
  { group: 'projekte', name: 'projekte', path: '/projekte' },
  { group: 'projekte', name: 'projekt-uebersicht', path: `/projekte/${P}` },
  { group: 'projekte', name: 'projekt-fehler', path: `/projekte/${W}` },
  { group: 'projekte', name: 'projekt-deployments', path: `/projekte/${P}?tab=deployments` },
  { group: 'projekte', name: 'projekt-logs', path: `/projekte/${P}?tab=logs` },
  { group: 'projekte', name: 'projekt-security', path: `/projekte/${S}?tab=security` },
  { group: 'security', name: 'projekt-security-laeuft', path: `/projekte/${fx.runningScanProjectId}?tab=security` },
  {
    group: 'security', name: 'projekt-security-laeuft-ausgabe', path: `/projekte/${fx.runningScanProjectId}?tab=security`, full: false,
    prepare: async (pg) => { await pg.locator('.live-scan .stage-tail summary').first().click(); await pg.waitForTimeout(200) },
  },
  // M8: Header über Caddy – Rückfrage vor HSTS
  {
    group: 'fix', name: 'security-hsts-rueckfrage', path: `/projekte/${S}?tab=security`, full: false,
    prepare: async (pg) => {
      const b = pg.getByRole('button', { name: 'HSTS setzen …' })
      await b.scrollIntoViewIfNeeded()
      await b.click()
      await pg.waitForTimeout(250)
    },
  },
  // M8, Etappe 2: Mit Claude lösen – Auftrag am Befund und Image-Hinweis
  {
    group: 'fix', name: 'security-mit-claude-loesen', path: `/projekte/${S}?tab=security`, full: false,
    prepare: async (pg) => {
      const cards = pg.locator('.finding').filter({ hasText: 'Container läuft als root' })
      await cards.first().getByRole('button', { name: 'Mit Claude lösen' }).click()
      await pg.waitForTimeout(300)
      await cards.first().evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await pg.evaluate(() => window.scrollBy(0, -24))
      await pg.waitForTimeout(150)
    },
  },
  {
    group: 'fix', name: 'security-image-hinweis', path: `/projekte/${S}?tab=security`, full: false,
    prepare: async (pg) => {
      const card = pg.locator('.finding').filter({ hasText: 'CVE-2026-31337' }).first()
      await card.getByRole('button', { name: 'Mit Claude lösen' }).click()
      await pg.waitForTimeout(300)
      await card.evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await pg.evaluate(() => window.scrollBy(0, -24))
      await pg.waitForTimeout(150)
    },
  },
  {
    group: 'fix', name: 'security-vorschlag-claude', path: `/projekte/${S}?tab=security`, full: false,
    prepare: async (pg) => {
      await pg.locator('#fix-requests-title').scrollIntoViewIfNeeded()
      await pg.evaluate(() => window.scrollBy(0, 300))
      await pg.waitForTimeout(150)
    },
  },
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
  {
    // Filter «Anmeldungen zeigen» mit Tastaturfokus und Maus darüber
    group: 'verwaltung', name: 'audit-anmeldungen-fokus', path: '/audit', full: false,
    prepare: async (pg) => { await pg.locator('.audit-logins input').focus(); await pg.keyboard.press('Space'); await pg.keyboard.press('Space'); await pg.locator('.audit-logins').hover(); await pg.waitForTimeout(150) },
  },
  { group: 'system', name: 'system-uebersicht', path: '/system' },
  { group: 'system', name: 'system-cloudflare', path: '/system/cloudflare' },
  { group: 'system', name: 'system-benachrichtigungen', path: '/system/benachrichtigungen' },
  // M8, Etappe 3
  { group: 'github', name: 'system-github', path: '/system/github' },
  { group: 'github', name: 'system-github-verbunden', path: '/system/github?ok=installiert', githubConnected: true },
  { group: 'github', name: 'projekt-auto-deploy', path: '/projekte/p-foto?tab=einstellungen' },
  { group: 'zustaende', name: 'nicht-gefunden', path: '/gibt-es-nicht' },
  {
    group: 'zustaende', name: 'bestaetigung-stoppen', path: `/projekte/${P}`, full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: /^Stoppen/ }).first().click(); await pg.waitForTimeout(250) },
  },
  {
    group: 'zustaende', name: 'menue-zeile-bestaetigung', path: '/projekte', full: false,
    prepare: async (pg) => {
      await pg.locator('.button-icon[aria-haspopup="menu"]').nth(2).click()
      await pg.waitForTimeout(200)
      await pg.getByRole('menuitem', { name: /^Stoppen/ }).click()
      await pg.waitForTimeout(250)
    },
  },
  // Übersicht mit wenigen bis vielen Projekten (Karte «Neues Projekt», Filter erst ab 4)
  ...[0, 1, 2, 3, 7].map((count): Shot => ({ group: 'anzahl', name: `projekte-anzahl-${count}`, path: '/projekte', count })),
  {
    group: 'anzahl', name: 'projekte-per-chat', path: '/projekte', count: 1, full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: /Per Chat/ }).click(); await pg.waitForTimeout(300) },
  },
  /* Veröffentlichung: Privat (projekt-einstellungen), Öffentlich, Pausiert, gesperrt, Rückfragen, Fortschritt, Toast */
  { group: 'veroeffentlichung', name: 'veroeffentlichung-live', path: `/projekte/${L}?tab=einstellungen` },
  { group: 'veroeffentlichung', name: 'veroeffentlichung-pausiert', path: `/projekte/${Z}?tab=einstellungen` },
  { group: 'pauseseite', name: 'pauseseite-vorlage', path: '/system/veroeffentlichung' },
  {
    group: 'pauseseite', name: 'pauseseite-vorlage-vorschau-dunkel', path: '/system/veroeffentlichung', full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Dunkel' }).click(); await pg.waitForTimeout(200) },
  },
  {
    group: 'pauseseite', name: 'pauseseite-pausieren', path: `/projekte/${L}?tab=einstellungen`,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Offline nehmen …' }).click()
      await pg.waitForTimeout(150)
      await pg.locator('.pause-draft input[id$="-title"]').fill('Wartung am Haushaltsbuch')
      await pg.locator('.pause-draft textarea').fill('Wir spielen ein **Update** ein.\n\nFragen? Schreib an [hallo@example.ch](mailto:hallo@example.ch).')
      await pg.locator('.pause-draft input[type="datetime-local"]').fill('2026-12-01T08:00')
      await pg.waitForTimeout(200)
    },
  },
  {
    // Nicht ganzseitig: beim Vergrössern für fullPage malt Chrome das iframe der Vorschau nur halb
    group: 'pauseseite', name: 'pauseseite-bearbeiten', path: `/projekte/${Z}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Pause-Seite bearbeiten …' }).click()
      await pg.locator('.pause-preview').scrollIntoViewIfNeeded()
      await pg.waitForTimeout(300)
    },
  },
  { group: 'veroeffentlichung', name: 'veroeffentlichung-gesperrt', path: `/projekte/${S}?tab=einstellungen`, full: false },
  {
    group: 'veroeffentlichung', name: 'veroeffentlichung-bestaetigen', path: `/projekte/${P}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Veröffentlichen …' }).click()
      await pg.waitForTimeout(150)
      await pg.getByRole('button', { name: 'Veröffentlichen …' }).click()
      await pg.waitForTimeout(250)
    },
  },
  {
    group: 'veroeffentlichung', name: 'veroeffentlichung-fortschritt', path: `/projekte/${P}?tab=einstellungen`, full: false, hang: [`POST /api/v1/projects/${P}/public`],
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Veröffentlichen …' }).click()
      await pg.waitForTimeout(150)
      await pg.getByRole('button', { name: 'Veröffentlichen …' }).click()
      await pg.getByRole('button', { name: 'Ja, veröffentlichen' }).click()
      await pg.waitForTimeout(900)
    },
  },
  { group: 'anfrage', name: 'anfrage-wartet', path: `/projekte/${fx.requestWaitingProjectId}?tab=einstellungen`, full: false },
  {
    group: 'anfrage', name: 'anfrage-wartet-bestaetigen', path: `/projekte/${fx.requestWaitingProjectId}?tab=einstellungen`, full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Nach dem Scan öffentlich schalten …' }).click(); await pg.waitForTimeout(200) },
  },
  { group: 'anfrage', name: 'anfrage-gesperrt', path: `/projekte/${fx.requestBlockedProjectId}?tab=einstellungen`, full: false },
  {
    group: 'veroeffentlichung', name: 'veroeffentlichung-offline-wahl', path: `/projekte/${L}?tab=einstellungen`, full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Offline nehmen …' }).click(); await pg.waitForTimeout(250) },
  },
  {
    group: 'veroeffentlichung', name: 'veroeffentlichung-toast', path: `/projekte/${L}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Offline nehmen …' }).click()
      await pg.getByRole('button', { name: 'Ja, pausieren' }).click()
      await pg.waitForTimeout(700)
    },
  },
  {
    group: 'veroeffentlichung', name: 'veroeffentlichung-menue', path: '/projekte', full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Aktionen für Haushaltsbuch' }).click()
      await pg.waitForTimeout(200)
      await pg.getByRole('menuitem', { name: 'Offline nehmen …' }).click()
      await pg.waitForTimeout(250)
    },
  },
  { group: 'zustaende', name: 'leer-projekte', path: '/projekte', empty: true },
  { group: 'zustaende', name: 'laden-projekte', path: '/projekte', full: false, hang: ['/api/v1/projects'] },
  { group: 'zustaende', name: 'api-offline', path: '/projekte', full: false, offline: true },
  {
    group: 'zustaende', name: 'rueckmeldung-deploy', path: '/projekte', full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Erneut deployen' }).first().click(); await pg.waitForTimeout(400); await pg.evaluate(() => window.scrollTo(0, 0)) },
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
            // nie beantwortet: Ladezustand («POST /pfad» nur für diese Methode)
            if (s.hang?.some((h) => url.pathname === h || `${route.request().method()} ${url.pathname}` === h)) return
            if (s.offline && url.pathname === '/api/v1/auth/me') return json(route, { error: { code: 'bad_gateway', message: 'nicht erreichbar' } }, 502)
            if (s.empty && url.pathname === '/api/v1/projects') return json(route, { projects: [] })
            if (s.empty && url.pathname === '/api/v1/audit') return json(route, { events: [] })
            // M8: GitHub-Seite in zwei Zuständen (noch nichts / installiert)
            if (url.pathname === '/api/v1/github') return json(route, fx.github(Boolean(s.githubConnected)))
            const r = api(url.pathname + url.search, route.request().method(), s.loggedIn !== false, t, s.count)
            return json(route, r.body, r.status)
          }
          if (url.pathname === '/health') return json(route, { ok: true })
          return route.continue()
        }
        // Erreichbarkeits-Prüfungen der Oberfläche: antworten, ohne das Netz zu fragen
        return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '' })
      })
      const page = await ctx.newPage()
      await page.goto(`http://localhost:${PORT}${s.path}`, { waitUntil: s.hang ? 'load' : 'networkidle' })
      if (s.hang) await page.waitForTimeout(800)
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
