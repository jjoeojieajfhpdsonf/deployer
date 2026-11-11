/**
 * Screenshots des Frontends in Hell und Dunkel bei 1440 px (nur Desktop).
 * Startet Vite selbst; die API kommt aus fixtures.ts (page.route), externe
 * Adressen antworten leer.
 *
 *   pnpm --filter @airlock/web exec tsx design-shots/shoot.ts --out docs/design-cal/3a-shell --only shell,login
 *
 *   --out    Zielordner relativ zum Repo (Standard docs/design-cal/aktuell)
 *   --only   Komma-Liste von Gruppen oder Namen (Standard: alle)
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'
import { chromium, type BrowserContext, type Page, type Route } from 'playwright'
import * as fx from './fixtures.js'
import { DEFAULT_PAUSE_PAGE } from '@airlock/shared'

const here = fileURLToPath(new URL('.', import.meta.url))
const webRoot = resolve(here, '..')
const repo = resolve(webRoot, '../..')

/** Port des Screenshot-Werkzeugs; die visuellen Tests (visual/) nehmen einen eigenen */
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
  // UI-Qualität 8: neues Token (einmal sichtbar) – Beispielwert, kein echtes Token
  if (method === 'POST' && p === '/tokens') {
    return { body: { token: 'apl_beispiel_7f3a9c21e04d51c0aa8e2d93b6', apiToken: { id: 't9', name: 'Claude Desktop', createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null } } }
  }
  if (method !== 'GET') return { body: {} }
  if (p === '/settings/pause-page') return { body: { page: fx.pausePageTemplate, defaults: DEFAULT_PAUSE_PAGE } }
  if ((m = p.match(/^\/projects\/([^/]+)\/public$/))) return { body: fx.publicStatus(m[1]!) }
  if ((m = p.match(/^\/projects\/([^/]+)\/public\/progress$/))) return { body: { progress: fx.publishProgress(m[1]!) } }
  if (p === '/projects') return { body: { projects: count === undefined ? fx.projects : fx.projectsFor(count) } }
  // Vor /projects/:id (sonst hielte es «name-preview» für eine Projekt-ID)
  if (p === '/projects/name-preview') return { body: { preview: fx.namePreview(u.searchParams.get('name') ?? '') } }
  if ((m = p.match(/^\/projects\/([^/]+)$/))) return { body: { project: fx.allProjects.find((x) => x.id === m![1]) ?? fx.projects[0], env: fx.env(m[1]!) } }
  if ((m = p.match(/^\/projects\/([^/]+)\/deployments$/))) return { body: { deployments: fx.deployments(m[1]!) } }
  if ((m = p.match(/^\/deployments\/([^/]+)$/))) {
    const d = fx.allProjects.flatMap((x) => [...fx.deployments(x.id), ...(x.lastDeployment ? [x.lastDeployment] : [])]).find((x) => x.id === m![1])
    return { body: { deployment: d, log: d?.status === 'failed' ? fx.logForFailure(d.errorMessage, d.id) : fx.deployLog } }
  }
  if ((m = p.match(/^\/projects\/([^/]+)\/health$/))) return { body: fx.health(m[1]!) }
  if ((m = p.match(/^\/projects\/([^/]+)\/logs$/))) return { body: { logs: fx.appLogs } }
  if ((m = p.match(/^\/projects\/([^/]+)\/log-lines$/))) return { body: fx.logLines(m[1]!, u.searchParams.get('service')) }
  if ((m = p.match(/^\/projects\/([^/]+)\/files$/))) return { body: fx.files(m[1]!) }
  if ((m = p.match(/^\/projects\/([^/]+)\/access$/))) return { body: fx.siteAccess(m[1]!) }
  if (p === '/system/expiry') return { body: { days: 30, fromEnv: 30, changed: false } }
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
  /** Kaputte Projektliste (Projekt ohne Felder): zeigt die Fehlerseite der Error Boundary */
  broken?: boolean
  /** M8: GitHub App angelegt und installiert */
  githubConnected?: boolean
  /** Cloudflare fertig eingerichtet (Zertifikat ausgestellt): Zusammenfassung statt Schritte */
  cfDone?: boolean
  /** CSP-Fix: CSP nach fehlgeschlagener Funktionsprüfung zurück auf Report-Only */
  cspReverted?: boolean
  /** API nicht erreichbar (/auth/me antwortet mit 502) */
  offline?: boolean
  /** Diese API-Pfade antworten nie (Ladezustand) */
  hang?: string[]
  /** Diese API-Pfade antworten mit 500 (Fehlerzustand) */
  fail?: string[]
  /** Scan-Bericht mit gescheiterter Stufe (Zustand «Teilweise») */
  stageFailed?: boolean
  /** Projektliste: Scan von Haushaltsbuch läuft (wie der Scan-Bericht dieses Projekts) */
  scanRunning?: boolean
  /** Angemeldet, aber mit anderen Angaben (z. B. Einrichtung noch nicht ausgeblendet) */
  me?: Partial<import('../src/api.js').MeDto>
  /** Leerer Speicher der Sitzung erzwingen (Assistent erscheint wie beim ersten Start) */
  freshSession?: boolean
  /** Feste Anzahl Projekte (fixtures.projectsFor) statt der Standardliste */
  count?: number
  /** Übergang deployer → Airlock: Projekt läuft noch mit alten Containern */
  legacy?: boolean
  /** Projekt patchen (GET /projects/:id), z. B. Ablauf in 5 Tagen */
  patch?: Partial<import('@airlock/shared').ProjectDto>
  prepare?: (page: Page) => Promise<void>
  /** Nur dieses Element aufnehmen (CSS-Selektor; mit 24 px Rand) */
  el?: string
  /** Erlaubte Pixelabweichung (visuelle Tests), wenn nur Kantenglättung schwankt – mit Begründung an der Szene */
  maxDiff?: number
}
const P = fx.detailProjectId
const S = fx.securityProjectId
const W = 'p-wetter'
const L = fx.liveProjectId
const Z = fx.pausedProjectId
const H = 'p-hallo'
const shots: Shot[] = [
  { group: 'shell', name: 'shell-profilmenue', path: '/projekte', full: false, prepare: async (pg) => { await pg.locator('.profile-trigger').click(); await pg.waitForTimeout(250) } },
  { group: 'login', name: 'login', path: '/projekte', loggedIn: false },
  { group: 'projekte', name: 'projekte', path: '/projekte' },
  { group: 'projekte', name: 'projekt-uebersicht', path: `/projekte/${P}` },
  { group: 'uebergang', name: 'projekt-alte-container', path: `/projekte/${P}`, full: false, legacy: true },
  { group: 'projekte', name: 'projekt-fehler', path: `/projekte/${W}` },
  // UI-Qualität 2: Fehler erklären – je Muster die Fehlerbox mit ihrer Aktion
  {
    group: 'fehler', name: 'fehler-build-claude', path: '/projekte/p-fehler-build', full: false, el: '.failure',
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Mit Claude lösen' }).click(); await pg.waitForTimeout(200) },
  },
  { group: 'fehler', name: 'fehler-port', path: '/projekte/p-fehler-port', full: false, el: '.failure' },
  {
    group: 'fehler', name: 'fehler-speicher', path: '/projekte/p-fehler-oom', full: false, el: '.failure',
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Grenze erhöhen' }).click(); await pg.waitForTimeout(200) },
  },
  { group: 'projekte', name: 'projekt-deployments', path: `/projekte/${P}?tab=deployments` },
  { group: 'projekte', name: 'projekt-logs', path: `/projekte/${P}?tab=logs` },
  // UI-Qualität 4: Suche mit Hervorhebung, Zeilennummern, nur Warnungen und Fehler; leerer Zustand
  {
    group: 'logs', name: 'logs-suche', path: `/projekte/${P}?tab=logs`, full: false, el: '.logs',
    prepare: async (pg) => {
      await pg.getByRole('searchbox', { name: 'Im Log suchen' }).fill('vorschau')
      await pg.getByRole('button', { name: 'Zeilennummern' }).click()
      await pg.waitForTimeout(150)
    },
  },
  {
    group: 'logs', name: 'logs-fehler', path: `/projekte/${P}?tab=logs`, full: false, el: '.logs',
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Warnungen und Fehler' }).click(); await pg.waitForTimeout(150) },
  },
  { group: 'logs', name: 'logs-leer', path: `/projekte/${W}?tab=logs`, full: false, el: '.logs' },
  { group: 'projekte', name: 'projekt-security', path: `/projekte/${S}?tab=security` },
  { group: 'security', name: 'projekt-security-laeuft', path: `/projekte/${fx.runningScanProjectId}?tab=security` },
  {
    group: 'security', name: 'projekt-security-laeuft-ausgabe', path: `/projekte/${fx.runningScanProjectId}?tab=security`, full: false,
    prepare: async (pg) => { await pg.locator('.live-scan .stage-tail summary').first().click(); await pg.waitForTimeout(200) },
  },
  // CSP-Fix: Analyse und gesperrtes Scharfschalten; Zustand nach automatischem Zurücksetzen
  {
    group: 'csp', name: 'security-csp-gesperrt', path: `/projekte/${S}?tab=security`, full: false,
    prepare: async (pg) => {
      await pg.locator('.csp-analysis').evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await pg.evaluate(() => window.scrollBy(0, -140))
      await pg.waitForTimeout(150)
    },
  },
  {
    group: 'csp', name: 'security-csp-zurueckgesetzt', path: `/projekte/${S}?tab=security`, full: false, cspReverted: true,
    prepare: async (pg) => {
      await pg.locator('#header-caddy-title').evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await pg.evaluate(() => window.scrollBy(0, -24))
      await pg.waitForTimeout(150)
    },
  },
  // M8: Header über Caddy – Rückfrage vor HSTS
  {
    group: 'fix', name: 'security-hsts-rueckfrage', path: `/projekte/${S}?tab=security`, full: false,
    prepare: async (pg) => {
      const b = pg.getByRole('button', { name: 'HSTS setzen', exact: true })
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
  // Kantenglättung der klebenden Sprungnavigation schwankt (wie veroeffentlichung-*), sichtbar gleich
  { group: 'projekte', name: 'projekt-einstellungen', path: `/projekte/${P}?tab=einstellungen`, maxDiff: 600 },
  {
    group: 'formulare', name: 'neues-projekt-validierung', path: '/projekte/neu',
    prepare: async (pg) => { await pg.locator('form button[type="submit"]').click(); await pg.waitForTimeout(200); await pg.evaluate(() => window.scrollTo(0, 0)) },
  },
  // UI-Qualität 5: Vorschau mit Kollision (Kurzname «fotoalbum» ist belegt), fünfte Quelle «Per Chat»,
  // Meldung beim Verlassen eines Felds (ohne Absenden)
  {
    group: 'formulare', name: 'neues-projekt-vorschau', path: '/projekte/neu', full: false,
    prepare: async (pg) => {
      await pg.getByLabel('Name', { exact: true }).fill('Fotoalbum')
      await pg.locator('.name-preview code').filter({ hasText: /^fotoalbum-2$/ }).waitFor()
      await pg.getByLabel('Image', { exact: true }).fill('nginx alpine')
      await pg.getByLabel('Port im Container').focus()
      await pg.waitForTimeout(200)
    },
  },
  { group: 'formulare', name: 'neues-projekt-chat', path: '/projekte/neu?quelle=chat', full: false },
  { group: 'formulare', name: 'konto', path: '/konto' },
  // UI-Qualität 8: Glocke, Sitzung abgelaufen, Rückfrage beim Verlassen, neues Token
  {
    group: 'sitzung', name: 'glocke', path: '/projekte', full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: /^Ereignisse/ }).click(); await pg.waitForTimeout(250) },
  },
  {
    group: 'sitzung', name: 'sitzung-abgelaufen', path: '/projekte', full: false,
    prepare: async (pg) => {
      await pg.route('**/api/v1/**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":{"code":"unauthorized","message":"Nicht angemeldet"}}' }))
      await pg.getByRole('link', { name: /^Audit/ }).first().click()
      await pg.getByRole('dialog', { name: 'Sitzung abgelaufen' }).waitFor()
      await pg.waitForTimeout(250)
    },
  },
  {
    group: 'sitzung', name: 'verlassen-rueckfrage', path: `/projekte/${P}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.locator('#set-umgebung').getByRole('button', { name: 'Variable hinzufügen' }).click()
      await pg.locator('#set-umgebung .env-row').last().locator('input').first().fill('API_KEY')
      await pg.getByRole('link', { name: /^Audit/ }).first().click()
      await pg.getByRole('dialog', { name: 'Änderungen verwerfen?' }).waitFor()
      await pg.waitForTimeout(250)
    },
  },
  {
    group: 'sitzung', name: 'tokens-neu', path: '/tokens', full: false,
    prepare: async (pg) => {
      await pg.getByLabel('Name des Tokens').fill('Claude Desktop')
      await pg.getByRole('button', { name: 'Token anlegen' }).click()
      await pg.getByRole('button', { name: 'Claude Desktop' }).click()
      await pg.waitForTimeout(200)
    },
  },
  { group: 'security', name: 'security-global', path: '/security' },
  // UI-Qualität 6: alte Adressen leiten weiter – /extern auf den Reiter unter Security, /domains in System
  { group: 'security', name: 'externe-ziele', path: '/extern' },
  { group: 'verwaltung', name: 'domains', path: '/domains', full: false },
  { group: 'system', name: 'system-cloudflare-fertig', path: '/system/cloudflare', cfDone: true },
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
    prepare: async (pg) => {
      // Stoppen liegt im «⋯»-Menü des Kopfs; die Rückfrage steht im Menü
      await pg.getByRole('button', { name: 'Weitere Aktionen' }).click()
      await pg.getByRole('menuitem', { name: /^Stoppen/ }).click()
      await pg.waitForTimeout(250)
    },
  },
  // Projektkopf: Öffnen (sekundär), Neu deployen (primär), «⋯» mit allem Weiteren
  { group: 'projektkopf', name: 'projektkopf', path: `/projekte/${P}`, full: false },
  {
    group: 'projektkopf', name: 'projektkopf-menue-laufend', path: `/projekte/${L}`, full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Weitere Aktionen' }).click(); await pg.waitForTimeout(300) },
  },
  {
    group: 'projektkopf', name: 'projektkopf-menue-gestoppt', path: '/projekte/p-notizen', full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Weitere Aktionen' }).click(); await pg.waitForTimeout(300) },
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
  // Kantenglättung der klebenden Sprungnavigation schwankt (bis rund 450 Pixel Text, sichtbar gleich)
  { group: 'veroeffentlichung', name: 'veroeffentlichung-live', path: `/projekte/${L}?tab=einstellungen`, maxDiff: 600 },
  { group: 'veroeffentlichung', name: 'veroeffentlichung-pausiert', path: `/projekte/${Z}?tab=einstellungen`, maxDiff: 600 },
  { group: 'pauseseite', name: 'pauseseite-vorlage', path: '/system/veroeffentlichung' },
  {
    group: 'pauseseite', name: 'pauseseite-vorlage-vorschau-dunkel', path: '/system/veroeffentlichung', full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Dunkel' }).click(); await pg.waitForTimeout(200) },
  },
  // Karte: die Pause-Seite ist eine Zeile mit «Anpassen …», auch solange das Projekt live ist
  { group: 'pauseseite', name: 'pauseseite-karte-live', path: `/projekte/${L}?tab=einstellungen`, full: false },
  {
    // Live: Seite schon vorab einstellen (ohne «Voraussichtlich zurück»)
    group: 'pauseseite', name: 'pauseseite-dialog-live', path: `/projekte/${L}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Anpassen', exact: true }).first().click()
      await pg.locator('.pause-dialog input[id$="-title"]').fill('Wartung am Haushaltsbuch')
      await pg.locator('.pause-dialog textarea').fill('Wir spielen ein **Update** ein.\n\nFragen? Schreib an [hallo@example.ch](mailto:hallo@example.ch).')
      await pg.waitForTimeout(300)
    },
  },
  {
    // Offline nehmen → Pausieren: Zusammenfassung der Seite statt Formular in der Karte
    group: 'pauseseite', name: 'pauseseite-pausieren', path: `/projekte/${L}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Offline nehmen', exact: true }).click()
      await pg.locator('.pause-summary').scrollIntoViewIfNeeded()
      await pg.waitForTimeout(200)
    },
  },
  {
    // Pausiert mit eigenem Code: Dialog mit «Voraussichtlich zurück»
    // Absturz von früher: Jahr 333333 im Datumsfeld – jetzt Feldmeldung statt schwarzer Seite
    group: 'fehler', name: 'pauseseite-datum-ungueltig', path: `/projekte/${Z}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Anpassen', exact: true }).first().click()
      await pg.locator('.pause-dialog').getByRole('button', { name: 'Formular', exact: true }).click()
      const f = pg.locator('.pause-dialog input[type="datetime-local"]')
      // Ganz links (Tag) beginnen, dann Tag, Monat und ein sechsstelliges Jahr wie im Absturz
      await f.click({ position: { x: 14, y: 20 } })
      await pg.keyboard.type('0303333333')
      await pg.waitForTimeout(300)
      const state = await f.evaluate((el: HTMLInputElement) => ({ value: el.value, bad: el.validity.badInput }))
      const msg = await pg.locator('.pause-dialog .field-error').allTextContents()
      const crashed = await pg.locator('.crash').count()
      console.log(`  Datumsfeld: value=${JSON.stringify(state.value)} badInput=${state.bad} Meldung=${JSON.stringify(msg)} Fehlerseite=${crashed}`)
      if (crashed) throw new Error('Fehlerseite statt Feldmeldung')
    },
  },
  // Error Boundary: kaputte Daten legen nur die Seite still, mit «Neu laden» und Details
  { group: 'fehler', name: 'fehlerseite', path: '/projekte', full: false, broken: true },
  {
    group: 'pauseseite', name: 'pauseseite-dialog-pausiert', path: `/projekte/${Z}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Anpassen', exact: true }).first().click()
      await pg.waitForTimeout(300)
    },
  },
  {
    // Eigener Code, Vorschau dunkel (Media-Queries für die Vorschau umgeschrieben)
    group: 'pauseseite', name: 'pauseseite-code-dunkel', path: `/projekte/${Z}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Anpassen', exact: true }).first().click()
      await pg.locator('.pause-dialog').getByRole('button', { name: 'Dunkel' }).click()
      await pg.waitForTimeout(300)
    },
  },
  {
    // Formular im Dialog: Felder im Raster
    group: 'pauseseite', name: 'pauseseite-dialog-formular', path: `/projekte/${Z}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Anpassen', exact: true }).first().click()
      await pg.locator('.pause-dialog').getByRole('button', { name: 'Formular', exact: true }).click()
      await pg.waitForTimeout(300)
    },
  },
  {
    // Vorlage: von Formular zu Code wechseln – das Codefeld beginnt mit dem HTML des Formulars
    group: 'pauseseite', name: 'pauseseite-vorlage-code', path: '/system/veroeffentlichung', full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Code', exact: true }).click(); await pg.waitForTimeout(250) },
  },
  { group: 'veroeffentlichung', name: 'veroeffentlichung-gesperrt', path: `/projekte/${S}?tab=einstellungen`, full: false },
  {
    group: 'veroeffentlichung', name: 'veroeffentlichung-bestaetigen', path: `/projekte/${P}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Veröffentlichen', exact: true }).click()
      await pg.waitForTimeout(150)
      await pg.getByRole('button', { name: 'Veröffentlichen', exact: true }).click()
      await pg.waitForTimeout(250)
    },
  },
  {
    group: 'veroeffentlichung', name: 'veroeffentlichung-fortschritt', path: `/projekte/${P}?tab=einstellungen`, full: false, hang: [`POST /api/v1/projects/${P}/public`],
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Veröffentlichen', exact: true }).click()
      await pg.waitForTimeout(150)
      await pg.getByRole('button', { name: 'Veröffentlichen', exact: true }).click()
      await pg.getByRole('button', { name: 'Ja, veröffentlichen' }).click()
      await pg.waitForTimeout(900)
    },
  },
  { group: 'anfrage', name: 'anfrage-wartet', path: `/projekte/${fx.requestWaitingProjectId}?tab=einstellungen`, full: false },
  {
    group: 'anfrage', name: 'anfrage-wartet-bestaetigen', path: `/projekte/${fx.requestWaitingProjectId}?tab=einstellungen`, full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Nach dem Scan öffentlich schalten', exact: true }).click(); await pg.waitForTimeout(200) },
  },
  { group: 'anfrage', name: 'anfrage-gesperrt', path: `/projekte/${fx.requestBlockedProjectId}?tab=einstellungen`, full: false },
  {
    group: 'veroeffentlichung', name: 'veroeffentlichung-offline-wahl', path: `/projekte/${L}?tab=einstellungen`, full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Offline nehmen', exact: true }).click(); await pg.waitForTimeout(250) },
  },
  {
    group: 'veroeffentlichung', name: 'veroeffentlichung-toast', path: `/projekte/${L}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Offline nehmen', exact: true }).click()
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
  // Projektseite im neuen Design (docs/design-cal/ui-projektseite)
  { group: 'p1', name: '1-deployments-karte-container', path: `/projekte/${P}`, el: 'section[aria-labelledby="ov-deploys"]' },
  { group: 'p1', name: '1-deployments-karte-statisch', path: `/projekte/${H}`, el: 'section[aria-labelledby="ov-deploys"]' },
  {
    group: 'p1', name: '1-deployments-reiter-aufgeklappt', path: `/projekte/${P}?tab=deployments`,
    prepare: async (pg) => {
      await pg.locator('.dl-group-toggle').first().click()
      await pg.getByRole('button', { name: 'Zurückrollen' }).first().click()
      await pg.waitForTimeout(300)
    },
  },
  { group: 'p2', name: '2-security-karte-offen', path: `/projekte/${H}`, el: 'section[aria-labelledby="ov-sec"]' },
  { group: 'p2', name: '2-security-karte-ohne-befunde', path: `/projekte/${P}`, el: 'section[aria-labelledby="ov-sec"]' },
  { group: 'p2', name: '2-security-karte-handlungsbedarf', path: `/projekte/${S}`, el: 'section[aria-labelledby="ov-sec"]' },
  { group: 'p3', name: '3-aktivitaet-karte', path: `/projekte/${H}`, el: 'section[aria-labelledby="ov-act"]' },
  { group: 'p3', name: '3-audit-log', path: '/audit', count: 7 },
  {
    group: 'p3', name: '3-audit-log-projekt-details', path: `/audit?projekt=${H}`, count: 7, full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Details' }).nth(2).click(); await pg.waitForTimeout(200) },
  },
  { group: 'p4', name: '4-eckdaten-statisch', path: `/projekte/${H}`, el: 'section[aria-labelledby="ov-facts"]' },
  { group: 'p4', name: '4-eckdaten-container', path: `/projekte/${P}`, el: 'section[aria-labelledby="ov-facts"]' },
  { group: 'p4', name: '4-eckdaten-ablauf-bald', path: `/projekte/${H}`, el: 'section[aria-labelledby="ov-facts"]', patch: { expiresAt: new Date(Date.now() + 5 * 86_400_000 - 3_600_000).toISOString() } },
  { group: 'p4', name: '4-eckdaten-unbegrenzt', path: `/projekte/${H}`, el: 'section[aria-labelledby="ov-facts"]', patch: { keep: true, expiresAt: null } },
  {
    group: 'p4', name: '4-eckdaten-dateien', path: `/projekte/${H}`, full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Dateien ansehen' }).click(); await pg.waitForTimeout(300) },
  },
  { group: 'p4', name: '4-system-frist', path: '/system', el: '.expiry-settings' },
  { group: 'p5', name: '5-reiter-container', path: `/projekte/${L}`, full: false },
  { group: 'p5', name: '5-reiter-statisch', path: `/projekte/${H}?tab=security`, full: false },
  {
    group: 'p5', name: '5-reiter-hover', path: `/projekte/${L}`, full: false,
    prepare: async (pg) => { await pg.getByRole('tab', { name: /^Deployments/ }).hover(); await pg.waitForTimeout(200) },
  },
  { group: 'p5', name: '5-zugriffe', path: `/projekte/${H}?tab=logs` },
  {
    group: 'p5', name: '5-zugriffe-4xx', path: `/projekte/${H}?tab=logs`, full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: /^4xx/ }).click(); await pg.waitForTimeout(150) },
  },
  { group: 'p6', name: '6-einstellungen-statisch', path: `/projekte/${H}?tab=einstellungen` },
  { group: 'p6', name: '6-einstellungen-container', path: `/projekte/${P}?tab=einstellungen` },
  {
    group: 'p6', name: '6-einstellungen-gespeichert', path: `/projekte/${H}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('switch', { name: 'Heimnetz (LAN)' }).click()
      await pg.waitForTimeout(500)
      await pg.locator('#set-erreichbarkeit').evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await pg.waitForTimeout(200)
    },
  },
  {
    group: 'p6', name: '6-einstellungen-access-rueckfrage', path: `/projekte/${H}?tab=einstellungen`, full: false,
    prepare: async (pg) => { await pg.getByRole('switch', { name: 'Cloudflare Access' }).click(); await pg.waitForTimeout(250) },
  },
  {
    group: 'p6', name: '6-einstellungen-header-offen', path: `/projekte/${P}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'aufklappen' }).click()
      await pg.waitForTimeout(300)
      await pg.locator('#set-header').evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await pg.waitForTimeout(400)
    },
  },
  {
    group: 'p6', name: '6-einstellungen-gefahrenzone', path: `/projekte/${H}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('link', { name: 'Gefahrenzone' }).click()
      await pg.waitForTimeout(600)
      await pg.getByRole('button', { name: 'Projekt löschen …' }).click()
      await pg.waitForTimeout(300)
    },
  },
  // Etappe 1 (UI-Grundlagen): fünf Zustände
  { group: 'zustand', name: 'zustand-laden-projektseite', path: `/projekte/${P}`, full: false, hang: [`/api/v1/projects/${P}`] },
  { group: 'zustand', name: 'zustand-laden-audit', path: '/audit', full: false, hang: ['/api/v1/audit'] },
  { group: 'zustand', name: 'zustand-fehler-projekte', path: '/projekte', full: false, fail: ['/api/v1/projects'] },
  { group: 'zustand', name: 'zustand-fehler-karte', path: `/projekte/${P}`, full: false, fail: [`/api/v1/projects/${P}/deployments`, '/api/v1/audit'] },
  { group: 'zustand', name: 'zustand-leer-audit', path: '/audit', full: false, empty: true },
  { group: 'zustand', name: 'zustand-teilweise-scan', path: `/projekte/${S}?tab=security`, full: false, stageFailed: true },
  {
    // Veraltet: Seite geladen, danach antwortet der Server nicht mehr
    group: 'zustand', name: 'zustand-veraltet', path: '/projekte', full: false,
    prepare: async (pg) => {
      await pg.route('**/api/v1/**', (r) => r.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' }))
      await pg.waitForTimeout(2200)
      // Ohne Sekunden-Polling (UI-Qualität 3) lädt nur Veraltetes neu: Uhr 5 s vor, damit die Daten
      // älter als staleTime sind (die Screenshot-Tests halten die Uhr sonst fest)
      await pg.clock.setFixedTime(await pg.evaluate(() => Date.now() + 5_000))
      // react-query lauscht auf window «visibilitychange» (Fenster wieder sichtbar → neu laden)
      await pg.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
      await pg.locator('.stale-bar').waitFor({ timeout: 8000 })
      await pg.waitForTimeout(200)
    },
  },
  // Etappe 2 (UI-Grundlagen): Rückmeldung bei Aktionen
  {
    group: 'aktion', name: 'aktion-vorgaenge', path: '/projekte', full: false, scanRunning: true,
    prepare: async (pg) => { await pg.locator('.activity-trigger').click(); await pg.waitForTimeout(400) },
  },
  {
    group: 'aktion', name: 'aktion-knopf-laedt', path: `/projekte/${H}?tab=einstellungen`, full: false, hang: [`PATCH /api/v1/projects/${H}`],
    prepare: async (pg) => {
      const b = pg.getByRole('button', { name: 'Behalten', exact: true })
      await b.scrollIntoViewIfNeeded()
      await b.click()
      await pg.waitForTimeout(300)
    },
  },
  {
    group: 'aktion', name: 'aktion-rueckgaengig', path: `/projekte/${H}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Behalten', exact: true }).click()
      await pg.locator('[data-sonner-toast]').first().waitFor()
      await pg.waitForTimeout(500)
    },
  },
  {
    group: 'aktion', name: 'aktion-fehler-toast', path: '/projekte', full: false, fail: ['POST /api/v1/projects/p-wetter/deploy'],
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Erneut deployen' }).first().click()
      await pg.locator('[data-sonner-toast][data-type="error"]').first().waitFor()
      await pg.waitForTimeout(500)
    },
  },
  // Etappe 7: Erster Start – der Assistent öffnet sich von der Startseite aus von selbst
  { group: 'start', name: 'einrichtung', path: '/projekte', me: { passwordSource: 'env', setup: null } },
  {
    group: 'start', name: 'einrichtung-uebersprungen', path: '/einrichtung', full: false,
    me: { passwordSource: 'env', setup: { dismissed: false, skipped: ['adressen'] } },
  },
  { group: 'start', name: 'einrichtung-system', path: '/system', full: false, me: { passwordSource: 'env', setup: { dismissed: true, skipped: [] } } },
  // Etappe 6: Befehlspalette und Tastatur
  {
    group: 'tastatur', name: 'palette', path: '/projekte', full: false,
    prepare: async (pg) => { await pg.keyboard.press('ControlOrMeta+k'); await pg.waitForTimeout(400) },
  },
  {
    group: 'tastatur', name: 'palette-suche', path: '/projekte', full: false,
    prepare: async (pg) => { await pg.keyboard.press('ControlOrMeta+k'); await pg.keyboard.type('haus'); await pg.keyboard.press('ArrowDown'); await pg.waitForTimeout(400) },
  },
  {
    group: 'tastatur', name: 'palette-offline', path: '/projekte', full: false,
    prepare: async (pg) => {
      await pg.keyboard.press('ControlOrMeta+k')
      await pg.keyboard.type('offline haus')
      await pg.keyboard.press('Enter')
      await pg.waitForTimeout(400)
    },
  },
  {
    group: 'tastatur', name: 'kuerzel', path: '/projekte', full: false,
    prepare: async (pg) => { await pg.locator('body').click({ position: { x: 5, y: 600 } }); await pg.keyboard.press('Shift+?'); await pg.waitForTimeout(400) },
  },
  // Etappe 4: Komponenten-Übersicht
  { group: 'design', name: 'design-bausteine', path: '/design' },
  { group: 'zustaende', name: 'leer-projekte', path: '/projekte', empty: true },
  { group: 'zustaende', name: 'laden-projekte', path: '/projekte', full: false, hang: ['/api/v1/projects'] },
  { group: 'zustaende', name: 'api-offline', path: '/projekte', full: false, offline: true },
  {
    group: 'zustaende', name: 'rueckmeldung-deploy', path: '/projekte', full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Erneut deployen' }).first().click(); await pg.waitForTimeout(400); await pg.evaluate(() => window.scrollTo(0, 0)) },
  },
]

export { shots }
export type { Shot }

/** Optionen des Browser-Kontexts für eine Aufnahme (Desktop, 1440 px) */
export const contextOptions = (t: 'light' | 'dark') => ({
  viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' as const, locale: 'de-CH', timezoneId: 'Europe/Zurich', colorScheme: t,
})

/**
 * Theme setzen und die API aus den Fixtures beantworten (page.route auf dem
 * Kontext). Gemeinsam für shoot.ts und die visuellen Tests (visual/).
 */
export async function installRoutes(ctx: BrowserContext, s: Shot, t: 'light' | 'dark', port = PORT): Promise<void> {
      await ctx.addInitScript({ content: `try { localStorage.setItem('airlock.theme', '${t}') } catch {}` })
      // UI-Qualität 4: Live-Ströme der Reiter «Logs» und «Zugriffe» stehen offen (ohne neue Zeilen) –
      // ohne Server würden sie sofort abbrechen und «Live-Verbindung unterbrochen» zeigen
      await ctx.addInitScript({ content: `(() => {
        const Real = window.EventSource
        window.EventSource = function (url, init) {
          if (!/\\/(logs|access)\\/stream/.test(String(url))) return new Real(url, init)
          const es = { url: String(url), readyState: 0, onopen: null, onmessage: null, onerror: null,
            addEventListener() {}, removeEventListener() {}, close() { es.readyState = 2 } }
          setTimeout(() => { es.readyState = 1; es.onopen && es.onopen({}) }, 0)
          return es
        }
        window.EventSource.CLOSED = 2; window.EventSource.OPEN = 1; window.EventSource.CONNECTING = 0
      })()` })
      await ctx.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if ((url.port === String(port) && url.hostname === 'localhost') || url.hostname === '127.0.0.1') {
          if (url.pathname.startsWith('/api/')) {
            // nie beantwortet: Ladezustand («POST /pfad» nur für diese Methode)
            if (s.hang?.some((h) => url.pathname === h || `${route.request().method()} ${url.pathname}` === h)) return
            if (s.offline && url.pathname === '/api/v1/auth/me') return json(route, { error: { code: 'bad_gateway', message: 'nicht erreichbar' } }, 502)
            if (s.me && url.pathname === '/api/v1/auth/me' && route.request().method() === 'GET') return json(route, { ...fx.me, theme: t, ...s.me })
            if (s.scanRunning && url.pathname === '/api/v1/projects' && route.request().method() === 'GET') {
              const list = (api(url.pathname, 'GET', true, t, s.count).body as { projects: import('@airlock/shared').ProjectDto[] }).projects
              return json(route, { projects: list.map((x) => (x.id === fx.runningScanProjectId && x.security ? { ...x, security: { ...x.security, status: 'running' as const } } : x)) })
            }
            if (s.fail?.includes(url.pathname) || s.fail?.includes(`${route.request().method()} ${url.pathname}`)) return json(route, { error: { code: 'internal', message: 'Datenbank antwortet nicht (Zeitüberschreitung nach 5 s).' } }, 500)
            if (s.stageFailed && /\/scans\/latest$/.test(url.pathname)) {
              const r = api(url.pathname + url.search, 'GET', true, t, s.count).body as { report: import('@airlock/shared').ScanReportDto | null }
              if (r.report) {
                const st = r.report.scan.stages
                const key = Object.keys(st).find((k) => k.startsWith('nuclei')) ?? Object.keys(st).at(-1)!
                st[key] = { ...st[key]!, ran: false, failed: true, state: 'failed', note: 'Nuclei-Container nach 3 Versuchen nicht gestartet (Image-Pull verweigert)' }
              }
              return json(route, r)
            }
            if (s.empty && url.pathname === '/api/v1/projects') return json(route, { projects: [] })
            if (s.broken && url.pathname === '/api/v1/projects') return json(route, { projects: [{ id: 'kaputt', name: 'Kaputt' }] })
            if (url.pathname === '/api/v1/client-errors') return route.fulfill({ status: 204, body: '' })
            if (s.empty && url.pathname === '/api/v1/audit') return json(route, { events: [] })
            // M8: GitHub-Seite in zwei Zuständen (noch nichts / installiert)
            if (url.pathname === '/api/v1/github') return json(route, fx.github(Boolean(s.githubConnected)))
            if (s.cfDone && url.pathname === '/api/v1/system/cloudflare') return json(route, { ...fx.cloudflare, tls: { ...fx.cloudflare.tls, phase: 'done' } })
            if (s.cspReverted && url.pathname.endsWith('/header-rules')) return json(route, fx.headerRules(fx.securityProjectId, true))
            const r = api(url.pathname + url.search, route.request().method(), s.loggedIn !== false, t, s.count)
            if (s.legacy && /^\/api\/v1\/projects\/[^/]+$/.test(url.pathname) && route.request().method() === 'GET') {
              const b = r.body as { project: object }
              return json(route, { ...b, project: { ...b.project, legacyContainers: true } })
            }
            if (s.patch && /^\/api\/v1\/projects\/[^/]+$/.test(url.pathname) && route.request().method() === 'GET') {
              const b = r.body as { project: object }
              return json(route, { ...b, project: { ...b.project, ...s.patch } })
            }
            return json(route, r.body, r.status)
          }
          if (url.pathname === '/health') return json(route, { ok: true })
          return route.continue()
        }
        // Erreichbarkeits-Prüfungen der Oberfläche: antworten, ohne das Netz zu fragen
        return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '' })
      })
}

/** Seite öffnen, auf Daten und Schriften warten, Szene vorbereiten. */
export async function openShot(page: Page, s: Shot, port = PORT): Promise<void> {
      await page.goto(`http://localhost:${port}${s.path}`, { waitUntil: s.hang ? 'load' : 'networkidle' })
      if (s.hang) await page.waitForTimeout(800)
      // Fehlerzustand erscheint erst nach dem einen Wiederholversuch (retry: 1)
      if (s.fail?.some((f) => f.startsWith('/'))) {
        await page.locator('.error-state').first().waitFor({ timeout: 8000 })
        // Mehrere Abfragen scheitern unabhängig (je mit Wiederholversuch nach rund 1 s): alle abwarten
        await page.locator('.error-state').nth(s.fail.filter((f) => f.startsWith('/')).length - 1).waitFor({ timeout: 8000 })
      }
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(300)
      if (s.prepare) await s.prepare(page)
}

// Als Skript gestartet (nicht importiert): Screenshots in einen Ordner schreiben
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const { values: args } = parseArgs({ options: { out: { type: 'string' }, only: { type: 'string' } } })
const outDir = resolve(repo, args.out ?? 'docs/design-cal/aktuell')
mkdirSync(outDir, { recursive: true })
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
      const ctx = await browser.newContext(contextOptions(t))
      await installRoutes(ctx, s, t)
      const page = await ctx.newPage()
      await openShot(page, s)
      const file = join(outDir, `${s.name}-${theme}.png`)
      if (s.el) {
        const box = await page.locator(s.el).first().boundingBox()
        if (!box) throw new Error(`${s.name}: ${s.el} nicht gefunden`)
        const pad = 24
        await page.screenshot({ path: file, fullPage: true, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad } })
      } else {
        await page.screenshot({ path: file, fullPage: s.full !== false })
      }
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
}
