import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fixPrompt } from '@deployer/shared'
import {
  fixWay, affectedPaths, secretLocation, maskContent, containsMask, isWithheld, tagCandidates, parseTag, fixedInFrom,
  SECRET_LINE_MARK, ENV_VALUE_MARK,
} from './fix-context.js'
import { unifiedDiff } from '../lib/diff.js'

describe('Diff für Vorschläge', () => {
  test('geänderte Zeile mit Kontext und korrekten Zeilenangaben', () => {
    const a = ['FROM node:18', 'WORKDIR /app', 'COPY . .', 'RUN npm ci', 'CMD ["node","server.js"]'].join('\n')
    const b = ['FROM node:18', 'WORKDIR /app', 'COPY . .', 'RUN npm ci', 'USER node', 'CMD ["node","server.js"]'].join('\n')
    const d = unifiedDiff('Dockerfile', a, b)
    assert.equal(d, ['--- a/Dockerfile', '+++ b/Dockerfile', '@@ -2,4 +2,5 @@', ' WORKDIR /app', ' COPY . .', ' RUN npm ci', '+USER node', ' CMD ["node","server.js"]'].join('\n'))
  })
  test('neue und gelöschte Datei, unverändert leer', () => {
    assert.match(unifiedDiff('.dockerignore', null, '.env\n.git\n'), /^--- \/dev\/null\n\+\+\+ b\/.dockerignore\n@@ -0,0 \+1,2 @@\n\+.env\n\+.git$/)
    assert.match(unifiedDiff('backup.sql', 'x\n', null), /^--- a\/backup.sql\n\+\+\+ \/dev\/null\n@@ -1,1 \+0,0 @@\n-x$/)
    assert.equal(unifiedDiff('a', 'gleich\n', 'gleich\n'), '')
  })
  test('weit auseinander liegende Änderungen: zwei Hunks', () => {
    const a = Array.from({ length: 30 }, (_, i) => `z${i}`)
    const b = [...a]
    b[2] = 'neu2'
    b[25] = 'neu25'
    const d = unifiedDiff('f', a.join('\n'), b.join('\n'))
    assert.equal(d.split('\n').filter((l) => l.startsWith('@@')).length, 2)
  })
})

describe('Weg zum Beheben', () => {
  const f = (tool: string, title: string) => ({ tool, title })
  test('je Quelle', () => {
    assert.equal(fixWay(f('header-check', 'Referrer-Policy fehlt'), { sourceType: 'files', runtimeKind: 'static', github: false }), 'header')
    assert.equal(fixWay(f('trivy', 'Container läuft als root'), { sourceType: 'files', runtimeKind: 'dockerfile', github: false }), 'files')
    assert.equal(fixWay(f('trivy', 'x'), { sourceType: 'image', runtimeKind: 'image', github: false }), 'image')
    assert.equal(fixWay(f('trivy', 'x'), { sourceType: 'dockerfile', runtimeKind: 'dockerfile', github: false }), 'repo')
    assert.equal(fixWay(f('trivy', 'x'), { sourceType: 'compose', runtimeKind: 'compose', github: true }), 'github')
    assert.equal(fixWay(f('nuclei', 'x'), { sourceType: 'static', runtimeKind: 'static', github: false }), 'none')
  })
  test('Auftrag nennt Projekt, Befund-ID und den passenden Weg', () => {
    const p = fixPrompt({ projectName: 'Solar', slug: 'solar', findingId: '11111111-2222-3333-4444-555555555555', title: 'Container läuft als root', severity: 'medium', way: 'files' })
    assert.ok(p.includes('get_fix_context') && p.includes('"solar"') && p.includes('11111111-2222-3333-4444-555555555555'))
    assert.ok(p.includes('propose_fix') && p.includes('nicht mit update_files'))
    assert.ok(fixPrompt({ projectName: 'A', slug: 'a', findingId: 'x', title: 't', severity: 'low', way: 'repo' }).includes('nie direkt auf dem Standard-Branch'))
  })
})

