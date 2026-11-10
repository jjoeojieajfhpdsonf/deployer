/**
 * Prototyp «Umgebungen» (docs/SPEC.md, Abschnitt Umgebungen) – nur für Screenshots.
 *
 * Die App kennt noch keine Umgebungen. Diese Datei blendet Umschalter,
 * Einstellungen der Umgebung und «Projekt verschieben» per DOM über die echte
 * Oberfläche (Fixtures aus fixtures.ts), mit den Tokens und Klassen aus
 * styles.css. Kein Produktivcode; wird beim Umsetzen durch echte Komponenten
 * ersetzt.
 *
 *   pnpm --filter @deployer/web exec tsx design-shots/shoot.ts --out docs/design-cal/umgebungen --only umgebungen
 */
import type { Page } from 'playwright'

/** Umgebungen des Prototyps; «example.ch» steht für die heutige Installation (jherren.com). */
const ENVS = [
  { short: 'EX', name: 'example.ch', domain: 'example.ch', projects: 7, critical: 1, current: true },
  { short: 'VB', name: 'Verein', domain: 'verein-beispiel.ch', projects: 2, critical: 0 },
  { short: 'LA', name: 'Labor', domain: 'example.dev', projects: 0, critical: 0 },
]
const CUR = ENVS[0]!

const chevronDown = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" /></svg>'
const check = '<svg class="menu-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>'
const plus = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>'
const sliders = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" /><circle cx="10" cy="4.5" r="1.5" /><circle cx="6" cy="11.5" r="1.5" /></svg>'
const warn = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2 14.3 13H1.7Z" /><path d="M8 6.4v3M8 11.3v.1" /></svg>'

/** Nur neue Bausteine; alles andere kommt aus styles.css. */
const CSS = `
.env-sep { color: var(--faint); font-size: 20px; line-height: 1; margin: 0 -4px; }
.env-switch { position: relative; }
.env-trigger { display: inline-flex; align-items: center; gap: 4px; min-height: 32px; padding: 0 6px 0 4px; border: none; border-radius: var(--r-sm); background: transparent; box-shadow: none; color: var(--ink); cursor: pointer; }
.env-trigger:hover, .env-trigger[aria-expanded='true'] { background: var(--surface); box-shadow: var(--sh-card); }
.env-trigger svg { color: var(--muted); }
.env-mark { display: grid; place-items: center; flex: none; width: 24px; height: 24px; border-radius: var(--r-xs); background: var(--surface-2); box-shadow: var(--sh-ring); color: var(--ink-dim); font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
.env-switch .menu-list { left: -4px; right: auto; width: 300px; transform-origin: top left; }
.menu-list .env-item { min-height: 52px; padding: 6px var(--sp-3) 6px 10px; gap: 10px; }
.env-item-text { display: grid; gap: 1px; min-width: 0; text-align: left; }
.env-item-text strong { font-weight: 500; }
.env-item-text span { font-size: var(--fs-12); color: var(--muted); }
.env-item-text .count-critical { color: var(--bad); font-weight: 500; }
.rail-group { display: grid; gap: 1px; padding: 0 var(--sp-3) var(--sp-2); font-size: var(--fs-12); color: var(--muted); }
.rail-group strong { color: var(--ink-dim); font-weight: 500; font-size: var(--fs-13); }
.rail-group-server { margin-top: var(--sp-5); }
.env-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-4); margin: 0 0 var(--sp-4); }
.env-facts .stat { padding: var(--sp-5) var(--sp-6); }
.env-facts .stat span { font-size: var(--fs-13); color: var(--muted); }
.env-facts .stat strong { font-size: var(--fs-16); font-weight: 600; }
.env-section-title { margin: var(--sp-8) 0 var(--sp-3); }
.env-section-title + .hint { margin-top: -4px; }
.move-list li { grid-template-columns: minmax(160px, 220px) minmax(0, 1fr); }
.move-actions { margin-top: var(--sp-5); }
.env-pill-row { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
`

