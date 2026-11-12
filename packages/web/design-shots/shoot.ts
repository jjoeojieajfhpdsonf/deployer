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
import { accessFixture, type AccessVariant } from './fixtures-access.js'
import { createHash } from 'node:crypto'
import { DEFAULT_PAUSE_PAGE, renderSnakePage, renderStatusFeed, renderStatusPage, snakeCsp, STATUS_CSS, STATUS_FILES, STATUS_JS } from '@airlock/shared'

const here = fileURLToPath(new URL('.', import.meta.url))
const webRoot = resolve(here, '..')
const repo = resolve(webRoot, '../..')

/** Port des Screenshot-Werkzeugs; die visuellen Tests (visual/) nehmen einen eigenen. SHOOT_PORT=… für parallele Worktrees */
const PORT = Number(process.env.SHOOT_PORT) || 5199
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

/** Antwort der API aus den Fixtures; unbekannte Pfade: leeres Objekt. */
/** Darstellung einer Aufnahme; «win95» ist das versteckte Theme (dann auch freigeschaltet) */
export type ShotTheme = 'light' | 'dark' | 'win95' | 'terminal'
/** Versteckte Themes sind in ihrer Aufnahme freigeschaltet (nur das eigene) */
const unlocksFor = (t: ShotTheme): import('@airlock/shared').UnlockId[] => (t === 'win95' || t === 'terminal' ? [t] : [])

function api(path: string, method: string, loggedIn: boolean, theme: ShotTheme, count?: number): { status?: number; body: unknown } {
  const u = new URL(path, 'http://x')
  const full = u.pathname.replace(/^\/api\/v1/, '')
  if (full === '/auth/me') return { body: loggedIn ? { ...fx.me, theme, unlocks: unlocksFor(theme) } : { loggedIn: false, theme: null } }
  // Etappe 7: Achievements (alle schon gemeldet; Szene «achievement-neu» mit einem frischen)
  if (full === '/auth/achievements') return { body: fx.achievements() }
  let m: RegExpMatchArray | null
  // M9: Umgebungen; Pfade unter /environments/<slug>/… wie die bisherigen beantworten
  if (full === '/environments') return { body: { environments: fx.environments } }
  const envSlug = full.match(/^\/environments\/([^/]+)/)?.[1] ?? null
  const p = envSlug ? full.replace(/^\/environments\/[^/]+/, '') || '/' : full
  if (envSlug && p === '/') return { body: { environment: fx.environments.find((e) => e.slug === envSlug) } }
  if (envSlug && p === '/cloudflare') return { body: envSlug === 'labor' ? fx.cloudflareLabor : fx.cloudflare }
  if (envSlug && p === '/header-templates') return { body: { templates: fx.headerTemplates } }
  if (envSlug && p === '/lan-dns') return { body: fx.lanDns }
  // Etappe 5: Statusseite der Umgebung und Störungen
  if (envSlug && p === '/status-page' && method === 'GET') return { body: { statusPage: fx.statusPage(envSlug) } }
  if (envSlug && p === '/incidents' && method === 'GET') return { body: { incidents: fx.incidents(envSlug) } }
  if (envSlug === 'labor' && p === '/projects') return { body: { projects: [] } }
  if ((m = p.match(/^\/projects\/([^/]+)\/move$/)) && method === 'GET') return { body: { preview: fx.movePreview(m[1]!, u.searchParams.get('to') ?? 'verein') } }
  if (method === 'POST' && (m = p.match(/^\/projects\/([^/]+)\/public\/pause$/))) return { body: fx.pauseResult(m[1]!) }
  // UI-Qualität 8: neues Token (einmal sichtbar) – Beispielwert, kein echtes Token
  if (method === 'POST' && p === '/tokens') {
    return { body: { token: 'apl_beispiel_7f3a9c21e04d51c0aa8e2d93b6', apiToken: { id: 't9', name: 'Claude Desktop', createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null } } }
  }
  if (method !== 'GET') return { body: {} }
  if (p === '/settings/pause-page') return { body: { page: fx.pausePageTemplate, defaults: DEFAULT_PAUSE_PAGE } }
  if ((m = p.match(/^\/projects\/([^/]+)\/public$/))) return { body: fx.publicStatus(m[1]!) }
  // Prüfung öffentlicher Namen: mit Projekt (Veröffentlichung) und in der Umgebung (Neues Projekt)
  if ((m = p.match(/^(?:\/projects\/([^/]+))?\/public\/check$/))) {
    const q = u.searchParams
    return { body: { check: fx.publicCheck(m[1] ?? null, q.get('name') ?? '', q.get('zone') ?? 'example.ch', q.get('apex') === '1') } }
  }
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
  if ((m = p.match(/^\/projects\/([^/]+)\/topology$/))) return { body: { topology: fx.topology(m[1]!) } }
  if ((m = p.match(/^\/projects\/([^/]+)\/logs$/))) return { body: { logs: fx.appLogs } }
  if ((m = p.match(/^\/projects\/([^/]+)\/log-lines$/))) return { body: fx.logLines(m[1]!, u.searchParams.get('service')) }
  if ((m = p.match(/^\/projects\/([^/]+)\/files$/))) return { body: fx.files(m[1]!) }
  if (p === '/system/expiry') return { body: { days: 30, fromEnv: 30, changed: false } }
  if ((m = p.match(/^\/projects\/([^/]+)\/scans\/latest$/))) return { body: { report: fx.scan(m[1]!, u.searchParams.get('done') === '1') } }
  if ((m = p.match(/^\/projects\/([^/]+)\/scans$/))) return { body: { scans: fx.scanHistory(m[1]!) } }
  // M8: Fix-Assistent
  if ((m = p.match(/^\/projects\/([^/]+)\/header-rules$/))) return { body: fx.headerRules(m[1]!) }
  if ((m = p.match(/^\/projects\/([^/]+)\/fix-requests$/))) return { body: { fixes: fx.fixRequests(m[1]!) } }
  if ((m = p.match(/^\/projects\/([^/]+)\/auto-deploy$/))) return { body: fx.autoDeploy(m[1]!) }
  // Etappe 6: Vorschauen (Standard: aus; Szenen mit s.previews: an/leer)
  if ((m = p.match(/^\/projects\/([^/]+)\/previews$/))) return { body: fx.previews(m[1]!) }
  if ((m = p.match(/^\/projects\/([^/]+)\/preview-env$/))) return { body: fx.previewEnv(m[1]!) }
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
  /** Leere Daten (keine Projekte, kein Audit-Log) */
  empty?: boolean
  /** Kaputte Projektliste (Projekt ohne Felder): zeigt die Fehlerseite der Error Boundary */
  broken?: boolean
  /** M8: GitHub App angelegt und installiert */
  githubConnected?: boolean
  /** Cloudflare fertig eingerichtet (Zertifikat ausgestellt): Zusammenfassung statt Schritte */
  cfDone?: boolean
  /** Meilenstein Backup: Zustand von Server › Backup (Standard: eingerichtet, mit Läufen) */
  backup?: fx.BackupVariant
  /** CSP-Fix: CSP nach fehlgeschlagener Funktionsprüfung zurück auf Report-Only */
  cspReverted?: boolean
  /** Antwort 7: Scan-Bericht mit einem ZAP-Befund zur CSP-Qualität (10055) */
  cspQuality?: boolean
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
  /** Umgebung mit zwei Zonen (Domain-Auswahl im Feld «Öffentliche Adresse») */
  zones2?: boolean
  /** Feste Anzahl Projekte (fixtures.projectsFor) statt der Standardliste */
  count?: number
  /** Übergang deployer → Airlock: Projekt läuft noch mit alten Containern */
  legacy?: boolean
  /** Projekt patchen (GET /projects/:id), z. B. Ablauf in 5 Tagen */
  patch?: Partial<import('@airlock/shared').ProjectDto>
  /** M9: Standard-Umgebung «example» patchen (z. B. sehr langer Name für den Umschalter) */
  envPatch?: Partial<import('@airlock/shared').EnvironmentDto>
  prepare?: (page: Page) => Promise<void>
  /** Nur dieses Element aufnehmen (CSS-Selektor; mit 24 px Rand) */
  el?: string
  /** Erlaubte Pixelabweichung (visuelle Tests), wenn nur Kantenglättung schwankt – mit Begründung an der Szene */
  maxDiff?: number
  /**
   * Etappe 3: Besucher-Auswertung (GET /projects/:id/traffic, /traffic/today). Ohne Angabe
   * antworten diese Pfade leer – die Oberfläche verhält sich dann wie «nicht eingerichtet»
   * (keine Karte, keine Zahl in der Liste), die übrigen Szenen bleiben unverändert.
   */
  traffic?: fx.TrafficVariant
  /** Zugriffe neu: Zugriffs-Log leer, wartet auf die Datei oder nicht eingerichtet (ohne: Daten nach Vorlage) */
  access?: AccessVariant
  /** Etappe 4: Aufbau von Fotoalbum in einem Zustand (Dienst wird erstellt, PR offen …) */
  topo?: fx.TopoVariant
  /** Etappe 4: Live-Strom liefert feste Anfragen (fx.trafficLive), sobald der Aufbau steht */
  live?: boolean
  /**
   * Etappe 5: die öffentliche Statusseite selbst (eigenes HTML/CSS/JS aus
   * @airlock/shared, nicht die Oberfläche) unter /__statusseite/ mit diesen Daten
   */
  statusPage?: 'stoerung' | 'ruhig'
  /** Etappe 6: Vorschauen am Projekt an (mit drei Vorschauen) oder an und noch leer */
  previews?: fx.PreviewVariant
  /** Etappe 7: Disketti eingeschaltet (in den Fixtures sonst aus) */
  disketti?: boolean
  /** Etappe 7: Matrix-Regen eingeschaltet und als festes Bild gezeichnet (auch bei reduzierter Bewegung) */
  matrix?: boolean
  /** Etappe 7: die Snake-Seite für unbekannte interne Namen unter /__snake/ (mit ihrer CSP, fester Zufall) */
  snake?: boolean
  /** Etappe 7: ein eben erreichtes, noch nicht gemeldetes Achievement */
  achievementNew?: boolean
}
const P = fx.detailProjectId
const S = fx.securityProjectId
const W = 'p-wetter'
const L = fx.liveProjectId
const Z = fx.pausedProjectId
const H = 'p-hallo'
/** Besucher zusammen: Einzelaufrufe der statischen Seite hallo-welt */
const EINZELN = `/projekte/${H}?tab=besucher&ansicht=einzeln`

