import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  branchSlug, previewLabel, isPreviewLabel, serviceLabelClash, previewTargets, assertPreviewTargets, PreviewPublicError,
  withoutPublicPreviewRoutes, previewAbility, planPreviews, mergeEnvLevels, envInheritance, previewStateOf,
  previewComment, previewCheck, PREVIEW_COMMENT_MARK, type PlanInput, type PlanPreview,
} from './previews.js'
import { internalServiceLabel } from './internal-routes.js'

/** Etappe 6: Vorschau-Deploys – Slug, nur intern, Entscheidungen, Aufräumen, Vererbung, Texte. */

describe('Slug und Adresse', () => {
  test('Branch-Namen: Sonderzeichen, Umlaute, Schrägstriche, refs/heads/', () => {
    assert.equal(branchSlug('feature/Neue_Suche'), 'feature-neue-suche')
    assert.equal(branchSlug('refs/heads/fix/Größe ändern'), 'fix-groesse-aendern')
    assert.equal(branchSlug('café--crème…'), 'cafe-creme')
    assert.equal(branchSlug('dependabot/npm_and_yarn/vite-5.4.2'), 'dependabot-npm-and-yarn-vite-5-4-2')
    assert.equal(branchSlug('🚀'), '')
    // Läufe von Bindestrichen werden einer: «--» steht nur als Trenner zum Projekt
    assert.ok(!branchSlug('a---b--c').includes('--'))
  })

  test('<branch-slug>--<projekt>, gültiges DNS-Label', () => {
    assert.equal(previewLabel('feature/login', 'fotoalbum'), 'feature-login--fotoalbum')
    assert.ok(isPreviewLabel('feature-login--fotoalbum'))
    // nur Sonderzeichen: Ersatzname
    assert.equal(previewLabel('🚀', 'shop'), 'branch--shop')
  })

  test('zu lang: gekürzt mit Hash-Suffix, höchstens 63 Zeichen, gleicher Branch → gleiche Adresse', () => {
    const long = `feature/${'sehr-lange-beschreibung-'.repeat(5)}ende`
    const a = previewLabel(long, 'fotoalbum')
    assert.ok(a.length <= 63, `${a} (${a.length})`)
    assert.ok(isPreviewLabel(a))
    assert.match(a, /^feature-sehr-lange[a-z0-9-]*-[0-9a-f]{6}--fotoalbum$/)
    assert.equal(previewLabel(long, 'fotoalbum'), a)
    // zwei lange Branches mit gleichem Anfang bekommen verschiedene Adressen
    assert.notEqual(previewLabel(`${long}-zwei`, 'fotoalbum'), a)
    // längster erlaubter Kurzname (40 Zeichen)
    const slug40 = 'a'.repeat(40)
    const b = previewLabel(long, slug40)
    assert.ok(b.length <= 63 && isPreviewLabel(b), b)
  })

  test('genau 63 Zeichen bleiben ungekürzt, 64 werden gekürzt', () => {
    const slug = 'shop'
    const fit = 'x'.repeat(63 - '--shop'.length)
    assert.equal(previewLabel(fit, slug), `${fit}--shop`)
    const over = `${fit}y`
    const l = previewLabel(over, slug)
    assert.ok(l.length <= 63 && /-[0-9a-f]{6}--shop$/.test(l), l)
  })

  test('nie «--» an Stelle 3–4 (IDN, «xn--»): zwei Zeichen lange Branches bekommen ein Suffix', () => {
    assert.ok(!isPreviewLabel('xn--shop'))
    const l = previewLabel('v2', 'shop')
    assert.notEqual(l, 'v2--shop')
    assert.ok(isPreviewLabel(l), l)
    assert.equal(previewLabel('xn', 'shop').slice(2, 4) === '--', false)
  })

  test('Kollision mit einer Dienst-Adresse des Projekts (Etappe 4): abweichender Slug', () => {
    const services = new Set([internalServiceLabel('adminer', 'fotoalbum'), internalServiceLabel('mailpit', 'fotoalbum')])
    const l = previewLabel('adminer', 'fotoalbum', (x) => services.has(x))
    assert.notEqual(l, 'adminer--fotoalbum')
    assert.match(l, /^adminer-[0-9a-f]{6}--fotoalbum$/)
    assert.ok(!services.has(l))
  })

  test('Kollision mit Projekten, anderen Vorschauen und mehrfach belegten Hash-Namen', () => {
    const taken = new Set(['main-x--shop'])
    const first = previewLabel('main-x', 'shop', (x) => taken.has(x))
    taken.add(first)
    const second = previewLabel('main-x', 'shop', (x) => taken.has(x))
    assert.notEqual(first, second)
    assert.ok(isPreviewLabel(second))
  })

  test('reservierte Namen (status, airlock, int …) sind nie eine Vorschau', () => {
    // Mit Trenner kann ein Label nie genau «status» sein; die Prüfung bleibt trotzdem
    for (const l of ['status', 'airlock', 'deployer', 'int']) assert.notEqual(previewLabel(l, 'shop'), l)
  })

  test('umgekehrt: neuer Dienst, dessen Adresse eine Vorschau überdecken würde', () => {
    assert.equal(serviceLabelClash('feature-login', 'fotoalbum', ['feature-login--fotoalbum']), 'feature-login--fotoalbum')
    assert.equal(serviceLabelClash('adminer', 'fotoalbum', ['feature-login--fotoalbum']), null)
    assert.equal(serviceLabelClash('Feature-Login', 'fotoalbum', ['feature-login--fotoalbum']), 'feature-login--fotoalbum')
  })
})

