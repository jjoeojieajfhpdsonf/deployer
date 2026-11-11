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
  // .txt statt .log: *.log steht in .gitignore
  const log = readFileSync(join(dir, `${name}.txt`), 'utf8')
  const message = /FEHLGESCHLAGEN: (.*)$/m.exec(log)?.[1] ?? null
  return explainFailure({ message, log, port: 8080, healthcheckPath: '/health', image: null, memoryLimitMb: 512, envKeys: [], ...extra })
}

describe('Fehler erklären: Muster aus Log und Healthcheck', () => {
  test('fehlende Umgebungsvariable (Node) → «Umgebungsvariable X fehlt» + Hinzufügen', () => {
    const e = load('env-fehlt-node')
    assert.equal(e.kind, 'env_missing')
    assert.equal(e.title, 'Umgebungsvariable DATABASE_URL fehlt')
    assert.deepEqual(e.action, { kind: 'add_env', name: 'DATABASE_URL', exists: false, label: 'DATABASE_URL hinzufügen' })
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
    assert.equal(e.title, 'Umgebungsvariable DATABASE_URL wird nicht akzeptiert')
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

  test('«npm start» stürzt ab: kein npm-Build, sondern die fehlende Variable (Warnung davor zählt nicht)', () => {
    const e = load('npm-start-absturz', { port: 3000 })
    assert.equal(e.kind, 'env_missing')
    assert.equal(e.action.kind === 'add_env' && e.action.name, 'SESSION_SECRET')
  })

  test('irreführende App-Ausgabe: Uhrzeit, Redis-Port, «unauthorized», KeyError ohne environ → HTTP 503', () => {
    const e = load('app-ausgabe-irrefuehrend')
    assert.equal(e.kind, 'health_http_5xx', `bekam ${e.kind}: ${e.title}`)
    assert.equal(e.action.kind, 'claude')
  })

  test('Basis-Image im Dockerfile fehlt → in der Quelle ändern, nicht «Image ändern»', () => {
    const e = load('image-fehlt', { sourceType: 'dockerfile' })
    assert.equal(e.title, 'Basis-Image nicht gefunden')
    assert.equal(e.action.kind, 'claude')
  })

  test('Healthcheck: Verbindung abgelehnt ohne Hinweis im Log → Port ändern (Feld)', () => {
    const log = '[2026-11-10T12:47:02.050Z] Healthcheck nach 60 Versuchen nicht bestanden (connect ECONNREFUSED 172.20.0.5:8080)\n[2026-11-10T12:47:02.130Z] Letzte Container-Ausgabe:\nBereit.'
    const e = explainFailure({ message: 'Healthcheck nicht bestanden', log, port: 8080 })
    assert.equal(e.kind, 'health_refused')
    assert.deepEqual(e.action, { kind: 'set_field', field: 'port', value: null, label: 'Port ändern' })
  })

  test('Exit-Code 137 ohne OOMKilled → beendet, Hinweis auf Speicher', () => {
    const log = '[2026-11-10T12:47:02.050Z] Healthcheck nach 9 Versuchen nicht bestanden (getaddrinfo ENOTFOUND x)\n[2026-11-10T12:47:02.090Z] Container beendet: Exit-Code 137'
    const e = explainFailure({ message: 'Healthcheck nicht bestanden', log, port: 8080 })
    assert.equal(e.kind, 'exited')
    assert.match(e.cause, /Arbeitsspeicher/)
  })

  test('Richtlinie nur über den Fehlercode, nicht über das Wort «policy» in der Meldung', () => {
    const msg = 'Container läuft als root (Richtlinie: kein root)'
    assert.equal(explainFailure({ message: msg, log: '', port: 8080, errorCode: 'policy_violation' }).kind, 'policy')
    assert.notEqual(explainFailure({ message: 'Referrer-Policy fehlt.', log: '', port: 8080 }).kind, 'policy')
  })

  test('Quelle, Port fehlt, doppelter Punkt', () => {
    assert.equal(explainFailure({ message: 'git clone fehlgeschlagen: Repository not found.', log: '', port: 8080 }).kind, 'source')
    assert.ok(!explainFailure({ message: 'git clone fehlgeschlagen: Repository not found.', log: '', port: 8080 }).cause.includes('..'))
    const p = explainFailure({ message: 'Als Webdienst braucht das Projekt einen Port im Container (port setzen)', log: '', port: null })
    assert.equal(p.kind, 'port_missing')
    assert.equal(p.action.kind === 'set_field' && p.action.field, 'port')
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
    // Uhrzeit und Verbindungen zu anderen Diensten sind nicht der eigene Port
    assert.equal(listeningOn(['Server started at 12:30:45']), null)
    assert.equal(listeningOn(['Connected to Redis server at redis:6379']), null)
    // «listen» hat Vorrang vor einer späteren, unklaren Zeile
    assert.deepEqual(listeningOn(['Listening on port 8080', 'Admin server available at 0.0.0.0:9000 for metrics']), { host: null, port: 8080 })
  })

  test('missingEnvVar: keine Treffer bei gewöhnlichen Sätzen, Warnungen und fremden KeyErrors', () => {
    assert.equal(missingEnvVar(['Database is required for migrations, skipping']), null)
    assert.equal(missingEnvVar(['WARN: NODE_ENV is not set, defaulting to development']), null)
    assert.equal(missingEnvVar(["    return STATIONS['ID']", "KeyError: 'ID'"]), null)
    // Der Abbruch unten zählt, nicht eine Warnung weiter oben
    assert.equal(missingEnvVar(['WARN: LOG_LEVEL is not set, using info', 'Error: Missing required environment variable: API_KEY']), 'API_KEY')
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