/** Etappe 6: Vorschau-Deploys (Reiter Deployments und Einstellungen) */
function previewShots(group: string): Shot[] {
  const dep = `/u/example/projekte/${P}?tab=deployments`
  const set = `/u/example/projekte/${P}?tab=einstellungen`
  const toSection = async (pg: Page) => {
    await pg.locator('section[aria-labelledby="pv-title"]').evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await pg.evaluate(() => window.scrollBy(0, -24))
    await pg.waitForTimeout(250)
  }
  const toSettings = async (pg: Page) => {
    await pg.locator('#set-vorschauen').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await pg.waitForTimeout(300)
  }
  // Nur der Abschnitt (el): beim Scrollen ans Seitenende lag die feste Seitenleiste sonst je nach Lauf
  // um Bruchteile eines Pixels anders (flackernder Vergleich)
  const section = 'section[aria-labelledby="pv-title"]'
  return [
    { group, name: 'vorschauen', path: dep, previews: 'an', el: section, prepare: toSection },
    {
      group, name: 'vorschauen-loeschen', path: dep, previews: 'an', el: section,
      prepare: async (pg) => {
        await toSection(pg)
        await pg.getByRole('button', { name: 'Vorschau galerie-raster löschen …' }).click()
        await pg.waitForTimeout(250)
      },
    },
    { group, name: 'vorschauen-leer', path: dep, previews: 'leer', el: section, prepare: toSection },
    { group, name: 'vorschauen-aus', path: dep, el: section, prepare: toSection },
    { group, name: 'vorschauen-einstellungen', path: set, previews: 'an', el: '#set-vorschauen', prepare: toSettings },
    {
      group, name: 'vorschauen-variablen', path: set, previews: 'an', el: '#set-vorschauen',
      prepare: async (pg) => {
        await toSettings(pg)
        await pg.locator('#set-vorschauen').getByRole('button', { name: 'Bearbeiten' }).click()
        await pg.locator('#set-vorschauen form').evaluate((el) => el.scrollIntoView({ block: 'center' }))
        await pg.waitForTimeout(250)
      },
    },
    { group, name: 'vorschauen-nicht-moeglich', path: `/u/example/projekte/${H}?tab=einstellungen`, el: '#set-vorschauen', prepare: toSettings },
  ]
}

/**
 * Etappe 7: Spass-Paket – Terminal freischalten («sudo» in ⌘K), Matrix-Regen (festes Bild),
 * Achievements im Konto und als Meldung, Snake-Seite, Disketti (nur Windows 95: Befund,
 * gescheiterter Deploy, «Ja» öffnet den Ablauf).
 */
function spassShots(group: string): Shot[] {
  const bubble = async (pg: Page) => { await pg.locator('.disketti-bubble').waitFor(); await pg.waitForTimeout(250) }
  return [
    {
      group, name: 'terminal-freigeschaltet', path: '/projekte', full: false, me: { unlocks: [] },
      prepare: async (pg) => {
        await pg.keyboard.press('ControlOrMeta+k')
        await pg.keyboard.type('sudo')
        await pg.getByRole('option', { name: /Terminal/ }).waitFor()
        await pg.waitForTimeout(300)
      },
    },
    { group, name: 'matrix-regen', path: '/projekte', full: false, matrix: true, prepare: async (pg) => { await pg.locator('canvas.matrix-rain').waitFor(); await pg.waitForTimeout(250) } },
    { group, name: 'konto-achievements', path: '/konto', el: 'section[aria-labelledby="ach-title"]' },
    { group, name: 'achievement-neu', path: '/projekte', full: false, achievementNew: true, prepare: async (pg) => { await pg.getByText('Achievement: Nachtschicht').waitFor(); await pg.waitForTimeout(400) } },
    { group, name: 'snake-404', path: '/__snake/', snake: true, loggedIn: false, full: false, prepare: async (pg) => { await pg.locator('#game:not([hidden])').waitFor(); await pg.waitForTimeout(200) } },
    { group, name: 'disketti', path: `/projekte/${S}`, full: false, disketti: true, prepare: bubble },
    { group, name: 'disketti-fehler', path: '/projekte/p-fehler-build', full: false, disketti: true, prepare: bubble },
    {
      group, name: 'disketti-ja', path: `/projekte/${S}`, full: false, disketti: true,
      prepare: async (pg) => {
        await bubble(pg)
        await pg.locator('.disketti-bubble').getByRole('button', { name: 'Ja', exact: true }).click()
        await pg.locator('.sec-detail .claude-fix').first().waitFor()
        // «Ja» springt zum Befund, während die Detailkarte noch wächst – das Ziel schwankte je nach
        // Zeitpunkt um ~50 px. Für ein festes Bild: nach dem Laden selbst an den Anfang der Unternavigation
        await pg.waitForTimeout(300)
        await pg.evaluate(() => document.querySelector('.sec-detail')?.closest('section, .panel, div')?.scrollIntoView({ block: 'start', behavior: 'instant' }))
        await pg.waitForFunction(() => new Promise<boolean>((r) => { const y = window.scrollY; setTimeout(() => r(window.scrollY === y), 200) }))
      },
    },
  ]
}

/** Etappe 4: Szenen des Aufbaus mit Live-Verkehr und «Dienst hinzufügen/entfernen» (Präfix für die Ergebnisbilder) */
function aufbau2Shots(group: string, prefix = ''): Shot[] {
  const path = `/projekte/${P}?tab=aufbau`
  const n = (name: string) => (prefix ? `${prefix}${name.replace(/^aufbau-/, '')}` : name)
  const openAdd = async (pg: Page) => {
    await pg.locator('.topo-head .button-small', { hasText: 'Dienst' }).click()
    await pg.locator('.dialog .svc-templates').waitFor()
    await pg.locator('.svc-template', { hasText: 'Redis' }).click()
    await pg.getByRole('checkbox', { name: 'worker' }).check()
    await pg.waitForTimeout(250)
  }
  const pick = (id: string) => async (pg: Page) => { await pg.locator(`.topo-node[data-node="${id}"]`).first().click(); await pg.waitForTimeout(200) }
  const shots: Shot[] = [
    { group, name: n('aufbau-live'), path, live: true, full: false, prepare: async (pg) => { await pg.locator('.topo-rate').first().waitFor(); await pg.waitForTimeout(300) } },
    {
      group, name: n('aufbau-live-vergroessert'), path, live: true, full: false,
      prepare: async (pg) => {
        await pg.locator('.topo-rate').first().waitFor()
        await pg.getByRole('button', { name: 'Vergrössern' }).click()
        await pg.locator('.dialog-full .topo-rate').first().waitFor()
        await pg.waitForTimeout(300)
      },
    },
    { group, name: n('aufbau-dienst-dialog'), path, full: false, prepare: openAdd },
    {
      group, name: n('aufbau-dienst-diff'), path, full: false,
      prepare: async (pg) => {
        await openAdd(pg)
        await pg.getByRole('button', { name: 'Weiter: Änderung ansehen' }).click()
        await pg.locator('.dialog .diff').waitFor()
        await pg.waitForTimeout(250)
      },
    },
    { group, name: n('aufbau-dienst-wird-erstellt'), path, full: false, topo: 'wird-erstellt', patch: { sourceType: 'files', source: { type: 'files' } as never }, prepare: pick('pending:c-1') },
    { group, name: n('aufbau-dienst-pr-offen'), path, full: false, topo: 'pr-offen', prepare: pick('pending:c-2') },
    { group, name: n('aufbau-dienst-gescheitert'), path, full: false, topo: 'gescheitert', patch: { sourceType: 'files', source: { type: 'files' } as never }, prepare: pick('pending:c-1') },
    { group, name: n('aufbau-ohne-github'), path, full: false, topo: 'ohne-github' },
    { group, name: n('aufbau-adminer'), path, full: false, topo: 'adminer', prepare: pick('host:adminer--fotoalbum.int.example.ch') },
    {
      // Chat-Projekt: Volume löschen wählbar, standardmässig aus (bei Git-Projekten bleibt es immer)
      group, name: n('aufbau-dienst-entfernen'), path, full: false, topo: 'chat', patch: { sourceType: 'files', source: { type: 'files' } as never },
      prepare: async (pg) => {
        await pick('svc:db')(pg)
        await pg.getByRole('button', { name: 'Entfernen …' }).click()
        await pg.locator('.confirm-dialog .choice').waitFor()
        await pg.waitForTimeout(250)
      },
    },
  ]
  // Ergebnisbilder: nur die Hauptzustände
  return prefix ? shots.filter((s) => /live$|dienst-dialog|dienst-diff|wird-erstellt|entfernen|adminer/.test(s.name)) : shots
}