describe('nur intern', () => {
  test('Ziele: interne Wege des Projekts, nie öffentlich; ohne internen Weg Tailnet', () => {
    assert.deepEqual(previewTargets(['public', 'lan', 'tailnet']), ['lan', 'tailnet'])
    assert.deepEqual(previewTargets(['public']), ['tailnet'])
    assert.deepEqual(previewTargets([]), ['tailnet'])
    assert.deepEqual(previewTargets(['lan', 'lan']), ['lan'])
  })

  test('öffentliches Ziel für eine Vorschau wird abgelehnt', () => {
    assert.throws(() => assertPreviewTargets(['tailnet', 'public']), PreviewPublicError)
    assert.doesNotThrow(() => assertPreviewTargets(['lan', 'tailnet']))
  })

  test('Caddy: öffentliche Routen von Vorschauen fallen weg, die anderer Projekte bleiben', () => {
    const rows = [
      { projectId: 'p', target: 'public' }, { projectId: 'p', target: 'lan' },
      { projectId: 'v', target: 'public' }, { projectId: 'v', target: 'tailnet' },
    ]
    assert.deepEqual(withoutPublicPreviewRoutes(rows, (id) => id === 'v'), [
      { projectId: 'p', target: 'public' }, { projectId: 'p', target: 'lan' }, { projectId: 'v', target: 'tailnet' },
    ])
  })

  test('Schalter nur für Git-Projekte mit GitHub-App, sonst mit Begründung', () => {
    assert.deepEqual(previewAbility({ sourceType: 'compose', repoUrl: 'https://github.com/a/b', githubRepo: 'a/b' }), { available: true, reason: null })
    assert.match(previewAbility({ sourceType: 'files', repoUrl: null, githubRepo: null }).reason!, /Chat/)
    assert.match(previewAbility({ sourceType: 'image', repoUrl: null, githubRepo: null }).reason!, /Image/)
    assert.match(previewAbility({ sourceType: 'compose', repoUrl: null, githubRepo: null }).reason!, /hochgeladen/)
    assert.match(previewAbility({ sourceType: 'dockerfile', repoUrl: 'https://gitlab.com/a/b', githubRepo: null }).reason!, /GitHub-App/)
    assert.equal(previewAbility({ sourceType: 'static', repoUrl: 'x', githubRepo: 'a/b', isPreview: true }).available, false)
  })
})