/** Seitenleiste mit Umschalter neben dem Logo; Gruppen «Umgebung» und «Server». */
export async function railWithEnvironments(page: Page, opts: { open?: boolean } = {}): Promise<void> {
  await page.evaluate(({ css, envs, cur, open, chevronDown, check, plus, sliders }) => {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)

    const name = document.querySelector<HTMLElement>('.brand-name')!
    name.textContent = 'Airlock'
    const items = envs.map((e) => `
      <button type="button" role="menuitemradio" aria-checked="${e.current ? 'true' : 'false'}" class="env-item">
        <span class="env-mark" aria-hidden="true">${e.short}</span>
        <span class="env-item-text"><strong>${e.name}</strong><span>${e.name === e.domain ? '' : `${e.domain} · `}${e.projects === 1 ? '1 Projekt' : `${e.projects} Projekte`}${e.critical ? ` · <span class="count-critical">${e.critical} kritisch</span>` : ''}</span></span>
        ${e.current ? check : ''}
      </button>`).join('')
    name.insertAdjacentHTML('afterend', `
      <span class="env-sep" aria-hidden="true">/</span>
      <div class="menu env-switch">
        <button type="button" class="env-trigger" aria-haspopup="menu" aria-expanded="${open ? 'true' : 'false'}" aria-label="Umgebung: ${cur.name}, wechseln" title="Umgebung wechseln">
          <span class="env-mark" aria-hidden="true">${cur.short}</span>${chevronDown}
        </button>
        <div class="menu-list" role="menu" aria-label="Umgebungen" ${open ? 'data-open' : ''}>
          <div class="menu-group-label" aria-hidden="true">Umgebungen</div>
          ${items}
          <div class="menu-sep"></div>
          <button type="button" role="menuitem">${plus}Umgebung anlegen …</button>
          <a role="menuitem" href="/u/example/einstellungen">Umgebungen verwalten</a>
        </div>
      </div>`)

    const nav = document.querySelector<HTMLElement>('.rail-nav')!
    nav.setAttribute('aria-label', `Umgebung ${cur.name}`)
    nav.insertAdjacentHTML('afterbegin', `<div class="rail-group"><strong>${cur.name}</strong>Umgebung · ${cur.projects} Projekte</div>`)
    const system = nav.querySelector<HTMLAnchorElement>('a[href="/system"]')!
    const server = system.cloneNode(true) as HTMLAnchorElement
    server.classList.remove('active')
    server.querySelector('.rail-label')!.textContent = 'Server'
    system.querySelector('.rail-label')!.textContent = 'Einstellungen'
    system.querySelector('svg')!.outerHTML = sliders
    system.setAttribute('href', '/u/example/einstellungen')
    nav.insertAdjacentHTML('beforeend', '<div class="rail-group rail-group-server"><strong>Server</strong>für alle Umgebungen</div>')
    nav.append(server)

    // Pfad beginnt mit der Umgebung statt mit dem Servernamen
    const first = document.querySelector('.crumbs a, .crumbs span:not(.crumbs-sep)')
    if (first) first.textContent = cur.name.toLowerCase()
  }, { css: CSS, envs: ENVS, cur: CUR, open: opts.open ?? false, chevronDown, check, plus, sliders })
  await page.waitForTimeout(250)
}

const tabs = (active: string) => `
  <nav class="tabs" aria-label="Bereiche der Umgebung">
    ${['Allgemein', 'Cloudflare &amp; HTTPS', 'Standards'].map((t) => `<a href="#" class="${t === active ? 'tab tab-active' : 'tab'}"${t === active ? ' aria-current="page"' : ''}>${t}</a>`).join('')}
  </nav>
  <p class="lede lede-tight">Gilt nur für die Umgebung <strong>${CUR.name}</strong>. Tunnel, Benachrichtigungen und GitHub gelten für alle Umgebungen und stehen unter <a href="#">Server</a>.</p>`

async function replacePage(page: Page, title: string, crumb: string, html: string): Promise<void> {
  await page.evaluate(({ title, crumb, html }) => {
    const pg = document.querySelector<HTMLElement>('main .page')!
    for (const el of [...pg.children]) if (!el.classList.contains('page-head')) el.remove()
    pg.querySelector('h1')!.textContent = title
    const crumbs = document.querySelector('.crumbs')
    if (crumbs) crumbs.innerHTML = `<a href="#">example.ch</a><span class="crumbs-sep" aria-hidden="true"> / </span><span>${crumb}</span>`
    pg.insertAdjacentHTML('beforeend', html)
    window.scrollTo(0, 0)
  }, { title, crumb, html })
  await page.waitForTimeout(150)
}

