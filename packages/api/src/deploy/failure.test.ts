import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { explainFailure, deployFixPrompt, failureNextStep as nextStep, listeningOn, missingEnvVar, type FailureInput } from '@airlock/shared'

/**
 * UI-Qualität 2: je Fehlermuster ein echtes Deploy-Log (fixtures/failure).
 * Die Fehlermeldung ist, wie in der Pipeline, der Text nach «FEHLGESCHLAGEN:».
 */
const dir = join(import.meta.dirname, 'fixtures', 'failure')
function load(name: string, extra: Partial<FailureInput> = {}) {
  const log = readFileSync(join(dir, `${name}.log`), 'utf8')
  const message = /FEHLGESCHLAGEN: (.*)$/m.exec(log)?.[1] ?? null
  return explainFailure({ message, log, port: 8080, healthcheckPath: '/health', image: null, memoryLimitMb: 512, envKeys: [], ...extra })
}

describe('Fehler erklären: Muster aus Log und Healthcheck', () => {
  test('fehlende Umgebungsvariable (Node) → «Variable X fehlt» + Hinzufügen', () => {
    const e = load('env-fehlt-node')
    assert.equal(e.kind, 'env_missing')
    assert.equal(e.title, 'Variable DATABASE_URL fehlt')
    assert.deepEqual(e.action, { kind: 'add_env', name: 'DATABASE_URL', exists: false, label: 'Hinzufügen' })
    assert.equal(e.linesFrom, 'container')
    assert.ok(e.lines.some((l) => l.includes('Missing required environment variable')))
  })

  test('fehlende Umgebungsvariable (Python, KeyError)', () => {
    const e = load('env-fehlt-python')
    assert.equal(e.kind, 'env_missing')
    assert.equal(e.action.kind === 'add_env' && e.action.name, 'DJANGO_SECRET_KEY')
  })

  test('fehlende Umgebungsvariable (Liste darunter, envalid)', () => {
    const e = load('env-fehlt-liste')
    assert.equal(e.action.kind === 'add_env' && e.action.name, 'API_TOKEN')
  })

  test('gesetzte Variable, von der App abgelehnt → ändern statt hinzufügen', () => {
    const e = load('env-fehlt-node', { envKeys: ['DATABASE_URL'] })
    assert.equal(e.title, 'Variable DATABASE_URL wird nicht akzeptiert')
    assert.deepEqual(e.action, { kind: 'add_env', name: 'DATABASE_URL', exists: true, label: 'DATABASE_URL ändern' })
  })

  test('anderer Port im Log → «Port ändern auf 3000»', () => {
    const e = load('port-anders')
    assert.equal(e.kind, 'port_mismatch')
    assert.deepEqual(e.action, { kind: 'set_field', field: 'port', value: 3000, label: 'Port ändern auf 3000' })
  })

  test('gleicher Port, aber nur 127.0.0.1 → lauscht nur im Container', () => {
    const e = load('nur-localhost', { port: 5000 })
    assert.equal(e.kind, 'listen_localhost')
    assert.equal(e.action.kind, 'claude')
  })

  test('Container beendet → Exit-Code und letzte Zeilen', () => {
    const e = load('beendet')
    assert.equal(e.kind, 'exited')
    assert.equal(e.exitCode, 1)
    assert.match(e.title, /Exit-Code 1/)
    assert.ok(e.lines.some((l) => l.includes("Cannot find module '/app/server.js'")))
    assert.equal(e.action.kind, 'claude')
  })

  test('OOMKilled → «Grenze erhöhen» mit der aktuellen Grenze im Satz', () => {
    const e = load('oom')
    assert.equal(e.kind, 'oom')
    assert.equal(e.exitCode, 137)
    assert.match(e.cause, /512 MB/)
    assert.deepEqual(e.action, { kind: 'set_field', field: 'memoryLimitMb', value: null, label: 'Grenze erhöhen' })
  })

  test('npm-Build → npm-Meldung im Satz, Build-Log, «Mit Claude lösen»', () => {
    const e = load('npm-build')
    assert.equal(e.kind, 'build_npm')
    assert.match(e.cause, /Missing script: "build"/)
    assert.equal(e.linesFrom, 'build')
    assert.ok(!e.lines.some((l) => l.includes('FEHLGESCHLAGEN')), 'Fehlerzeile steht schon im Titel')
    assert.deepEqual(e.action, { kind: 'claude', label: 'Mit Claude lösen' })
  })

  test('pip-Build → pip-Meldung im Satz', () => {
    const e = load('pip-build')
    assert.equal(e.kind, 'build_pip')
    assert.match(e.cause, /numpy==1\.21\.0/)
  })

  test('Image nicht gefunden / Zugriff verweigert → Image ändern', () => {
    const missing = load('image-fehlt', { image: 'ghcr.io/example/wetterstaton:1.0' })
    assert.equal(missing.kind, 'image_missing')
    assert.equal(missing.title, 'Image nicht gefunden')
    assert.match(missing.cause, /wetterstaton:1\.0/)
    const denied = load('image-verweigert')
    assert.equal(denied.title, 'Zugriff auf das Image verweigert')
    assert.equal(denied.action.kind, 'change_source')
  })

  test('Healthcheck-Pfad 404 → Pfad ändern', () => {
    const e = load('healthcheck-404')
    assert.equal(e.kind, 'health_http_4xx')
    assert.match(e.cause, /\/health antwortet mit HTTP 404/)
    assert.equal(e.action.kind === 'set_field' && e.action.field, 'healthcheckPath')
  })

  test('unbekannt → Meldung, letzte Zeilen, «Mit Claude lösen»', () => {
    const e = load('unbekannt')
    assert.equal(e.kind, 'unknown')
    assert.match(e.cause, /no space left on device/)
    assert.equal(e.action.kind, 'claude')
    assert.ok(e.lines.length > 0)
  })

  test('Abbruch durch Neustart von Airlock → einfach neu deployen', () => {
    const e = explainFailure({ message: 'Abgebrochen durch Neustart von Airlock', log: '', port: 8080 })
    assert.equal(e.kind, 'aborted')
    assert.equal(e.action.kind, 'redeploy')
  })
})

