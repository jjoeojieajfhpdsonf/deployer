import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { missingLockfiles, depsSummary, detectJsLibs, fromBanner, sourceChecked, listFiles } from './deps.js'
import { parseTrivy } from './parsers.js'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (p: string) => join(here, 'fixtures', p)

describe('Trivy fs: verwundbare Pakete im Lockfile', () => {
  // Gekürzte echte Ausgabe: trivy 0.58.1 fs --scanners vuln,secret,misconfig
  // --ignore-unfixed --list-all-pkgs über fixtures/deps/with-lock
  const json = JSON.parse(readFileSync(fx('trivy-fs-deps.json'), 'utf8'))

  test('Befunde je Paket, mit höchster Schwere', () => {
    const f = parseTrivy(json)
    const minimist = f.find((x) => x.title.startsWith('minimist'))
    const lodash = f.find((x) => x.title.startsWith('lodash'))
    assert.equal(minimist?.severity, 'critical')
    assert.equal(lodash?.severity, 'high')
    assert.match(lodash!.title, /4 bekannte Schwachstellen/)
    assert.equal(lodash!.location, 'pnpm-lock.yaml · lodash 4.17.20')
  })

  test('Behebung nennt das Lockfile, nicht das Basis-Image', () => {
    const lodash = parseTrivy(json).find((x) => x.title.startsWith('lodash'))!
    assert.match(lodash.fix, /pnpm-lock\.yaml neu erzeugen/)
    assert.doesNotMatch(lodash.fix, /Basis-Image/)
  })

  test('Anzeige: «Abhängigkeiten: 2 Pakete aus pnpm-lock.yaml»', () => {
    assert.equal(depsSummary(json), 'Abhängigkeiten: 2 Pakete aus pnpm-lock.yaml')
  })

  test('ohne Lockfile: ausdrücklich «keine Abhängigkeiten gefunden»', () => {
    assert.match(depsSummary({ Results: [{ Target: 'Dockerfile', Class: 'config' }] }), /^keine Abhängigkeiten gefunden/)
  })

  test('mehrere Lockfiles werden zusammengezählt', () => {
    const s = depsSummary({ Results: [
      { Target: 'web/pnpm-lock.yaml', Class: 'lang-pkgs', Packages: new Array(200).fill({}) },
      { Target: 'api/go.sum', Class: 'lang-pkgs', Packages: new Array(14).fill({}) },
    ] })
    assert.equal(s, 'Abhängigkeiten: 214 Pakete (200 aus web/pnpm-lock.yaml, 14 aus api/go.sum)')
  })
})

describe('Manifest ohne Lockfile', () => {
  test('package.json mit Abhängigkeiten ohne Lock: Befund «niedrig»', async () => {
    const f = await missingLockfiles(fx('deps/no-lock'))
    assert.equal(f.length, 1)
    assert.equal(f[0]!.severity, 'low')
    assert.equal(f[0]!.title, 'Ohne Lockfile keine verlässliche Prüfung der Abhängigkeiten')
    assert.equal(f[0]!.location, 'package.json')
  })

  test('mit pnpm-lock.yaml daneben: kein Befund', async () => {
    assert.deepEqual(await missingLockfiles(fx('deps/with-lock')), [])
  })

  test('package.json ohne Abhängigkeiten, Unterordner, node_modules ignoriert', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deps-'))
    try {
      const put = (p: string, s: string) => { const full = join(dir, p); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, s) }
      put('package.json', '{"name":"x","scripts":{"start":"node ."}}')
      put('api/go.mod', 'module x\n\ngo 1.22\n\nrequire github.com/a/b v1.0.0\n')
      put('web/package.json', '{"dependencies":{"vue":"^3"}}')
      put('web/yarn.lock', '# yarn lockfile v1\n')
      put('node_modules/foo/package.json', '{"dependencies":{"bar":"1"}}')
      put('py/pyproject.toml', '[project]\nname = "x"\ndependencies = ["requests>=2"]\n')
      put('py/requirements.txt', 'requests==2.31.0\n')
      const f = await missingLockfiles(dir)
      assert.deepEqual(f.map((x) => x.location), ['api/go.mod'])
      assert.match(f[0]!.fix, /go\.sum/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Statische Seite ohne Build: JS-Bibliotheken im Ausgabeordner', () => {
  test('erkennt jquery-3.4.1.min.js am Namen und Bootstrap am Kopfkommentar, auch in vendor/', async () => {
    const libs = await detectJsLibs(fx('deps/static-site'))
    assert.deepEqual(libs.map((l) => `${l.name} ${l.version}`).sort(), ['bootstrap 4.3.1', 'jquery 3.4.1'])
  })

  test('eigener Code wird nicht als Bibliothek erkannt', async () => {
    const libs = await detectJsLibs(fx('deps/static-site'))
    assert.ok(!libs.some((l) => l.file.endsWith('app.js')))
  })

  test('Kopfkommentare gängiger Bibliotheken', () => {
    assert.deepEqual(fromBanner('/*! jQuery v1.12.4 | (c) jQuery Foundation */', 'a.js'), { name: 'jquery', version: '1.12.4', file: 'a.js' })
    assert.equal(fromBanner('/*! jQuery UI - v1.12.1 - 2016-09-14', 'b.js')?.name, 'jquery-ui')
    assert.equal(fromBanner('/*! DOMPurify 2.0.8 | (c) Cure53', 'c.js')?.version, '2.0.8')
    assert.equal(fromBanner('console.log(1)', 'd.js'), null)
  })

  test('Anzeigetext nennt Lockfile, fehlende Lockfiles und Bibliotheken', () => {
    const s = sourceChecked('keine Abhängigkeiten gefunden (kein Lockfile im Quellcode)', [{ name: 'jquery', version: '3.4.1', file: 'js/jquery-3.4.1.min.js' }], 0)
    assert.match(s, /^keine Abhängigkeiten gefunden/)
    assert.match(s, /JS-Bibliotheken im Ausgabeordner: jquery 3\.4\.1/)
    assert.match(sourceChecked('Abhängigkeiten: 2 Pakete aus pnpm-lock.yaml', [], 1), /1 Manifest ohne Lockfile/)
  })

  test('listFiles überspringt node_modules', async () => {
    const files = await listFiles(fx('deps'))
    assert.ok(files.includes('with-lock/pnpm-lock.yaml'))
    assert.ok(!files.some((f) => f.includes('node_modules')))
  })
})

