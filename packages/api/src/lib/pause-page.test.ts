import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  renderMarkdown, renderPausePage, pauseHeaders, escapeHtml, pausePageSchema, pauseOptionsSchema, effectivePausePage,
  DEFAULT_PAUSE_PAGE, PAUSE_CSP, forcePreviewScheme, pauseHtmlProblems, type PausePage,
} from '@airlock/shared'

const page = (over: Partial<PausePage> = {}): PausePage => ({ ...DEFAULT_PAUSE_PAGE, ...over })

describe('Pause-Seite: Escaping', () => {
  test('HTML im Text bleibt Text', () => {
    const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>')
    assert.doesNotMatch(html, /<script|<img/)
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  })

  test('Titel wird escaped, auch im <title>', () => {
    const html = renderPausePage(page({ title: '</title><script>x</script>' }))
    assert.doesNotMatch(html, /<script>x/)
    assert.equal(html.match(/&lt;\/title&gt;&lt;script&gt;/g)?.length, 2)
  })

  test('Caddy-Platzhalter im Text werden nicht ersetzt (geschweifte Klammern als Entität)', () => {
    const html = renderPausePage(page({ message: 'IP: {http.request.remote.host} {env.SECRET}' }))
    assert.doesNotMatch(html, /\{(http|env)\./)
    assert.match(html, /&#123;http\.request\.remote\.host&#125;/)
  })

  test('Anführungszeichen können kein Attribut verlassen', () => {
    const html = renderMarkdown('[x](https://example.ch/"onmouseover="alert(1))')
    assert.doesNotMatch(html, /" onmouseover="|"onmouseover="alert/)
  })

  test('escapeHtml deckt alle Sonderzeichen ab', () => {
    assert.equal(escapeHtml(`<a href="x" title='y'>&{}</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&#123;&#125;&lt;/a&gt;')
  })
})

describe('Pause-Seite: einfaches Markdown', () => {
  test('Absätze, Zeilenumbruch, fett', () => {
    assert.equal(renderMarkdown('Erste **wichtige** Zeile\nzweite Zeile\n\nNeuer Absatz'), '<p>Erste <strong>wichtige</strong> Zeile<br>zweite Zeile</p>\n<p>Neuer Absatz</p>')
  })

  test('Links nur https und mailto', () => {
    assert.match(renderMarkdown('[Status](https://status.example.ch)'), /<a href="https:\/\/status\.example\.ch\/" rel="noopener noreferrer">Status<\/a>/)
    assert.match(renderMarkdown('[Mail](mailto:hallo@example.ch)'), /<a href="mailto:hallo@example\.ch"/)
    for (const bad of ['[x](javascript:alert(1))', '[x](http://example.ch)', '[x](data:text/html,hi)', '[x](//example.ch)']) {
      assert.doesNotMatch(renderMarkdown(bad), /<a /, bad)
    }
  })

  test('fett im Linktext, Text vor und nach dem Link escaped', () => {
    assert.equal(renderMarkdown('a<b [**fett**](https://x.ch) c>d'), '<p>a&lt;b <a href="https://x.ch/" rel="noopener noreferrer"><strong>fett</strong></a> c&gt;d</p>')
  })
})

describe('Pause-Seite: Inhalt', () => {
  test('Standard ist der bisherige Text, Sprache de', () => {
    const html = renderPausePage(DEFAULT_PAUSE_PAGE)
    assert.match(html, /<html lang="de">/)
    assert.match(html, /<h1>Vorübergehend nicht erreichbar<\/h1>/)
    assert.match(html, /Diese Seite ist gerade pausiert/)
  })

  test('Englisch: lang="en" und englische Beschriftung', () => {
    const html = renderPausePage(page({ lang: 'en', title: 'Temporarily unavailable', contact: 'ops@example.ch' }), { backAt: '2026-11-11T07:00:00Z', timeZone: 'Europe/Zurich' })
    assert.match(html, /<html lang="en">/)
    assert.match(html, /Expected back: <time datetime="2026-11-11T07:00:00.000Z">/)
    assert.match(html, /Contact: <a href="mailto:ops@example\.ch">/)
  })

  test('Voraussichtlich zurück in Zürcher Zeit', () => {
    const html = renderPausePage(DEFAULT_PAUSE_PAGE, { backAt: '2026-11-11T07:00:00Z', timeZone: 'Europe/Zurich' })
    assert.match(html, /Voraussichtlich zurück: <time[^>]*>[^<]*08:00/)
  })

  test('Link und Kontakt erscheinen nur, wenn gesetzt', () => {
    assert.doesNotMatch(renderPausePage(DEFAULT_PAUSE_PAGE), /class="meta"><a/)
    assert.match(renderPausePage(page({ linkText: 'Status', linkUrl: 'https://status.example.ch' })), />Status<\/a>/)
  })

  test('Darstellung folgt prefers-color-scheme; Vorschau fest hell oder dunkel', () => {
    assert.match(renderPausePage(DEFAULT_PAUSE_PAGE), /@media \(prefers-color-scheme:dark\)/)
    const dark = renderPausePage(DEFAULT_PAUSE_PAGE, { theme: 'dark' })
    assert.doesNotMatch(dark, /prefers-color-scheme/)
    assert.match(dark, /color-scheme:dark/)
  })
})

describe('Pause-Seite: Header', () => {
  const now = Date.parse('2026-11-10T19:00:00Z')

  test('noindex, no-store, CSP ohne Quellen, Kennung', () => {
    const h = pauseHeaders(null, now)
    assert.deepEqual(h['X-Robots-Tag'], ['noindex'])
    assert.deepEqual(h['Cache-Control'], ['no-store'])
    assert.deepEqual(h['Content-Security-Policy'], [PAUSE_CSP])
    assert.equal(PAUSE_CSP, "default-src 'none'; style-src 'unsafe-inline'")
    assert.deepEqual(h['X-Airlock-State'], ['paused'])
  })

  test('Retry-After nur mit «Voraussichtlich zurück» in der Zukunft, als HTTP-Datum', () => {
    assert.equal(pauseHeaders(null, now)['Retry-After'], undefined)
    assert.deepEqual(pauseHeaders('2026-11-11T07:00:00Z', now)['Retry-After'], ['Wed, 11 Nov 2026 07:00:00 GMT'])
    assert.equal(pauseHeaders('2026-11-10T18:00:00Z', now)['Retry-After'], undefined)
  })
})

describe('Pause-Seite: Eingaben', () => {
  test('Link nur https, mit Text; Kontakt muss E-Mail sein', () => {
    assert.equal(pausePageSchema.safeParse(page({ linkText: 'x', linkUrl: 'http://example.ch' })).success, false)
    assert.equal(pausePageSchema.safeParse(page({ linkText: 'x', linkUrl: 'javascript:alert(1)' })).success, false)
    assert.equal(pausePageSchema.safeParse(page({ linkText: '', linkUrl: 'https://example.ch' })).success, false)
    assert.equal(pausePageSchema.safeParse(page({ contact: 'kein-mail' })).success, false)
    assert.equal(pausePageSchema.safeParse(page({ linkText: 'Status', linkUrl: 'https://status.example.ch', contact: 'a@b.ch' })).success, true)
  })

  test('Titel und Text sind Pflicht, mit Grenzen', () => {
    assert.equal(pausePageSchema.safeParse(page({ title: ' ' })).success, false)
    assert.equal(pausePageSchema.safeParse(page({ message: 'x'.repeat(2001) })).success, false)
  })

  test('Voraussichtlich zurück: ISO mit Zeitzone', () => {
    assert.equal(pauseOptionsSchema.safeParse({ backAt: '2026-11-11T08:00:00+01:00' }).success, true)
    assert.equal(pauseOptionsSchema.safeParse({ backAt: 'morgen' }).success, false)
  })

  test('eigene Seite vor Vorlage vor Standard', () => {
    const t = page({ title: 'Vorlage' })
    const o = page({ title: 'Projekt' })
    assert.equal(effectivePausePage(t, o).title, 'Projekt')
    assert.equal(effectivePausePage(t, null).title, 'Vorlage')
    assert.equal(effectivePausePage(null, null).title, DEFAULT_PAUSE_PAGE.title)
  })
})

describe('Pause-Seite: Code-Modus', () => {
  const html = '<!doctype html><html lang="de"><head><style>body{margin:0}</style></head><body><h1>{{title}}</h1><p>Zurück: {{ back_at }}</p><time datetime="{{back_at_iso}}"></time></body></html>'

  test('eigenes HTML unverändert, nur Platzhalter eingesetzt', () => {
    const out = renderPausePage(page({ mode: 'code', title: 'Umzug <bald>', html }), { backAt: '2026-11-11T07:00:00Z', timeZone: 'Europe/Zurich' })
    assert.match(out, /<style>body\{margin:0\}<\/style>/)
    assert.match(out, /<h1>Umzug &lt;bald&gt;<\/h1>/)
    assert.match(out, /Zurück: [^<]*08:00/)
    assert.match(out, /datetime="2026-11-11T07:00:00.000Z"/)
  })

  test('ohne «zurück um» bleiben die Platzhalter leer', () => {
    const out = renderPausePage(page({ mode: 'code', html }))
    assert.match(out, /Zurück: <\/p>/)
  })

  test('Formular-Modus ignoriert html', () => {
    assert.match(renderPausePage(page({ mode: 'form', html: '<html>x</html>' })), /<h1>Vorübergehend nicht erreichbar<\/h1>/)
  })

  test('Code-Modus verlangt ein ganzes Dokument und hat eine Grösse', () => {
    assert.equal(pausePageSchema.safeParse(page({ mode: 'code', html: '' })).success, false)
    assert.equal(pausePageSchema.safeParse(page({ mode: 'code', html: '<p>nur ein Absatz</p>' })).success, false)
    assert.equal(pausePageSchema.safeParse(page({ mode: 'code', html: `<html>${'x'.repeat(100_001)}</html>` })).success, false)
    assert.equal(pausePageSchema.safeParse(page({ mode: 'code', html })).success, true)
  })

  test('Prüfleiste: kein JavaScript, keine externen Quellen, mit Zeilenangabe', () => {
    const doc = (body: string) => `<!doctype html>\n<html lang="de">\n<head><style>p{color:red}</style></head>\n<body>${body}</body></html>`
    assert.deepEqual(pauseHtmlProblems(doc('<p>Wartung</p><a href="https://status.example.ch">Status</a>')), [])
    const bad = pauseHtmlProblems(doc('\n<script>x()</script>\n<img src="https://cdn.example/x.png" onload="y()">\n<div style="background:url(//e.x/a.png)"></div>'))
    assert.deepEqual(bad.map((p) => [p.kind, p.line]), [['script', 5], ['script', 6], ['external', 6], ['external', 7]])
    assert.equal(pauseHtmlProblems('<style>@import "x.css";</style>')[0]?.kind, 'external')
    assert.equal(pauseHtmlProblems(`<html>${'x'.repeat(100_001)}</html>`)[0]?.kind, 'size')
    // Schema: Speichern mit Skript wird abgelehnt, mit Zeile in der Meldung
    const r = pausePageSchema.safeParse(page({ mode: 'code', html: doc('<script>x</script>') }))
    assert.equal(r.success, false)
    assert.match(r.success ? '' : r.error.issues[0]!.message, /^Zeile 4: <script>/)
  })

  test('Vorschau fest hell/dunkel: Media-Queries umgeschrieben', () => {
    const css = '@media (prefers-color-scheme: dark){a{}} @media (prefers-color-scheme:light){b{}}'
    assert.equal(forcePreviewScheme(css, 'dark'), '@media (min-width: 0px){a{}} @media (max-width: 0px){b{}}')
    assert.equal(forcePreviewScheme(css, 'light'), '@media (max-width: 0px){a{}} @media (min-width: 0px){b{}}')
  })

  test('alte Einträge ohne mode gelten als Formular', () => {
    const r = pausePageSchema.parse({ lang: 'de', title: 't', message: 'm' })
    assert.equal(r.mode, 'form')
  })
})

describe('Pause-Seite: Datei im Code-Modus', () => {
  test('schreibt index.html unter _pause/<slug>, nur bei Änderung, atomar', async () => {
    process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
    process.env.ADMIN_PASSWORD ??= 'x'
    const { writePauseFile } = await import('../domain/pause-page.js')
    const { mkdtempSync, readFileSync, statSync, readdirSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const sites = mkdtempSync(join(tmpdir(), 'sites-'))
    try {
      const dir = await writePauseFile(sites, 'verein', '<html>eins</html>')
      assert.equal(dir, join(sites, '_pause', 'verein'))
      assert.equal(readFileSync(join(dir, 'index.html'), 'utf8'), '<html>eins</html>')
      const before = statSync(join(dir, 'index.html')).mtimeMs
      await new Promise((r) => setTimeout(r, 20))
      await writePauseFile(sites, 'verein', '<html>eins</html>')
      assert.equal(statSync(join(dir, 'index.html')).mtimeMs, before, 'unverändert: nicht neu geschrieben')
      await writePauseFile(sites, 'verein', '<html>zwei</html>')
      assert.equal(readFileSync(join(dir, 'index.html'), 'utf8'), '<html>zwei</html>')
      assert.deepEqual(readdirSync(dir), ['index.html'], 'keine tmp-Datei liegen geblieben')
    } finally {
      rmSync(sites, { recursive: true, force: true })
    }
  })
})