describe('Abfrage: neue Vorschauen, Pushes und Aufräumen', () => {
  const now = new Date('2026-11-12T12:00:00Z')
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000)
  const sha = (c: string) => c.repeat(40)
  const pull = (number: number, branch: string, s: string, fromFork = false) => ({ number, url: `https://github.com/a/b/pull/${number}`, branch, sha: s, fromFork })
  const pv = (o: Partial<PlanPreview> & { id: string; branch: string }): PlanPreview => ({ headSha: sha('1'), lastPushAt: days(1), prNumber: null, busy: false, ...o })
  const base = (o: Partial<PlanInput>): PlanInput => ({ now, defaultBranch: 'main', branches: [], pulls: [], seen: { heads: {}, prs: [] }, previews: [], ...o })

  test('erste Abfrage nach dem Einschalten: nur Branches mit offenem PR, nie der Hauptbranch, nie Forks', () => {
    const r = planPreviews(base({
      seen: null,
      branches: [{ name: 'main', sha: sha('a') }, { name: 'alt', sha: sha('b') }, { name: 'feature', sha: sha('c') }],
      pulls: [pull(7, 'feature', sha('c')), pull(8, 'evil', sha('d'), true), pull(9, 'main', sha('a'))],
    }))
    assert.deepEqual(r.create.map((c) => c.branch), ['feature'])
    assert.deepEqual(r.create[0]!.pr, { number: 7, url: 'https://github.com/a/b/pull/7' })
    // PR 8 (Fork) und 9 (Hauptbranch) zählen nie
    assert.deepEqual(r.seen.prs, [7])
    assert.equal(r.seen.heads.alt, sha('b'))
  })

  test('Push auf neuen oder bekannten Branch → Vorschau; unveränderter Branch nicht', () => {
    const r = planPreviews(base({
      seen: { heads: { main: sha('a'), alt: sha('b'), moved: sha('c') }, prs: [] },
      branches: [{ name: 'main', sha: sha('f') }, { name: 'alt', sha: sha('b') }, { name: 'moved', sha: sha('d') }, { name: 'neu', sha: sha('e') }],
    }))
    assert.deepEqual(r.create.map((c) => c.branch).sort(), ['moved', 'neu'])
  })

  test('neu geöffneter PR auf altem Branch → Vorschau', () => {
    const r = planPreviews(base({
      seen: { heads: { alt: sha('b') }, prs: [] },
      branches: [{ name: 'alt', sha: sha('b') }],
      pulls: [pull(12, 'alt', sha('b'))],
    }))
    assert.deepEqual(r.create.map((c) => c.branch), ['alt'])
  })

  test('neuer Push auf Branch mit Vorschau → neu deployen; läuft gerade einer, nächstes Mal', () => {
    const r = planPreviews(base({
      branches: [{ name: 'f', sha: sha('2') }, { name: 'g', sha: sha('3') }],
      previews: [pv({ id: 'v1', branch: 'f' }), pv({ id: 'v2', branch: 'g', busy: true })],
    }))
    assert.deepEqual(r.update, [{ id: 'v1', branch: 'f', sha: sha('2'), pr: null }])
    assert.deepEqual(r.create, [])
  })

  test('Aufräumen: Pull Request geschlossen oder gemergt', () => {
    const r = planPreviews(base({
      branches: [{ name: 'f', sha: sha('1') }],
      pulls: [],
      previews: [pv({ id: 'v1', branch: 'f', prNumber: 4 })],
    }))
    assert.deepEqual(r.remove, [{ id: 'v1', branch: 'f', reason: 'pr_closed' }])
    // danach nicht gleich wieder anlegen (Kopf und PR bekannt)
    const again = planPreviews(base({ seen: r.seen, branches: [{ name: 'f', sha: sha('1') }] }))
    assert.deepEqual(again.create, [])
  })

  test('Aufräumen: Branch gelöscht', () => {
    const r = planPreviews(base({ branches: [], previews: [pv({ id: 'v1', branch: 'weg', prNumber: 3 })], pulls: [] }))
    assert.deepEqual(r.remove, [{ id: 'v1', branch: 'weg', reason: 'branch_deleted' }])
  })

  test('Aufräumen: 7 Tage ohne Push (genau 7 Tage bleiben), ein neuer Push rettet sie', () => {
    const r = planPreviews(base({
      branches: [{ name: 'alt', sha: sha('1') }, { name: 'grenze', sha: sha('1') }, { name: 'frisch', sha: sha('9') }],
      previews: [
        pv({ id: 'v1', branch: 'alt', lastPushAt: days(7.01) }),
        pv({ id: 'v2', branch: 'grenze', lastPushAt: days(7) }),
        pv({ id: 'v3', branch: 'frisch', lastPushAt: days(30) }),
      ],
    }))
    assert.deepEqual(r.remove, [{ id: 'v1', branch: 'alt', reason: 'idle' }])
    assert.deepEqual(r.update.map((u) => u.id), ['v3'])
  })

  test('höchstens 3: die mit dem ältesten Push fällt raus', () => {
    const r = planPreviews(base({
      seen: { heads: { a: sha('1'), b: sha('1'), c: sha('1') }, prs: [] },
      branches: ['a', 'b', 'c', 'd'].map((name) => ({ name, sha: name === 'd' ? sha('4') : sha('1') })),
      previews: [
        pv({ id: 'va', branch: 'a', lastPushAt: days(3) }),
        pv({ id: 'vb', branch: 'b', lastPushAt: days(1) }),
        pv({ id: 'vc', branch: 'c', lastPushAt: days(2) }),
      ],
    }))
    assert.deepEqual(r.create.map((c) => c.branch), ['d'])
    assert.deepEqual(r.remove, [{ id: 'va', branch: 'a', reason: 'limit' }])
  })

  test('mehr neue als Platz: neueste PRs zuerst, die übrigen erst beim nächsten Push', () => {
    const r = planPreviews(base({
      seen: null,
      branches: ['a', 'b', 'c', 'd'].map((name) => ({ name, sha: sha('1') })),
      pulls: [pull(1, 'a', sha('1')), pull(2, 'b', sha('1')), pull(3, 'c', sha('1')), pull(4, 'd', sha('1'))],
    }))
    assert.deepEqual(r.create.map((c) => c.branch), ['d', 'c', 'b'])
    assert.deepEqual(r.remove, [])
  })

  test('PR dazugekommen oder gewechselt: verknüpfen, ohne neu zu deployen', () => {
    const r = planPreviews(base({
      branches: [{ name: 'f', sha: sha('1') }],
      pulls: [pull(5, 'f', sha('1'))],
      previews: [pv({ id: 'v1', branch: 'f' })],
    }))
    assert.deepEqual(r.link, [{ id: 'v1', pr: { number: 5, url: 'https://github.com/a/b/pull/5' } }])
    assert.deepEqual(r.update, [])
  })

  test('Fork-PR auf gleichnamigen Branch zählt nicht als PR der Vorschau', () => {
    const r = planPreviews(base({
      branches: [{ name: 'f', sha: sha('1') }],
      pulls: [pull(5, 'f', sha('9'), true)],
      previews: [pv({ id: 'v1', branch: 'f', prNumber: 2 })],
    }))
    assert.deepEqual(r.remove, [{ id: 'v1', branch: 'f', reason: 'pr_closed' }])
  })
})