describe('Fehler erklären: Bausteine', () => {
  test('listeningOn erkennt gängige Startmeldungen', () => {
    assert.deepEqual(listeningOn(['Server listening at http://[::]:3000']), { host: '[::]', port: 3000 })
    assert.deepEqual(listeningOn(['INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)']), { host: '0.0.0.0', port: 8000 })
    assert.deepEqual(listeningOn(['Listening on port 4000']), { host: null, port: 4000 })
    assert.deepEqual(listeningOn(['ready - started server on 0.0.0.0:3000, url: http://localhost:3000']), { host: '0.0.0.0', port: 3000 })
    assert.equal(listeningOn(['Datenbank verbunden']), null)
  })

  test('missingEnvVar: keine Treffer bei gewöhnlichen Sätzen', () => {
    assert.equal(missingEnvVar(['Database is required for migrations, skipping']), null)
    assert.equal(missingEnvVar(['DATABASE_URL is not set']), 'DATABASE_URL')
    assert.equal(missingEnvVar(['Environment variable "REDIS_URL" is required']), 'REDIS_URL')
  })

  test('MCP: nächster Schritt in Worten, Auftrag für Claude mit den Zeilen', () => {
    const e = load('port-anders')
    assert.match(nextStep(e), /Port des Projekts in Airlock auf 3000/)
    const prompt = deployFixPrompt({ projectName: 'Wetterstation', slug: 'wetterstation', sourceType: 'files', explanation: e })
    assert.match(prompt, /«Wetterstation» \(wetterstation\) ist gescheitert: App lauscht auf Port 3000/)
    assert.match(prompt, /Server listening at/)
    assert.match(prompt, /update_files/)
  })
})