/** Einstellungen → Cloudflare &amp; HTTPS: Hauptzone, interne Basis, Zertifikat, Token, Tunnel. */
export async function environmentCloudflare(page: Page): Promise<void> {
  await railWithEnvironments(page)
  await replacePage(page, 'Einstellungen', 'einstellungen', `
    ${tabs('Cloudflare &amp; HTTPS')}
    <div class="env-facts">
      <div class="stat"><span>Hauptzone</span><strong>example.ch</strong></div>
      <div class="stat"><span>Interne Basis</span><strong>int.example.ch</strong></div>
      <div class="stat"><span>Adresse in Airlock</span><strong>/u/example</strong></div>
    </div>

    <h2 class="env-section-title">Interne Adressen und Zertifikat</h2>
    <p class="hint">Projekte dieser Umgebung sind intern unter <code>&lt;name&gt;.int.example.ch</code> erreichbar, aus dem LAN und dem Tailnet.</p>
    <ul class="check-list">
      <li class="check-ok"><span class="check-name">Zertifikat *.int.example.ch</span><span class="check-detail">Let's Encrypt, gültig bis 8. Februar 2027 · erneuert sich selbst</span></li>
      <li class="check-ok"><span class="check-name">Tailnet</span><span class="check-detail">*.int.example.ch → 100.88.41.12 (Cloudflare, nicht proxied)</span></li>
      <li class="check-ok"><span class="check-name">Lokaler DNS</span><span class="check-detail">Umschreibung greift: haushaltsbuch.int.example.ch → 192.168.1.20</span></li>
      <li class="check-none"><span class="check-name">Oberfläche</span><span class="check-detail">deployer.int.example.ch · nur in der Standard-Umgebung</span></li>
    </ul>

    <h2 class="env-section-title">Cloudflare</h2>
    <p class="hint">Token für DNS, Zertifikat und öffentliche Namen dieser Umgebung. Ein Token lässt sich mit anderen Umgebungen im selben Cloudflare-Konto teilen.</p>
    <fieldset class="field-group">
      <legend>Token</legend>
      <label class="choice"><input type="radio" name="tok" checked /><span>Eigenes Token dieser Umgebung<small>Konto «Heim» · geprüft vor 2 Stunden · alle Rechte vorhanden</small></span></label>
      <label class="choice"><input type="radio" name="tok" /><span>Token von «Labor» mitbenutzen<small>Gleiches Konto «Heim». Das Token muss die Zone example.ch sehen.</small></span></label>
      <div class="form-actions">
        <button type="button">Token ersetzen …</button>
        <span class="status status-running"><span class="status-dot" aria-hidden="true"></span>gültig</span>
      </div>
    </fieldset>

    <p class="hint" style="margin-top: var(--sp-6)">Tunnel: einer pro Cloudflare-Konto, verwaltet unter Server, weil ihn mehrere Umgebungen nutzen.</p>
    <ul class="check-list">
      <li class="check-ok"><span class="check-name">airlock-heimserver</span><span class="check-detail">verbunden · geteilt mit «Labor» (gleiches Konto) · 4 öffentliche Namen aus dieser Umgebung</span></li>
    </ul>
  `)
}