const shots: Shot[] = [
  { group: 'shell', name: 'shell-profilmenue', path: '/projekte', full: false, prepare: async (pg) => { await pg.locator('.profile-trigger').click(); await pg.waitForTimeout(250) } },
  // Windows 95 als Desktop (nur mit --themes win95 sinnvoll): Fenster-Knöpfe, Taskleiste, Startmenü, Beenden
  {
    group: 'win95', name: 'win95-minimiert', path: `/projekte/${P}`, full: false,
    prepare: async (pg) => {
      await pg.locator('section[aria-labelledby="ov-deploys"] .w95-cap-min').click()
      await pg.locator('section[aria-labelledby="ov-facts"] .w95-cap-min').click()
      await pg.waitForTimeout(150)
    },
  },
  {
    group: 'win95', name: 'win95-maximiert', path: `/projekte/${P}`, full: false,
    prepare: async (pg) => { await pg.locator('section[aria-labelledby="ov-deploys"] .w95-cap-max').click(); await pg.waitForTimeout(150) },
  },
  {
    group: 'win95', name: 'win95-hauptfenster-maximiert', path: `/projekte/${P}`, full: false,
    prepare: async (pg) => { await pg.locator('.shell > .main > .w95-caption .w95-cap-max').click(); await pg.waitForTimeout(150) },
  },
  {
    // Taskleisten-Knopf «Airlock»: ganze App minimiert, Taskleiste bleibt (sie liegt ausserhalb des Hauptfensters)
    group: 'win95', name: 'win95-app-minimiert', path: '/projekte', full: false,
    prepare: async (pg) => { await pg.locator('.w95-taskbar .w95-task').first().click(); await pg.waitForTimeout(150) },
  },
  {
    // Hin und zurück: zweiter Klick holt die App wieder (Bild = normale Projekte-Seite)
    group: 'win95', name: 'win95-app-zurueck', path: '/projekte', full: false,
    prepare: async (pg) => {
      const btn = pg.locator('.w95-taskbar .w95-task').first()
      await btn.click()
      await pg.locator('.shell > .main').waitFor({ state: 'hidden' })
      await btn.click()
      await pg.locator('.shell > .main').waitFor({ state: 'visible' })
    },
  },
  {
    // Desktop-Symbole: eine Karte geschlossen → Papierkorb voll, per Klick ausgewählt
    group: 'win95', name: 'win95-papierkorb', path: `/projekte/${P}`, full: false,
    prepare: async (pg) => {
      await pg.locator('section[aria-labelledby="ov-deploys"] .w95-cap-close').click()
      await pg.locator('.w95-icon').filter({ hasText: 'Papierkorb' }).click()
      await pg.waitForTimeout(150)
    },
  },
  {
    group: 'win95', name: 'win95-startmenue', path: '/projekte', full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Start', exact: true }).click(); await pg.waitForTimeout(250) },
  },
  {
    group: 'win95', name: 'win95-beenden', path: '/projekte', full: false,
    prepare: async (pg) => { await pg.locator('.shell > .main > .w95-caption .w95-cap-close').click(); await pg.waitForTimeout(250) },
  },
  {
    // Easter Egg: Konami-Code getippt → Meldung «Windows 95 freigeschaltet», vierte Option im Profilmenü
    group: 'win95', name: 'win95-freigeschaltet', path: '/projekte', full: false, me: { unlocks: [] },
    prepare: async (pg) => {
      // Tasten als keydown-Ereignisse: derselbe Lauscher, aber ohne das (sanfte, ungleich weite)
      // Scrollen der echten Pfeiltasten – sonst verrutscht das Bild von Lauf zu Lauf
      await pg.evaluate(() => {
        for (const key of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']) {
          window.dispatchEvent(new KeyboardEvent('keydown', { key }))
        }
      })
      await pg.getByText('Windows 95 freigeschaltet').waitFor()
      // Die Pfeiltasten scrollen die Seite unterschiedlich weit (je nach Zeitpunkt): fest nach oben
      // Die Pfeiltasten lösen weiches Scrollen aus, das nach scrollTo noch weiterlaufen kann:
      // warten, bis die Position zweimal hintereinander gleich ist, dann ohne Animation nach oben
      await pg.waitForFunction(() => new Promise<boolean>((r) => { const y = window.scrollY; setTimeout(() => r(window.scrollY === y), 150) }))
      await pg.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
      await pg.waitForFunction(() => window.scrollY === 0)
      await pg.locator('.profile-trigger').click()
      await pg.waitForTimeout(250)
    },
  },
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
  // Antwort 8: Port, Healthcheck-Pfad und RAM ändert man unter Einstellungen › Container; die Box zeigt den Knopf
  { group: 'fehler', name: 'fehler-port', path: '/projekte/p-fehler-port', full: false, el: '.failure' },
  { group: 'fehler', name: 'fehler-speicher', path: '/projekte/p-fehler-oom', full: false, el: '.failure' },
  {
    // «Grenze erhöhen» springt zum Abschnitt Container: RAM fokussiert, mit Vorschlag und Verbrauch
    // Kantenglättung der klebenden Sprungnavigation schwankt (wie projekt-einstellungen), sichtbar gleich
    group: 'fehler', name: 'fehler-grenze-vorschlag', path: '/projekte/p-fehler-oom', full: false, maxDiff: 600,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Grenze erhöhen' }).click()
      await pg.locator('#ct-memoryLimitMb:focus').waitFor()
      await pg.waitForTimeout(300)
    },
  },
  // Reiter «Aufbau»: Compose mit Datenbank und Volumes (Internet aus: Umriss «Veröffentlichen →»), Einzelcontainer
  // öffentlich mit Access, statische Seite öffentlich pausiert, gestoppter Container (nicht öffentlich),
  // gewählter Host, unter 1100 px (Seitenkarte unten) und unter 700 px (Liste statt Fläche)
  { group: 'aufbau', name: 'aufbau', path: `/projekte/${P}?tab=aufbau` },
  { group: 'aufbau', name: 'aufbau-einzelcontainer', path: `/projekte/${L}?tab=aufbau` },
  { group: 'aufbau', name: 'aufbau-statisch', path: `/projekte/${Z}?tab=aufbau` },
  { group: 'aufbau', name: 'aufbau-nicht-oeffentlich', path: '/projekte/p-notizen?tab=aufbau' },
  {
    group: 'aufbau', name: 'aufbau-host', path: `/projekte/${P}?tab=aufbau`, full: false,
    prepare: async (pg) => { await pg.locator('.topo-node[data-node="host:fotoalbum.int.example.ch"]').click(); await pg.waitForTimeout(200) },
  },
  {
    group: 'aufbau', name: 'aufbau-schmal', path: `/projekte/${P}?tab=aufbau`,
    prepare: async (pg) => { await pg.setViewportSize({ width: 1000, height: 900 }); await pg.waitForTimeout(300) },
  },
  {
    group: 'aufbau', name: 'aufbau-sehr-schmal', path: `/projekte/${P}?tab=aufbau`,
    prepare: async (pg) => { await pg.setViewportSize({ width: 680, height: 900 }); await pg.waitForTimeout(300) },
  },
  // Grosser Bildschirm: Projektseite bis 1440 px breit, Kopfzeile bündig mit
  {
    group: 'aufbau', name: 'aufbau-breit', path: `/projekte/${P}?tab=aufbau`, full: false,
    prepare: async (pg) => { await pg.setViewportSize({ width: 1920, height: 1080 }); await pg.waitForTimeout(300) },
  },
  // «Vergrössern»: Aufbau im Dialog über fast das ganze Fenster
  {
    group: 'aufbau', name: 'aufbau-vergroessert', path: `/projekte/${P}?tab=aufbau`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Vergrössern' }).click()
      await pg.locator('.dialog-full .topo-node').first().waitFor()
      await pg.waitForTimeout(300)
    },
  },
  // Ergebnisbilder neben der Vorlage (docs/design-cal/aufbau/umgesetzt-*.png): erster Bildschirm wie die Vorlage
  { group: 'aufbau-umgesetzt', name: 'umgesetzt', path: `/projekte/${P}?tab=aufbau`, full: false },
  // Etappe 4: Live-Verkehr (fester Zustand: reduced-motion → nur Zähler «12/min» und Summe in der Legende),
  // auch im vergrösserten Dialog; «+ Dienst» (Vorlage, Diff mit Variablen), neuer Dienst gestrichelt
  // «wird erstellt», Pull Request offen, gescheitert, ohne GitHub-App gesperrt, Adminer mit interner Adresse,
  // Entfernen mit Eintippen des Namens (Volume standardmässig behalten)
  ...aufbau2Shots('aufbau-2'),
  ...aufbau2Shots('aufbau-2-umgesetzt', 'umgesetzt-'),
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
  // Reiter Security neu: Header & CSP, Prüfungen (über die Chip «Image» angesprungen), Verlauf,
  // Befund mit Vorschlag von Claude, Schublade unter 1100 px
  { group: 'security', name: 'security-header-csp', path: `/projekte/${S}?tab=security&ansicht=header` },
  {
    group: 'security', name: 'security-pruefungen', path: `/projekte/${S}?tab=security`,
    prepare: async (pg) => {
      await pg.locator('.sec-chip', { hasText: 'Image' }).click()
      await pg.waitForTimeout(400)
      await pg.evaluate(() => window.scrollTo(0, 0))
      await pg.waitForTimeout(150)
    },
  },
  { group: 'security', name: 'security-verlauf', path: `/projekte/${S}?tab=security&ansicht=verlauf` },
  {
    group: 'security', name: 'security-befund-vorschlag', path: `/projekte/${S}?tab=security`,
    prepare: async (pg) => {
      await pg.locator('.sec-row', { hasText: 'Container läuft als root' }).click()
      await pg.waitForTimeout(250)
    },
  },
  {
    group: 'security', name: 'security-schublade', path: `/projekte/${S}?tab=security`, full: false,
    prepare: async (pg) => {
      await pg.setViewportSize({ width: 1000, height: 900 })
      await pg.waitForTimeout(300)
      await pg.locator('.sec-row', { hasText: 'Session-Cookie' }).click()
      await pg.waitForTimeout(450)
    },
  },
  // CSP-Fix: «Würde blockieren» und gesperrtes Scharfschalten; Zustand nach automatischem Zurücksetzen
  {
    group: 'csp', name: 'security-csp-gesperrt', path: `/projekte/${S}?tab=security&ansicht=header`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Regel ansehen' }).click()
      await pg.locator('#header-caddy-csp').evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await pg.evaluate(() => window.scrollBy(0, -24))
      await pg.waitForTimeout(150)
    },
  },
  {
    group: 'csp', name: 'security-csp-zurueckgesetzt', path: `/projekte/${S}?tab=security&ansicht=header`, full: false, cspReverted: true,
    prepare: async (pg) => {
      await pg.locator('#header-caddy-csp').evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await pg.evaluate(() => window.scrollBy(0, -24))
      await pg.waitForTimeout(150)
    },
  },
  // Antwort 7: CSP-Qualität (ZAP 10055) bleibt ZAP-Befund, mit «Zum CSP-Ablauf»
  {
    group: 'csp', name: 'security-csp-qualitaet', path: `/projekte/${S}?tab=security`, full: false, cspQuality: true,
    prepare: async (pg) => {
      await pg.locator('.sec-row', { hasText: 'CSP: Failure to Define Directive' }).click()
      await pg.locator('.sec-list').evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await pg.evaluate(() => window.scrollBy(0, -24))
      await pg.waitForTimeout(150)
    },
  },
  // M8: Header über Caddy – Rückfrage vor HSTS
  {
    group: 'fix', name: 'security-hsts-rueckfrage', path: `/projekte/${S}?tab=security&ansicht=header`, full: false,
    prepare: async (pg) => {
      const b = pg.getByRole('button', { name: 'Strict-Transport-Security setzen', exact: true })
      await b.scrollIntoViewIfNeeded()
      await b.click()
      await pg.waitForTimeout(250)
    },
  },
  // M8, Etappe 2: Mit Claude lösen – Auftrag am Befund und Image-Hinweis
  {
    group: 'fix', name: 'security-mit-claude-loesen', path: `/projekte/${S}?tab=security`, full: false,
    prepare: async (pg) => {
      await pg.locator('.sec-row', { hasText: 'Container läuft als root' }).click()
      await pg.locator('.sec-detail').getByRole('button', { name: 'Mit Claude lösen' }).click()
      await pg.waitForTimeout(300)
      await pg.locator('.sec-detail').evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await pg.evaluate(() => window.scrollBy(0, -24))
      await pg.waitForTimeout(150)
    },
  },
  {
    group: 'fix', name: 'security-image-hinweis', path: `/projekte/${S}?tab=security`, full: false,
    prepare: async (pg) => {
      await pg.locator('.sec-detail').getByRole('button', { name: 'Mit Claude lösen' }).click()
      await pg.waitForTimeout(300)
      await pg.locator('.sec-detail').evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await pg.evaluate(() => window.scrollBy(0, -24))
      await pg.waitForTimeout(150)
    },
  },
  {
    group: 'fix', name: 'security-vorschlag-claude', path: `/projekte/${S}?tab=security`, full: false,
    prepare: async (pg) => {
      await pg.locator('.sec-row', { hasText: 'Container läuft als root' }).click()
      await pg.locator('.fix-box').scrollIntoViewIfNeeded()
      await pg.waitForTimeout(150)
    },
  },
  // Kantenglättung der klebenden Sprungnavigation schwankt (wie veroeffentlichung-*), sichtbar gleich
  { group: 'projekte', name: 'projekt-einstellungen', path: `/projekte/${P}?tab=einstellungen`, maxDiff: 600 },
  {
    // Antwort 8: Abschnitt Container (nur bei Projekten mit Container) mit Verbrauch neben den Grenzen
    group: 'projekte', name: 'einstellungen-container', path: `/projekte/${P}?tab=einstellungen`, full: false, maxDiff: 600,
    prepare: async (pg) => {
      await pg.locator('#set-container').evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await pg.waitForTimeout(300)
    },
  },
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
  // Etappe 7: Spass-Paket
  ...spassShots('spass'),
  // UI-Qualität 8: Glocke, Sitzung abgelaufen, Rückfrage beim Verlassen, neues Token
  {
    group: 'sitzung', name: 'glocke', path: '/projekte', full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: /^Ereignisse/ }).click(); await pg.waitForTimeout(250) },
  },
  {
    group: 'sitzung', name: 'sitzung-abgelaufen', path: '/projekte', full: false,
    prepare: async (pg) => {
      await pg.route('**/api/v1/**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":{"code":"unauthorized","message":"Nicht angemeldet"}}' }))
      await pg.getByRole('link', { name: /^Audit-Log/ }).first().click()
      await pg.getByRole('dialog', { name: 'Sitzung abgelaufen' }).waitFor()
      await pg.waitForTimeout(250)
    },
  },
  {
    // Speichern scheitert an der abgelaufenen Sitzung: der Dialog nennt, was nicht ausgeführt wurde
    group: 'sitzung', name: 'sitzung-abgelaufen-aktion', path: `/projekte/${P}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.locator('#set-umgebung').getByRole('button', { name: 'Umgebungsvariable hinzufügen' }).click()
      const row = pg.locator('#set-umgebung .env-row').last().locator('input')
      await row.nth(0).fill('API_KEY')
      await row.nth(1).fill('geheim')
      await pg.route('**/api/v1/**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":{"code":"unauthorized","message":"Nicht angemeldet"}}' }))
      await pg.getByRole('button', { name: 'Umgebungsvariablen speichern' }).click()
      await pg.getByRole('dialog', { name: 'Sitzung abgelaufen' }).getByText('Umgebungsvariablen nicht gespeichert', { exact: false }).waitFor()
      await pg.waitForTimeout(250)
    },
  },
  {
    // Antwort 16: nach der Anmeldung «Erneut ausführen» für die gescheiterte Aktion (nichts automatisch)
    group: 'sitzung', name: 'sitzung-erneut-ausfuehren', path: `/projekte/${P}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.locator('#set-umgebung').getByRole('button', { name: 'Umgebungsvariable hinzufügen' }).click()
      const row = pg.locator('#set-umgebung .env-row').last().locator('input')
      await row.nth(0).fill('API_KEY')
      await row.nth(1).fill('geheim')
      const unauthorized = (r: import('@playwright/test').Route) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":{"code":"unauthorized","message":"Nicht angemeldet"}}' })
      await pg.route('**/api/v1/**', unauthorized)
      await pg.getByRole('button', { name: 'Umgebungsvariablen speichern' }).click()
      const dialog = pg.getByRole('dialog', { name: 'Sitzung abgelaufen' })
      await dialog.getByText('Umgebungsvariablen nicht gespeichert', { exact: false }).waitFor()
      await pg.unroute('**/api/v1/**', unauthorized)
      await dialog.getByLabel('Passwort').fill('test-passwort')
      await dialog.getByRole('button', { name: 'Anmelden' }).click()
      await pg.locator('[data-sonner-toast]').filter({ hasText: 'Erneut ausführen' }).first().waitFor()
      await pg.waitForTimeout(500)
    },
  },
  {
    group: 'sitzung', name: 'verlassen-rueckfrage', path: `/projekte/${P}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.locator('#set-umgebung').getByRole('button', { name: 'Umgebungsvariable hinzufügen' }).click()
      await pg.locator('#set-umgebung .env-row').last().locator('input').first().fill('API_KEY')
      await pg.getByRole('link', { name: /^Audit-Log/ }).first().click()
      await pg.getByRole('dialog', { name: 'Änderungen verwerfen?' }).waitFor()
      await pg.waitForTimeout(250)
    },
  },
  {
    // Antwort 12: auch der Zurück-Knopf des Browsers fragt (Daten-Router, useBlocker). Über einen Link
    // der Oberfläche zur Projektseite, damit es ein «Zurück» innerhalb der Oberfläche gibt.
    // Kantenglättung der klebenden Sprungnavigation schwankt (wie projekt-einstellungen), sichtbar gleich
    group: 'sitzung', name: 'verlassen-zurueck', path: '/domains', full: false, maxDiff: 600,
    prepare: async (pg) => {
      await pg.locator('td.cell-main').getByRole('link', { name: 'Haushaltsbuch' }).click()
      await pg.locator('#set-umgebung').getByRole('button', { name: 'Variable hinzufügen' }).click()
      await pg.locator('#set-umgebung .env-row').last().locator('input').first().fill('API_KEY')
      await pg.goBack()
      await pg.getByRole('dialog', { name: 'Änderungen verwerfen?' }).waitFor()
      // Der Browser stellt beim (angehaltenen) Zurück die Scrollposition wieder her – je nach Zeitpunkt
      // um ein Pixel anders. Für ein stabiles Bild oben ausrichten.
      await pg.waitForTimeout(250)
      await pg.evaluate(() => window.scrollTo(0, 0))
      await pg.waitForTimeout(100)
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
  {
    // Antwort 14: Befehl für Claude Code mit --scope user, Token verdeckt eingelesen (bash gewählt)
    group: 'sitzung', name: 'tokens-neu-claude-code', path: '/tokens', full: false,
    prepare: async (pg) => {
      await pg.getByLabel('Name des Tokens').fill('Claude Code Mac')
      await pg.getByRole('button', { name: 'Token anlegen' }).click()
      await pg.getByRole('button', { name: 'bash', exact: true }).click()
      await pg.locator('.token-shell').scrollIntoViewIfNeeded()
      await pg.waitForTimeout(200)
    },
  },
  { group: 'security', name: 'security-global', path: '/security' },
  // UI-Qualität 6: alte Adressen leiten weiter – /extern auf den Reiter unter Security, /domains in System
  // Native Auswahlliste: Breite schwankt je nach Zeitpunkt des Schrift-Ladens um 4 px (Knöpfe rücken mit)
  { group: 'security', name: 'externe-ziele', path: '/extern', maxDiff: 2000 },
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
  // Meilenstein Backup, Etappe 3: eingerichtet, noch nicht eingerichtet, über 48 h ohne Erfolg
  { group: 'backup', name: 'system-backup', path: '/server/backup' },
  { group: 'backup', name: 'system-backup-leer', path: '/server/backup', backup: 'leer' },
  { group: 'backup', name: 'system-backup-veraltet', path: '/server/backup', backup: 'veraltet', full: false },
  // Etappe 4: secrets.key getrennt sichern – Datei mit Passphrase, Papier mit QR
  {
    group: 'backup', name: 'backup-schluessel-datei', path: '/server/backup', full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Als Datei exportieren' }).click()
      await pg.getByRole('dialog', { name: 'Schlüssel als Datei exportieren' }).waitFor()
      await pg.waitForTimeout(250)
    },
  },
  {
    group: 'backup', name: 'backup-schluessel-papier', path: '/server/backup', full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Papier-Anleitung' }).click()
      await pg.getByLabel('Anmelde-Passwort').fill('beispiel')
      await pg.getByRole('button', { name: 'Anzeigen' }).click()
      await pg.getByRole('heading', { name: /^Schlüssel der Secrets · / }).waitFor()
      await pg.waitForTimeout(250)
    },
  },
  // Etappe 5: Projekt aus einem Stand zurückholen – Vorschau und Bestätigung (Slug eintippen)
  {
    group: 'backup', name: 'backup-wiederherstellen', path: '/server/backup', full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Projekt aus Stand 3f9c2a7b wiederherstellen' }).click()
      await pg.getByRole('dialog').getByLabel('Projekt', { exact: true }).selectOption('fotoalbum')
      await pg.getByRole('dialog').getByRole('table').waitFor()
      await pg.getByRole('dialog').getByLabel(/Zur Bestätigung/).fill('fotoalbum')
      await pg.waitForTimeout(250)
    },
  },
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
      await pg.locator('.pause-dialog').getByRole('button', { name: 'Einfach', exact: true }).click()
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
      await pg.locator('.pause-dialog').getByRole('button', { name: 'Einfach', exact: true }).click()
      await pg.waitForTimeout(300)
    },
  },
  {
    // Vorlage: von Einfach zu HTML wechseln – der Editor beginnt mit dem HTML der Felder
    group: 'pauseseite', name: 'pauseseite-vorlage-code', path: '/system/veroeffentlichung', full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: 'HTML', exact: true }).click(); await pg.waitForTimeout(250) },
  },
  // Projektseite 7: Pause-Seiten-Editor (hallo-welt, live: Seite für das nächste Pausieren)
  {
    group: 'p7', name: '7-pause-einfach', path: `/projekte/${H}?tab=einstellungen`, full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Anpassen', exact: true }).first().click(); await pg.waitForTimeout(350) },
  },
  {
    group: 'p7', name: '7-pause-html', path: `/projekte/${H}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Anpassen', exact: true }).first().click()
      await pg.locator('.pause-dialog').getByRole('button', { name: 'HTML', exact: true }).click()
      await pg.locator('.pause-dialog').getByRole('button', { name: 'Formatieren' }).click()
      await pg.waitForTimeout(350)
    },
  },
  {
    group: 'p7', name: '7-pause-html-verstoss', path: `/projekte/${H}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Anpassen', exact: true }).first().click()
      await pg.locator('.pause-dialog').getByRole('button', { name: 'HTML', exact: true }).click()
      await pg.locator('.pause-dialog .cm-content').click()
      await pg.keyboard.press('ControlOrMeta+End')
      // Der Editor schliesst das Tag selbst
      await pg.keyboard.type('\n<script src="https://cdn.example/x.js">')
      await pg.waitForTimeout(350)
    },
  },
  {
    group: 'p7', name: '7-pause-html-vollbild', path: `/projekte/${H}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Anpassen', exact: true }).first().click()
      await pg.locator('.pause-dialog').getByRole('button', { name: 'HTML', exact: true }).click()
      await pg.getByRole('button', { name: 'Editor im Vollbild' }).click()
      await pg.waitForTimeout(350)
    },
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
  /*
   * Öffentliche Adressen: geteiltes Feld Name · Domain, Vorschau, Prüfung beim Tippen.
   * frei: eingefügter voller Name wird in Name und Domain zerlegt
   */
  {
    group: 'adresse', name: 'adresse-frei', path: `/projekte/${P}?tab=einstellungen`, full: false, el: '.publication', zones2: true, maxDiff: 600,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Veröffentlichen', exact: true }).click()
      await pg.getByLabel('Öffentliche Adresse').fill('https://Mein-Shop.example.org/start')
      await pg.locator('.pubname-status.pubname-ok').waitFor()
      await pg.locator('.publication').evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await pg.waitForTimeout(200)
    },
  },
  // Adresse ändern: fremder DNS-Eintrag (Typ → Ziel), Ersetzen nur nach Haken
  {
    group: 'adresse', name: 'adresse-dns-fremd', path: `/projekte/${L}?tab=einstellungen`, full: false, el: '.publication',
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Ändern', exact: true }).click()
      await pg.getByLabel('Neue öffentliche Adresse').fill('alt')
      await pg.getByRole('checkbox', { name: /Bestehenden Eintrag ersetzen/ }).check()
      await pg.locator('.publication').evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await pg.waitForTimeout(200)
    },
  },
  // «Direkt unter <zone>»: dieselbe Prüfung; Worker/Custom Domain lässt sich nicht ersetzen
  {
    group: 'adresse', name: 'adresse-apex', path: `/projekte/${P}?tab=einstellungen`, full: false, el: '.publication', zones2: true, maxDiff: 600,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Veröffentlichen', exact: true }).click()
      await pg.getByLabel('Domain', { exact: true }).selectOption('example.org')
      await pg.getByRole('switch', { name: /Direkt unter/ }).click()
      await pg.locator('.pubname-status.pubname-bad').waitFor()
      await pg.locator('.publication').evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await pg.waitForTimeout(200)
    },
  },
  // Neues Projekt: öffentlich nach dem ersten Scan; Name schon vergeben (Prüfung ohne Projekt, in der Umgebung)
  {
    group: 'adresse', name: 'adresse-neues-projekt', path: '/projekte/neu', full: false, el: '.field-group:has(.public-options)',
    prepare: async (pg) => {
      await pg.getByLabel('Name', { exact: true }).fill('Haushalt')
      await pg.getByRole('checkbox', { name: /Öffentlich über Cloudflare Tunnel/ }).check()
      await pg.locator('.pubname-status.pubname-bad').waitFor()
      await pg.locator('.public-options').evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await pg.waitForTimeout(200)
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
  // Besucher zusammen: Einzelaufrufe (früher Reiter «Zugriffe», Vorlage docs/design-cal/besucher-zusammen/) –
  // heute mit Docker-Netz abgewiesen gewählt (Hinweis ts-docker-nosnat), Scanner aus einem Rechenzentrum
  // (7 Tage: Hinweis «nur die letzten 2 Tage»), nur Abgewiesene, einzeln mit Prüfungen und Bots (Zahl am Knopf
  // «Anzeige»), Suche, Schublade unter 1100 px, Zustände des Logs (leer, wartet auf die Datei, nicht
  // eingerichtet); neu: Filter-Chips aus der Auswertung, Menü «Anzeige» offen, 30 Tage
  { group: 'einzelaufrufe', name: 'einzelaufrufe', path: `${EINZELN}&zeitraum=heute&zeile=z-gw` },
  { group: 'einzelaufrufe', name: 'einzelaufrufe-scanner', path: `${EINZELN}&suche=digitalocean&zeile=z-wp`, full: false },
  { group: 'einzelaufrufe', name: 'einzelaufrufe-abgewiesen', path: `${EINZELN}&zeitraum=heute&status=abgewiesen&zeile=z-gw`, full: false },
  { group: 'einzelaufrufe', name: 'einzelaufrufe-einzeln', path: `${EINZELN}&einzeln=1&pruefungen=1&bots=1&zeile=z-typo-0` },
  { group: 'einzelaufrufe', name: 'einzelaufrufe-suche', path: `${EINZELN}&suche=niederlande`, full: false },
  {
    group: 'einzelaufrufe', name: 'einzelaufrufe-schublade', path: `${EINZELN}&zeitraum=heute`, full: false,
    prepare: async (pg) => {
      await pg.setViewportSize({ width: 1000, height: 900 })
      await pg.locator('.acc-row').nth(1).click()
      await pg.waitForTimeout(350)
    },
  },
  { group: 'einzelaufrufe', name: 'einzelaufrufe-leer', path: `${EINZELN}&zeitraum=heute`, access: 'leer', full: false },
  { group: 'einzelaufrufe', name: 'einzelaufrufe-wartet', path: EINZELN, access: 'wartet', full: false },
  { group: 'einzelaufrufe', name: 'einzelaufrufe-aus', path: EINZELN, access: 'aus', full: false },
  { group: 'einzelaufrufe', name: 'einzelaufrufe-filter', path: `${EINZELN}&zeitraum=heute&land=CH&browser=Chrome&zeile=z-neu`, full: false },
  {
    group: 'einzelaufrufe', name: 'einzelaufrufe-anzeige', path: `${EINZELN}&zeitraum=heute&bots=1`, full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: /^Anzeige/ }).click(); await pg.waitForTimeout(300) },
  },
  { group: 'einzelaufrufe', name: 'einzelaufrufe-30-tage', path: `${EINZELN}&zeitraum=30-tage&status=nicht-gefunden`, full: false },
  // Etappe 3: Besucher – Reiter (öffentliche Seite mit Karte), mit Städten (DB-IP), nach Zugang getrennt,
  // internes Projekt (ohne Länder), leer, wartet auf das Log, nicht eingerichtet; Wert per Tastatur;
  // Karte in der Übersicht und «Aufrufe heute» in der Projektliste
  { group: 'besucher', name: 'besucher', path: `/projekte/${H}?tab=besucher`, traffic: 'ok' },
  { group: 'besucher', name: 'besucher-staedte', path: `/projekte/${H}?tab=besucher`, traffic: 'staedte' },
  {
    group: 'besucher', name: 'besucher-tailnet', path: `/projekte/${H}?tab=besucher`, traffic: 'ok', full: false,
    prepare: async (pg) => { await pg.getByRole('group', { name: 'Nach Zugang trennen' }).getByRole('button', { name: /^Tailnet/ }).click(); await pg.waitForTimeout(250) },
  },
  { group: 'besucher', name: 'besucher-intern', path: `/projekte/${P}?tab=besucher`, traffic: 'ok' },
  { group: 'besucher', name: 'besucher-leer', path: `/projekte/${H}?tab=besucher`, traffic: 'leer', full: false },
  { group: 'besucher', name: 'besucher-wartet', path: `/projekte/${H}?tab=besucher`, traffic: 'wartet', full: false },
  { group: 'besucher', name: 'besucher-aus', path: `/projekte/${H}?tab=besucher`, traffic: 'aus', full: false },
  {
    group: 'besucher', name: 'besucher-wert', path: `/projekte/${H}?tab=besucher`, traffic: 'ok', full: false, el: '.vs-main',
    prepare: async (pg) => { await pg.locator('.vs-plot svg').first().focus(); await pg.keyboard.press('End'); await pg.keyboard.press('ArrowLeft'); await pg.waitForTimeout(150) },
  },
  // Besucher neu: Messbeginn im Zeitraum (Achse ab Messbeginn, Stunden), Säulen nach Zugang (Präferenz),
  // Heute, 12 Monate, Kennzahl «Nicht gefunden» als Kurve, Europa-Ausschnitt mit Tooltip, Einstiegsseiten,
  // Server › Besucher (Quellen)
  { group: 'besucher', name: 'besucher-messbeginn', path: `/projekte/${H}?tab=besucher`, traffic: 'jung' },
  {
    group: 'besucher', name: 'besucher-saeulen', path: `/projekte/${H}?tab=besucher`, traffic: 'jung', full: false, el: '.vs-main', me: { trafficChart: 'bars' },
    prepare: async (pg) => { await pg.locator('.vs-plot svg').first().focus(); await pg.keyboard.press('End'); await pg.keyboard.press('ArrowLeft'); await pg.keyboard.press('ArrowLeft'); await pg.waitForTimeout(150) },
  },
  { group: 'besucher', name: 'besucher-heute', path: `/projekte/${H}?tab=besucher&zeitraum=heute`, traffic: 'ok', full: false, el: '.vs-main' },
  { group: 'besucher', name: 'besucher-12-monate', path: `/projekte/${H}?tab=besucher&zeitraum=12-monate`, traffic: 'ok', full: false, el: '.vs-main' },
  {
    group: 'besucher', name: 'besucher-kennzahl', path: `/projekte/${H}?tab=besucher&zeitraum=30-tage`, traffic: 'ok', full: false, el: '.vs-main',
    prepare: async (pg) => { await pg.getByRole('button', { name: /^Nicht gefunden/ }).click(); await pg.waitForTimeout(250) },
  },
  {
    // Seiten pro Besuch in Stunden (Messbeginn im Zeitraum): laufender Schnitt seit Mitternacht, nie eine leere Kurve
    group: 'besucher', name: 'besucher-seiten-pro-besuch', path: `/projekte/${H}?tab=besucher`, traffic: 'jung', full: false, el: '.vs-main',
    prepare: async (pg) => { await pg.getByRole('button', { name: /^Seiten pro Besuch/ }).click(); await pg.waitForTimeout(250) },
  },
  {
    group: 'besucher', name: 'besucher-europa', path: `/projekte/${H}?tab=besucher`, traffic: 'staedte', full: false, el: '.vs-geo',
    prepare: async (pg) => {
      await pg.getByRole('group', { name: 'Kartenausschnitt' }).getByRole('button', { name: 'Europa' }).click()
      await pg.getByRole('link', { name: /^Schweiz:/ }).focus()
      // Fokus scrollt; der Ausschnitt (el) rechnet ab dem Seitenanfang
      await pg.evaluate(() => window.scrollTo(0, 0))
      await pg.waitForTimeout(250)
    },
  },
  {
    group: 'besucher', name: 'besucher-einstieg', path: `/projekte/${H}?tab=besucher`, traffic: 'staedte', full: false, el: '.vs-grid-3',
    prepare: async (pg) => {
      await pg.getByRole('group', { name: 'Alle Seiten, Einstieg, Ausstieg oder nicht gefunden' }).getByRole('button', { name: 'Einstieg' }).click()
      await pg.evaluate(() => window.scrollTo(0, 0))
      await pg.waitForTimeout(250)
    },
  },
  // Besucher zusammen: Seiten › 404 (ersetzt die Karte «Nicht gefunden»), Woher › Kampagnen, Geräte › Browser,
  // Liste «Netz» mit Rechenzentren, «Wie gezählt wird» offen
  ...([
    ['besucher-404', 'Alle Seiten, Einstieg, Ausstieg oder nicht gefunden', '404', '.vs-grid-3'],
    ['besucher-kampagnen', 'Links oder Kampagnen', 'Kampagnen', '.vs-grid-3'],
    ['besucher-browser', 'Gerätetyp, Browser oder System', 'Browser', '.vs-grid-3'],
    ['besucher-netz', 'Länder, Städte, Netz oder Sprachen', 'Netz', '.vs-geo'],
  ] as const).map(([name, group, button, el]): Shot => ({
    group: 'besucher', name, path: `/projekte/${H}?tab=besucher`, traffic: 'staedte', full: false, el,
    prepare: async (pg) => {
      await pg.getByRole('group', { name: group }).getByRole('button', { name: button, exact: true }).click()
      await pg.evaluate(() => window.scrollTo(0, 0))
      await pg.waitForTimeout(250)
    },
  })),
  {
    group: 'besucher', name: 'besucher-info', path: `/projekte/${H}?tab=besucher`, traffic: 'staedte', full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: /^Wie gezählt wird/ }).click()
      await pg.locator('.vs-info').scrollIntoViewIfNeeded()
      await pg.waitForTimeout(300)
    },
  },
  { group: 'besucher', name: 'server-besucher', path: '/server/besucher', traffic: 'ok' },
  { group: 'besucher', name: 'server-besucher-geladen', path: '/server/besucher', traffic: 'staedte', full: false },
  { group: 'besucher', name: 'projekt-uebersicht-besucher', path: `/projekte/${H}`, traffic: 'ok' },
  { group: 'besucher', name: 'projekte-besucher', path: '/projekte', traffic: 'ok' },
  // Ergebnisbilder der Etappe (docs/design-cal/analytics/umgesetzt-*.png)
  { group: 'analytics-umgesetzt', name: 'umgesetzt-besucher', path: `/projekte/${H}?tab=besucher`, traffic: 'ok' },
  { group: 'analytics-umgesetzt', name: 'umgesetzt-besucher-staedte', path: `/projekte/${H}?tab=besucher`, traffic: 'staedte' },
  { group: 'analytics-umgesetzt', name: 'umgesetzt-besucher-intern', path: `/projekte/${P}?tab=besucher`, traffic: 'ok' },
  { group: 'analytics-umgesetzt', name: 'umgesetzt-uebersicht', path: `/projekte/${H}`, traffic: 'ok', full: false },
  { group: 'analytics-umgesetzt', name: 'umgesetzt-projekte', path: '/projekte', traffic: 'ok', full: false },
  // Besucher neu: Ergebnisbilder neben der Vorlage (docs/design-cal/besucher-neu/umgesetzt-*.png)
  { group: 'besucher-neu', name: 'umgesetzt-besucher', path: `/projekte/${H}?tab=besucher`, traffic: 'staedte' },
  { group: 'besucher-neu', name: 'umgesetzt-messbeginn', path: `/projekte/${H}?tab=besucher`, traffic: 'jung' },
  {
    group: 'besucher-neu', name: 'umgesetzt-saeulen', path: `/projekte/${H}?tab=besucher`, traffic: 'jung', full: false, el: '.vs-main', me: { trafficChart: 'bars' },
    prepare: async (pg) => { await pg.locator('.vs-plot svg').first().focus(); await pg.keyboard.press('End'); await pg.keyboard.press('ArrowLeft'); await pg.keyboard.press('ArrowLeft'); await pg.waitForTimeout(150) },
  },
  {
    group: 'besucher-neu', name: 'umgesetzt-flaeche', path: `/projekte/${H}?tab=besucher`, traffic: 'jung', full: false, el: '.vs-main',
    prepare: async (pg) => { await pg.locator('.vs-plot svg').first().focus(); await pg.keyboard.press('End'); await pg.keyboard.press('ArrowLeft'); await pg.keyboard.press('ArrowLeft'); await pg.waitForTimeout(150) },
  },
  { group: 'besucher-neu', name: 'umgesetzt-intern', path: `/projekte/${P}?tab=besucher`, traffic: 'ok' },
  { group: 'besucher-neu', name: 'umgesetzt-server', path: '/server/besucher', traffic: 'staedte', full: false },
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
      // Antwort 10: öffnet den modalen Dialog (Kurzname eintippen)
      await pg.getByRole('button', { name: 'Projekt löschen …' }).click()
      await pg.getByRole('dialog').waitFor()
      await pg.waitForTimeout(300)
    },
  },
  {
    // Projekt löschen im Dialog, Kurzname halb eingetippt (Bestätigen noch gesperrt); Container-Projekt mit Haken für Volumes
    group: 'p6', name: 'loeschen-dialog', path: `/projekte/${P}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Projekt löschen …' }).click()
      const dialog = pg.getByRole('dialog')
      await dialog.waitFor()
      const slug = (await dialog.locator('code').first().textContent()) ?? ''
      await dialog.getByRole('textbox', { name: 'Kurzname zur Bestätigung' }).fill(slug.slice(0, Math.ceil(slug.length / 2)))
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
  // Native Auswahllisten: Breite schwankt um wenige Pixel (Schrift-Laden)
  { group: 'design', name: 'design-bausteine', path: '/design', maxDiff: 600 },
  /* M9: Umgebungen (echte Seiten; der DOM-Prototyp unter docs/design-cal/umgebungen ist damit abgelöst) */
  { group: 'm9', name: 'm9-projekte', path: '/u/example/projekte', full: false },
  { group: 'm9', name: 'm9-umschalter', path: '/u/example/projekte', full: false, prepare: async (pg) => { await pg.locator('.env-trigger').click(); await pg.waitForTimeout(250) } },
  // Umschalter in der Kopfzeile: Domain hinter dem Namen (Verein), sehr langer Name endet mit «…»
  { group: 'm9', name: 'm9-umschalter-domain', path: '/u/verein/projekte', el: '.topbar' },
  {
    group: 'm9', name: 'm9-umschalter-lang', path: `/u/example/projekte/${P}`, el: '.topbar',
    envPatch: { name: 'Gemeinnütziger Verein Beispielhausen', short: 'GV', zone: 'verein-beispielhausen.ch' },
  },
  // Unter 860 px: nur Kürzel und Pfeil
  {
    group: 'm9', name: 'm9-umschalter-schmal', path: `/u/example/projekte/${P}`, full: false,
    prepare: async (pg) => { await pg.setViewportSize({ width: 800, height: 900 }); await pg.waitForTimeout(250) },
  },
  { group: 'm9', name: 'm9-einstellungen', path: '/u/example/einstellungen' },
  {
    group: 'm9', name: 'm9-einstellungen-cloudflare', path: '/u/example/einstellungen/cloudflare',
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Prüfen', exact: true }).click(); await pg.waitForTimeout(300) },
  },
  { group: 'm9', name: 'm9-einstellungen-standards', path: '/u/example/einstellungen/standards' },
  { group: 'm9', name: 'm9-umgebungen', path: '/umgebungen' },
  {
    group: 'm9', name: 'm9-umgebung-anlegen', path: '/umgebungen/neu',
    prepare: async (pg) => { await pg.locator('#ne-name').fill('Verein Beispiel'); await pg.waitForTimeout(150) },
  },
  { group: 'm9', name: 'm9-einrichtung', path: '/u/labor/einrichtung', maxDiff: 600 },
  {
    group: 'm9', name: 'm9-verschieben', path: `/u/example/projekte/${Z}?tab=einstellungen`, full: false,
    prepare: async (pg) => {
      await pg.locator('.move-select').selectOption('verein')
      await pg.waitForTimeout(300)
      await pg.getByRole('button', { name: 'Verschieben …' }).click()
      await pg.waitForTimeout(200)
      await pg.locator('.move-card').evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await pg.evaluate(() => window.scrollBy(0, -24))
      await pg.waitForTimeout(150)
    },
  },
  { group: 'm9', name: 'm9-audit', path: '/u/example/audit', full: false },
  { group: 'm9', name: 'm9-server', path: '/server' },
  { group: 'm9', name: 'm9-tokens', path: '/u/example/tokens', full: false },
  /* Etappe 5: Statusseite – Einstellungen der Umgebung (an, offene und behobene Störung), Störung melden,
     aus (Umgebung ohne Hauptzone), Abschnitt in den Projekteinstellungen */
  { group: 'statusseite', name: 'statusseite-einstellungen', path: '/u/example/einstellungen/statusseite' },
  {
    group: 'statusseite', name: 'statusseite-melden', path: '/u/example/einstellungen/statusseite', full: false,
    prepare: async (pg) => {
      await pg.getByRole('button', { name: 'Störung melden' }).click()
      await pg.locator('#sp-new-title').fill('Mail-Versand verzögert')
      await pg.locator('#sp-new-body').fill('Nachrichten kommen mit bis zu 10 Minuten Verspätung an.')
      await pg.locator('.sp-form').evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await pg.waitForTimeout(250)
    },
  },
  {
    group: 'statusseite', name: 'statusseite-aus', path: '/u/labor/einstellungen/statusseite', full: false,
    // Unter Last war die Seite nach networkidle noch leer (axe: kein main, kein h1) – auf die Überschrift warten
    prepare: async (pg) => { await pg.locator('main h1').first().waitFor({ timeout: 8000 }) },
  },
  {
    group: 'statusseite', name: 'statusseite-projekt', path: `/u/example/projekte/${P}?tab=einstellungen`, full: false, patch: { showOnStatus: true },
    prepare: async (pg) => {
      await pg.locator('#set-statusseite').evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await pg.waitForTimeout(300)
    },
  },
  /* Etappe 5: die öffentliche Seite selbst (eigenes HTML/CSS/JS, hell/dunkel nach Gerät), Tooltip per Tastatur, ruhiger Zustand */
  { group: 'statusseite', name: 'statusseite-oeffentlich', path: '/__statusseite/', statusPage: 'stoerung' },
  {
    group: 'statusseite', name: 'statusseite-oeffentlich-tooltip', path: '/__statusseite/', statusPage: 'stoerung', full: false,
    prepare: async (pg) => {
      // Per Tastatur: ein Tag zurück und wieder auf heute (Wetterstation, kurze Störung)
      const days = pg.locator('.project', { hasText: 'Wetterstation' }).locator('.days')
      await days.locator('.day[tabindex="0"]').focus()
      await pg.keyboard.press('ArrowLeft')
      await pg.keyboard.press('ArrowRight')
      await days.evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await pg.waitForTimeout(250)
    },
  },
  { group: 'statusseite', name: 'statusseite-oeffentlich-ruhig', path: '/__statusseite/', statusPage: 'ruhig' },
  /* Etappe 6: Vorschau-Deploys – Reiter Deployments (drei Vorschauen: bereit mit PR und Scan, wird deployt,
     fehlgeschlagen), Löschen mit Bestätigung, an und leer, aus (Hinweis); Einstellungen mit Schalter und
     Variablen-Ebene «Vorschau», Variablen bearbeiten, ohne Git-Repo (Schalter deaktiviert mit Begründung) */
  ...previewShots('vorschauen'),
  { group: 'zustaende', name: 'leer-projekte', path: '/projekte', empty: true },
  { group: 'zustaende', name: 'laden-projekte', path: '/projekte', full: false, hang: ['/api/v1/projects'] },
  { group: 'zustaende', name: 'api-offline', path: '/projekte', full: false, offline: true },
  {
    group: 'zustaende', name: 'rueckmeldung-deploy', path: '/projekte', full: false,
    prepare: async (pg) => { await pg.getByRole('button', { name: 'Erneut deployen' }).first().click(); await pg.waitForTimeout(400); await pg.evaluate(() => window.scrollTo(0, 0)) },
  },
]

// Etappe 5: Ergebnisbilder (docs/design-cal/statusseite/umgesetzt-*.png) aus denselben Szenen
shots.push(...shots.filter((s) => s.group === 'statusseite').map((s) => ({ ...s, group: 'statusseite-ergebnis', name: s.name.replace(/^statusseite-/, 'umgesetzt-') })))
// Etappe 6: Ergebnisbilder (docs/design-cal/previews/umgesetzt-*.png)
shots.push(...shots.filter((s) => s.group === 'vorschauen').map((s) => ({ ...s, group: 'vorschauen-ergebnis', name: s.name === 'vorschauen' ? 'umgesetzt-liste' : s.name.replace(/^vorschauen-/, 'umgesetzt-') })))

// Zugriffe neu: Warnung in Server › Übersicht (docs/design-cal/zugriffe-neu/umgesetzt-server-netz-*.png)
shots.push({ group: 'zugriffe-ergebnis', name: 'umgesetzt-server-netz', path: '/server', el: '.gateway-warning' })
// Besucher zusammen: Ergebnisbilder neben der Vorlage (docs/design-cal/besucher-zusammen/umgesetzt-*.png)
shots.push(
  { group: 'besucher-zusammen', name: 'umgesetzt-auswertung', path: `/projekte/${H}?tab=besucher`, traffic: 'staedte' },
  { group: 'besucher-zusammen', name: 'umgesetzt-einzelaufrufe', path: `${EINZELN}&zeitraum=heute&zeile=z-gw` },
  ...shots.filter((s) => ['einzelaufrufe-filter', 'einzelaufrufe-anzeige', 'einzelaufrufe-scanner', 'besucher-404', 'besucher-netz', 'besucher-info', 'besucher-intern'].includes(s.name))
    .map((s) => ({ ...s, group: 'besucher-zusammen', name: s.name.replace(/^(einzelaufrufe|besucher)-/, 'umgesetzt-') })),
)

// Etappe 7: Ergebnisbilder (docs/design-cal/spass/umgesetzt-*.png): Spass-Szenen und Hauptseiten im Theme «Terminal»
shots.push(...shots.filter((s) => s.group === 'spass').map((s) => ({ ...s, group: 'spass-ergebnis', name: `umgesetzt-${s.name}` })))
shots.push(...['projekte', 'projekt-uebersicht', 'projekt-security', 'design-bausteine', 'shell-profilmenue', 'konto'].map((n) => {
  const s = shots.find((x) => x.name === n)!
  return { ...s, group: 'spass-ergebnis-terminal', name: `umgesetzt-${n}`, full: false }
}))

export { shots }
export type { Shot }

/** Optionen des Browser-Kontexts für eine Aufnahme (Desktop, 1440 px) */
export const contextOptions = (t: ShotTheme) => ({
  viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' as const, locale: 'de-CH', timezoneId: 'Europe/Zurich', colorScheme: t === 'dark' || t === 'terminal' ? 'dark' as const : 'light' as const,
})

/**
 * Theme setzen und die API aus den Fixtures beantworten (page.route auf dem
 * Kontext). Gemeinsam für shoot.ts und die visuellen Tests (visual/).
 */
export async function installRoutes(ctx: BrowserContext, s: Shot, t: ShotTheme, port = PORT): Promise<void> {
      await ctx.addInitScript({ content: `try { localStorage.setItem('airlock.theme', '${t}') } catch {}` })
      // Etappe 7: Matrix-Regen als festes Bild; Snake mit festem Zufall (Futter immer am selben Ort)
      if (s.matrix) await ctx.addInitScript({ content: 'window.__AIRLOCK_MATRIX_STILL__ = true' })
      if (s.snake) await ctx.addInitScript({ content: `(() => { let x = 42; Math.random = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296 } })()` })
      // Feste Adresse der Oberfläche (MCP-Adresse in Tokens, «Per Chat»): Bilder hängen nicht vom Port ab
      await ctx.addInitScript({ content: `window.__AIRLOCK_ORIGIN__ = 'https://airlock.int.example.ch'` })
      // UI-Qualität 4: Live-Ströme der Reiter «Logs» und «Zugriffe» stehen offen (ohne neue Zeilen) –
      // ohne Server würden sie sofort abbrechen und «Live-Verbindung unterbrochen» zeigen
      // Etappe 4: ebenso der Live-Verkehr des Aufbaus; mit s.live liefert er feste Anfragen, sobald Knoten da sind
      if (s.live) await ctx.addInitScript({ content: `window.__AIRLOCK_LIVE__ = ${JSON.stringify(fx.trafficLive())}` })
      await ctx.addInitScript({ content: `(() => {
        const Real = window.EventSource
        window.EventSource = function (url, init) {
          if (!/\\/(logs|access)\\/stream|\\/traffic\\/live/.test(String(url))) return new Real(url, init)
          const es = { url: String(url), readyState: 0, onopen: null, onmessage: null, onerror: null,
            addEventListener() {}, removeEventListener() {}, close() { es.readyState = 2 } }
          // Schon wieder geschlossen (StrictMode baut Effekte zweimal auf): wie ein echter Strom stumm bleiben
          setTimeout(() => { if (es.readyState === 2) return; es.readyState = 1; es.onopen && es.onopen({}) }, 0)
          const live = /\\/traffic\\/live/.test(String(url)) && window.__AIRLOCK_LIVE__
          if (live) {
            const wait = setInterval(() => {
              if (es.readyState === 2) return clearInterval(wait)
              if (!document.querySelector('.topo-body .topo-node')) return
              clearInterval(wait)
              for (const e of live) es.onmessage && es.onmessage({ data: JSON.stringify(e) })
            }, 50)
          }
          return es
        }
        window.EventSource.CLOSED = 2; window.EventSource.OPEN = 1; window.EventSource.CONNECTING = 0
      })()` })
      await ctx.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if ((url.port === String(port) && url.hostname === 'localhost') || url.hostname === '127.0.0.1') {
          // Etappe 7: Snake-Seite – dieselbe Seite und CSP, die Caddy an unbekannte interne Namen gibt
          if (s.snake && url.pathname.startsWith('/__snake/')) {
            const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('base64')
            return route.fulfill({ status: 404, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': snakeCsp(sha) }, body: renderSnakePage() })
          }
          // Etappe 5: öffentliche Statusseite – dieselben Dateien, die Airlock in das Volume schreibt
          if (s.statusPage && url.pathname.startsWith('/__statusseite/')) {
            const data = fx.statusPublic(s.statusPage)
            const file = url.pathname.slice('/__statusseite/'.length) || STATUS_FILES.page
            const files: Record<string, [string, string]> = {
              [STATUS_FILES.page]: [renderStatusPage(data), 'text/html; charset=utf-8'],
              [STATUS_FILES.css]: [STATUS_CSS, 'text/css; charset=utf-8'],
              [STATUS_FILES.js]: [STATUS_JS, 'text/javascript; charset=utf-8'],
              [STATUS_FILES.json]: [JSON.stringify(data), 'application/json'],
              [STATUS_FILES.feed]: [renderStatusFeed(data, data.incidents, 'https://status.example.ch'), 'application/rss+xml'],
            }
            const hit = files[file]
            return hit ? route.fulfill({ status: 200, contentType: hit[1], body: hit[0] }) : route.fulfill({ status: 404, body: '' })
          }
          if (url.pathname.startsWith('/api/')) {
            // M9: Listen einer Umgebung (/environments/<slug>/projects …) zählen für die Sonderfälle der
            // Szenen wie die alten Pfade ohne Umgebung (/api/v1/projects)
            const path = url.pathname.replace(/^\/api\/v1\/environments\/[^/]+(?=\/)/, '/api/v1')
            // nie beantwortet: Ladezustand («POST /pfad» nur für diese Methode)
            if (s.hang?.some((h) => path === h || `${route.request().method()} ${path}` === h)) return
            if (s.offline && url.pathname === '/api/v1/auth/me') return json(route, { error: { code: 'bad_gateway', message: 'nicht erreichbar' } }, 502)
            if ((s.me || s.disketti || s.matrix) && s.loggedIn !== false && url.pathname === '/api/v1/auth/me' && route.request().method() === 'GET') {
              return json(route, { ...fx.me, theme: t, unlocks: unlocksFor(t), ...(s.disketti ? { disketti: true } : {}), ...(s.matrix ? { matrix: true } : {}), ...s.me })
            }
            if (s.achievementNew && url.pathname === '/api/v1/auth/achievements') return json(route, fx.achievements('neu'))
            if (s.scanRunning && path === '/api/v1/projects' && route.request().method() === 'GET') {
              const list = (api(url.pathname, 'GET', true, t, s.count).body as { projects: import('@airlock/shared').ProjectDto[] }).projects
              return json(route, { projects: list.map((x) => (x.id === fx.runningScanProjectId && x.security ? { ...x, security: { ...x.security, status: 'running' as const } } : x)) })
            }
            if (s.fail?.includes(path) || s.fail?.includes(`${route.request().method()} ${path}`)) return json(route, { error: { code: 'internal', message: 'Datenbank antwortet nicht (Zeitüberschreitung nach 5 s).' } }, 500)
            if (s.stageFailed && /\/scans\/latest$/.test(url.pathname)) {
              const r = api(url.pathname + url.search, 'GET', true, t, s.count).body as { report: import('@airlock/shared').ScanReportDto | null }
              if (r.report) {
                const st = r.report.scan.stages
                const key = Object.keys(st).find((k) => k.startsWith('nuclei')) ?? Object.keys(st).at(-1)!
                st[key] = { ...st[key]!, ran: false, failed: true, state: 'failed', note: 'Nuclei-Container nach 3 Versuchen nicht gestartet (Image-Pull verweigert)' }
              }
              return json(route, r)
            }
            if (s.empty && path === '/api/v1/projects') return json(route, { projects: [] })
            if (s.zones2 && path === '/api/v1/domains') return json(route, fx.domainsTwo)
            if (s.broken && path === '/api/v1/projects') return json(route, { projects: [{ id: 'kaputt', name: 'Kaputt' }] })
            if (url.pathname === '/api/v1/client-errors') return route.fulfill({ status: 204, body: '' })
            if (s.envPatch && route.request().method() === 'GET' && /^\/api\/v1\/environments(\/example)?$/.test(url.pathname)) {
              const list = fx.environments.map((e) => (e.slug === 'example' ? { ...e, ...s.envPatch } : e))
              return json(route, url.pathname.endsWith('/example') ? { environment: list.find((e) => e.slug === 'example') } : { environments: list })
            }
            if (s.empty && path === '/api/v1/audit') return json(route, { events: [] })
            // Zugriffe neu: einzelne Anfragen (Standard: Daten nach Vorlage; s.access für leer, wartet, aus)
            const am = path.match(/^\/api\/v1\/projects\/([^/]+)\/access$/)
            if (am) return json(route, accessFixture(am[1]!, url.searchParams.get('range'), s.access))
            // Etappe 3: Besucher
            if (s.traffic) {
              const tm = path.match(/^\/api\/v1\/projects\/([^/]+)\/traffic$/)
              if (tm) {
                const range = (url.searchParams.get('range') ?? '24h') as import('@airlock/shared').TrafficRange
                const way = (url.searchParams.get('way') ?? 'all') as import('@airlock/shared').TrafficWay | 'all'
                return json(route, fx.traffic(tm[1]!, range, way, s.traffic))
              }
              if (path === '/api/v1/traffic/today') return json(route, s.traffic === 'aus' ? { views: {}, ingest: 'off' } : fx.trafficToday)
              // Besucher neu: «Gerade eben» und Server › Besucher
              const rm = path.match(/^\/api\/v1\/projects\/([^/]+)\/traffic\/recent$/)
              if (rm) return json(route, fx.trafficRecent(rm[1]!, s.traffic))
              if (url.pathname === '/api/v1/system/traffic/sources') return json(route, fx.trafficSources(s.traffic))
            }
            // Etappe 4: Aufbau-Zustände und Vorschau «Dienst hinzufügen/entfernen»
            if (s.topo && /^\/api\/v1\/projects\/[^/]+\/topology$/.test(path)) {
              return json(route, { topology: fx.topologyVariant(path.split('/')[4]!, s.topo) })
            }
            if (route.request().method() === 'POST' && /^\/api\/v1\/projects\/[^/]+\/services\/plan$/.test(path)) {
              return json(route, { plan: fx.servicePlan(route.request().postDataJSON(), s.topo && fx.DEPLOY_VARIANTS.includes(s.topo) ? 'deploy' : 'pull_request') })
            }
            // Etappe 6: Vorschauen an bzw. an und leer
            if (s.previews && route.request().method() === 'GET') {
              const pm = path.match(/^\/api\/v1\/projects\/([^/]+)\/(previews|preview-env)$/)
              if (pm) return json(route, pm[2] === 'previews' ? fx.previews(pm[1]!, s.previews) : fx.previewEnv(pm[1]!, s.previews))
            }
            // M8: GitHub-Seite in zwei Zuständen (noch nichts / installiert)
            if (url.pathname === '/api/v1/github') return json(route, fx.github(Boolean(s.githubConnected)))
            // Meilenstein Backup: Server › Backup
            if (url.pathname === '/api/v1/system/backup') return json(route, fx.backupStatus(s.backup ?? 'ok'))
            if (url.pathname === '/api/v1/system/backup/snapshots') return json(route, { snapshots: fx.backupSnapshots })
            if (url.pathname === '/api/v1/system/backup/key/paper') return json(route, fx.backupKeyPaper)
            if (url.pathname === '/api/v1/system/backup/restore/preview') {
              return json(route, fx.backupRestorePreview(url.searchParams.get('snapshot') ?? '', url.searchParams.get('project') ?? ''))
            }
            if (s.cfDone && (path === '/api/v1/cloudflare' || url.pathname === '/api/v1/system/cloudflare')) return json(route, { ...fx.cloudflare, tls: { ...fx.cloudflare.tls, phase: 'done' } })
            if (s.cspReverted && url.pathname.endsWith('/header-rules')) return json(route, fx.headerRules(fx.securityProjectId, true))
            if (s.cspQuality && url.pathname.endsWith(`/projects/${fx.securityProjectId}/scans/latest`)) {
              const r = api(url.pathname + url.search, 'GET', true, t, s.count).body as { report: import('@airlock/shared').ScanReportDto | null }
              return json(route, { report: r.report ? fx.withCspQuality(r.report) : null })
            }
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
// --themes hell,dunkel,win95 (Standard: hell,dunkel); --viewport: nur das Fenster (1440×900), nie die ganze Seite
const { values: args } = parseArgs({ options: { out: { type: 'string' }, only: { type: 'string' }, themes: { type: 'string' }, viewport: { type: 'boolean' } } })
const THEME_OF = { hell: 'light', dunkel: 'dark', win95: 'win95', terminal: 'terminal' } as const
const themes = (args.themes ?? 'hell,dunkel').split(',').map((s) => s.trim()).filter((s): s is keyof typeof THEME_OF => s in THEME_OF)
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
  for (const theme of themes) {
    const t = THEME_OF[theme]
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
        await page.screenshot({ path: file, fullPage: !args.viewport && s.full !== false })
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