describe('Betroffene Dateien', () => {
  const repo = ['Dockerfile', 'compose.yaml', 'package.json', 'package-lock.json', 'src/config.js', 'public/index.html', 'public/.env', '.env', 'web/package.json', 'web/package-lock.json']
  test('Trivy-Paket in einer Lock-Datei: Lock und package.json', () => {
    assert.deepEqual(affectedPaths({ tool: 'trivy', title: 'lodash: 2 bekannte Schwachstellen', location: 'web/package-lock.json · lodash 4.17.20' }, repo), ['web/package-lock.json', 'web/package.json'])
  })
  test('Secret: Datei ohne Zeile; Env-Dateien nie', () => {
    assert.deepEqual(affectedPaths({ tool: 'trivy', title: 'Secret im Code: GitHub Token', location: 'src/config.js:12' }, repo), ['src/config.js'])
    assert.deepEqual(affectedPaths({ tool: 'nuclei', title: 'Offene .env', location: 'http://solar.int.example.ch/.env' }, repo), [])
  })
  test('Container-Einstellungen: Dockerfile und Compose', () => {
    assert.deepEqual(affectedPaths({ tool: 'trivy', title: 'Container läuft als root', location: 'Dockerfile' }, repo), ['Dockerfile', 'compose.yaml'])
    assert.deepEqual(affectedPaths({ tool: 'trivy', title: 'openssl: 1 bekannte Schwachstelle', location: 'deployer/solar:abc (debian 12.4) · openssl 3.0.11' }, repo), ['Dockerfile', 'compose.yaml'])
  })
  test('offen erreichbare Datei über ihren Pfad', () => {
    assert.deepEqual(affectedPaths({ tool: 'nuclei', title: 'Backup offen', location: 'http://x.example/index.html' }, repo), ['public/index.html'])
  })
  test('zurückgehalten', () => {
    for (const p of ['.env', 'app/.env.production', 'certs/server.key', 'id_rsa']) assert.equal(isWithheld(p), true, p)
    assert.equal(isWithheld('environment.ts'), false)
  })
})

describe('Bereinigen vor dem Versand', () => {
  test('Secret-Zeile und Env-Werte ersetzt, Zähler stimmen', () => {
    const src = ['const a = 1', 'const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"', 'const url = "postgres://u:geheim123@db/x"', 'const b = 2'].join('\n')
    const m = maskContent(src, { secretLines: [2], envValues: ['geheim123', 'x', ''] })
    assert.equal(m.maskedLines, 1)
    assert.equal(m.maskedValues, 1)
    assert.ok(!m.content.includes('ghp_') && !m.content.includes('geheim123'))
    assert.ok(m.content.includes(SECRET_LINE_MARK) && m.content.includes(ENV_VALUE_MARK))
    assert.ok(m.content.includes('const b = 2'), 'kurze Werte (unter 4 Zeichen) bleiben: sonst wäre alles ersetzt')
    assert.equal(containsMask(m.content), true)
    assert.equal(containsMask('ok'), false)
  })
  test('Secret-Ort aus dem Trivy-Befund', () => {
    assert.deepEqual(secretLocation({ tool: 'trivy', title: 'Secret im Code: AWS Access Key', location: 'src/config.js:12' }), { path: 'src/config.js', line: 12 })
    assert.equal(secretLocation({ tool: 'trivy', title: 'Container läuft als root', location: 'Dockerfile:3' }), null)
  })
})

describe('Fertige Images: neuere Tags derselben Linie', () => {
  test('gleiche Variante und Stellenzahl, neueste der Hauptversion zuerst', () => {
    const tags = ['1.21-alpine', '1.25-alpine', '1.27-alpine', '1.27.3-alpine', '2.0-alpine', '1.27', '1.28-alpine-slim', '1.29-rc-alpine', 'latest', 'mainline-alpine']
    assert.deepEqual(tagCandidates('1.21-alpine', tags), ['1.27-alpine', '2.0-alpine'])
    assert.deepEqual(tagCandidates('1.27-alpine', ['1.27-alpine']), [])
    assert.deepEqual(tagCandidates('latest', tags), [])
  })
  test('Varianten mit Ziffern (alpine3.18) gelten als dieselbe Linie', () => {
    assert.deepEqual(parseTag('3.12.1-alpine3.18'), { prefix: '', nums: [3, 12, 1], flavor: '-alpine' })
    assert.deepEqual(tagCandidates('3.12.1-alpine3.18', ['3.12.7-alpine3.20', '3.13.0-alpine3.20', '3.12.7-slim']), ['3.13.0-alpine3.20'])
  })
  test('gleiche Version: genau dieselbe Variante zuerst (gefunden gegen Docker Hub)', () => {
    assert.deepEqual(tagCandidates('1.21-alpine', ['1.31-alpine3.24', '1.31-alpine']), ['1.31-alpine'])
  })

  test('behebende Version aus dem Befund', () => {
    assert.equal(fixedInFrom({ tool: 'trivy', title: 'openssl: 2 bekannte Schwachstellen mit verfügbarem Fix', fix: 'openssl auf 3.0.15-r1 bzw. 3.1.7-r1 oder neuer aktualisieren (meist: Basis-Image aktualisieren und neu bauen).' }), 'openssl 3.0.15-r1 bzw. 3.1.7-r1')
    assert.equal(fixedInFrom({ tool: 'zap', title: 'x', fix: 'y' }), null)
  })
})