/** Einstellungen → Standards: Header-Vorlagen, Access, Pause-Seite. */
export async function environmentStandards(page: Page): Promise<void> {
  await railWithEnvironments(page)
  const row = (h: string, v: string, state: 'on' | 'off', scope: string) => `
    <tr>
      <td><code>${h}</code></td>
      <td class="muted">${v}</td>
      <td>${state === 'on'
        ? '<span class="status status-running"><span class="status-dot" aria-hidden="true"></span>aktiv</span>'
        : '<span class="status status-stopped"><span class="status-dot" aria-hidden="true"></span>aus</span>'}</td>
      <td class="muted">${scope}</td>
      <td class="row-actions"><button type="button" class="button-small">Ändern</button></td>
    </tr>`
  await replacePage(page, 'Einstellungen', 'standards', `
    ${tabs('Standards')}
    <h2 class="env-section-title">Header-Vorlagen</h2>
    <p class="hint">Caddy setzt diese Header für jedes Projekt der Umgebung, solange das Projekt keine eigene Regel hat. Eine Änderung wirkt sofort auf alle, ohne Redeploy. Die Content-Security-Policy bleibt pro Projekt.</p>
    <div class="table-scroll">
      <table class="table">
        <thead><tr><th>Header</th><th>Wert</th><th>Zustand</th><th>Gilt für</th><th><span class="visually-hidden">Aktion</span></th></tr></thead>
        <tbody>
          ${row('X-Content-Type-Options', 'nosniff', 'on', '7 von 7 Projekten')}
          ${row('Referrer-Policy', 'strict-origin-when-cross-origin', 'on', '6 von 7 · Fotoalbum mit eigener Regel')}
          ${row('frame-ancestors', "'self'", 'on', '7 von 7 Projekten')}
          ${row('Strict-Transport-Security', 'max-age=86400', 'off', 'erst, wenn TLS stabil läuft')}
        </tbody>
      </table>
    </div>

    <fieldset class="field-group" style="margin-top: var(--sp-6)">
      <legend>Cloudflare Access</legend>
      <p class="hint">Standard für neue öffentliche Projekte dieser Umgebung. Bestehende Projekte behalten ihre Einstellung.</p>
      <label class="choice"><input type="checkbox" checked /><span>Neue öffentliche Projekte hinter Access stellen<small>Anmeldung per E-Mail-Code, nur die Adressen unten.</small></span></label>
      <label for="acc">Erlaubte E-Mail-Adressen</label>
      <input id="acc" value="hallo@example.ch" />
      <div class="form-actions"><button type="button" class="button-primary" disabled>Speichern</button></div>
    </fieldset>

    <fieldset class="field-group">
      <legend>Pause-Seite</legend>
      <p class="hint">Vorlage für pausierte öffentliche Projekte dieser Umgebung: «Vorübergehend nicht erreichbar», Deutsch, Link zur Statusseite. Beim Pausieren pro Projekt anpassbar.</p>
      <div class="form-actions"><button type="button">Vorlage bearbeiten …</button><button type="button">Von «Verein» übernehmen …</button></div>
    </fieldset>
  `)
}

/** Projekt → Einstellungen: «In andere Umgebung verschieben» mit Vorschau der Folgen. */
export async function moveProject(page: Page): Promise<void> {
  await railWithEnvironments(page)
  await page.evaluate(({ warn }) => {
    const danger = document.querySelector<HTMLElement>('.danger-zone')!
    danger.insertAdjacentHTML('beforebegin', `
      <fieldset class="field-group" id="move" style="margin-top: var(--sp-8)">
        <legend>In andere Umgebung verschieben</legend>
        <p class="hint">Container, Versionen, Scans und Secrets bleiben, wie sie sind. Es ändern sich die Adressen und die geerbten Standards.</p>
        <label for="move-target">Zielumgebung</label>
        <select id="move-target" style="max-width: 360px"><option>Verein · verein-beispiel.ch</option></select>
        <h3 class="env-section-title" style="margin-top: var(--sp-6)">Was sich ändert</h3>
        <ul class="check-list move-list" style="box-shadow: var(--sh-ring)">
          <li class="check-none"><span class="check-name">Interne Adresse</span><span class="check-detail">vereinsseite.int.example.ch → <strong>vereinsseite.int.verein-beispiel.ch</strong>. Die alte Adresse leitet 30 Tage weiter.</span></li>
          <li class="check-fail"><span class="check-name">Öffentliche Adresse</span><span class="check-detail">verein.example.ch wird entfernt (Zone gehört zu example.ch), die Pause endet. Danach ist das Projekt privat.</span></li>
          <li class="check-none"><span class="check-name">Header</span><span class="check-detail">Referrer-Policy wechselt auf den Standard von «Verein»: <code>no-referrer</code>. Eigene Regeln bleiben.</span></li>
          <li class="check-none"><span class="check-name">Tokens</span><span class="check-detail">2 Tokens von example.ch sehen das Projekt nicht mehr, darunter «Claude Code Mac».</span></li>
          <li class="check-ok"><span class="check-name">Version und Daten</span><span class="check-detail">bleiben · kein Neu-Deploy, nur Caddy-Abgleich</span></li>
        </ul>
        <div class="form-actions move-actions" role="group" aria-label="Verschieben bestätigen">
          <span class="confirm-note">${warn}«Vereinsseite» ist danach nicht mehr öffentlich erreichbar.</span>
          <button type="button">Abbrechen</button>
          <button type="button" class="button-danger-solid">Ja, nach «Verein» verschieben</button>
        </div>
      </fieldset>`)
    document.getElementById('move')!.scrollIntoView({ block: 'start' })
    window.scrollBy(0, -32)
  }, { warn })
  await page.waitForTimeout(200)
}