describe('Variablen-Ebene «Vorschau»', () => {
  test('erbt vom Projekt, überschreibt gleichnamige; eigene Werte der Vorschau zuletzt', () => {
    const project = [{ key: 'DATABASE_URL', value: 'postgres://db/prod', isSecret: true }, { key: 'NODE_ENV', value: 'production', isSecret: false }, { key: 'API_KEY', value: 'live', isSecret: true }]
    const preview = [{ key: 'API_KEY', value: 'test', isSecret: true }, { key: 'PREVIEW', value: '1', isSecret: false }]
    const own = [{ key: 'NODE_ENV', value: 'preview', isSecret: false }]
    const m = Object.fromEntries(mergeEnvLevels(project, preview, own).map((e) => [e.key, e.value]))
    assert.deepEqual(m, { API_KEY: 'test', DATABASE_URL: 'postgres://db/prod', NODE_ENV: 'preview', PREVIEW: '1' })
  })

  test('Anzeige: geerbt, nur Vorschau, überschrieben', () => {
    assert.deepEqual(envInheritance(['A', 'B'], ['B', 'C']), [
      { key: 'A', source: 'projekt' }, { key: 'B', source: 'ueberschrieben' }, { key: 'C', source: 'vorschau' },
    ])
  })
})

describe('Zustand, Kommentar und Check', () => {
  test('Zustand aus letztem Deployment', () => {
    assert.equal(previewStateOf({ desiredState: 'running', last: null, hasActive: false }), 'deploying')
    assert.equal(previewStateOf({ desiredState: 'running', last: { status: 'healthchecking' }, hasActive: true }), 'deploying')
    assert.equal(previewStateOf({ desiredState: 'running', last: { status: 'failed' }, hasActive: true }), 'failed')
    assert.equal(previewStateOf({ desiredState: 'running', last: { status: 'active' }, hasActive: true }), 'ready')
    assert.equal(previewStateOf({ desiredState: 'stopped', last: { status: 'active' }, hasActive: true }), 'stopped')
  })

  const report = {
    label: 'feature-login--fotoalbum', branch: 'feature/login', sha: 'abcdef1234567890', url: 'https://feature-login--fotoalbum.int.example.ch',
    state: 'ready' as const, failure: null, airlockUrl: 'https://airlock.int.example.ch/projekte/p1?tab=deployments',
    scan: { status: 'done' as const, grade: 'B' as const, score: 82, open: { critical: 0, high: 1, medium: 2, low: 0 } },
  }

  test('Kommentar: Link, nur intern, Commit, Scan-Ergebnis, Markierung', () => {
    const c = previewComment(report)
    assert.ok(c.startsWith(PREVIEW_COMMENT_MARK))
    assert.match(c, /https:\/\/feature-login--fotoalbum\.int\.example\.ch/)
    assert.match(c, /nie öffentlich/)
    assert.match(c, /Commit `abcdef1`/)
    assert.match(c, /Note B \(82 \/ 100\) · offen: 0 kritisch, 1 hoch/)
    assert.match(c, /✅ bereit/)
  })

  test('Kommentar nach dem Entfernen nennt den Grund', () => {
    assert.match(previewComment({ ...report, removed: 'pr_closed' }), /Entfernt: Pull Request geschlossen oder gemergt/)
    assert.match(previewComment({ ...report, removed: 'idle' }), /7 Tage ohne Push/)
  })

  test('Check: läuft, grün, rot bei kritischem Befund oder gescheitertem Deploy', () => {
    assert.equal(previewCheck({ ...report, state: 'deploying' }).status, 'in_progress')
    assert.equal(previewCheck({ ...report, scan: { ...report.scan, status: 'running' } }).status, 'in_progress')
    assert.equal(previewCheck(report).conclusion, 'success')
    assert.equal(previewCheck({ ...report, scan: { ...report.scan, open: { ...report.scan.open, critical: 1 } } }).conclusion, 'failure')
    assert.equal(previewCheck({ ...report, state: 'failed', failure: 'Healthcheck nicht bestanden' }).conclusion, 'failure')
  })
})
