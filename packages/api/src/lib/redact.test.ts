import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets, redactDeep, registerSecret, clearSecrets } from './redact.js'

// Erfundene Werte im Format der echten Tokens
const NEW = 'cfut_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'.repeat(2)
const ACCOUNT = 'cfat_' + 'Zy9xWv8uTs7rQp6oNm5lKj4iHg3fEd2c'
const LEGACY = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zA7bC0dEf' // 40 Zeichen
const TUNNEL = 'eyJhIjoiMTIzNDU2Nzg5MCIsInQiOiJhYmMiLCJzIjoiWFlaIn0='
const CADDY_MSG = (t: string) => `loading new config: provision tls: API token '${t}' appears invalid; ensure it's correctly entered and not wrapped in braces nor quotes`

beforeEach(() => clearSecrets())

describe('redactSecrets: Muster', () => {
  test('neues Format cfut_ in der echten Caddy-Meldung', () => {
    const out = redactSecrets(CADDY_MSG(NEW))
    assert.ok(!out.includes(NEW))
    assert.ok(!out.includes('cfut_'))
    assert.match(out, /API token '\*\*\*' appears invalid/)
  })

  test('cfat_ (Konto-Token)', () => {
    assert.equal(redactSecrets(`token=${ACCOUNT}`), 'token=***')
  })

  test('altes 40-stelliges Format', () => {
    assert.equal(redactSecrets(CADDY_MSG(LEGACY)).includes(LEGACY), false)
  })

  test('cloudflared-Tunnel-Token', () => {
    assert.equal(redactSecrets(`--token ${TUNNEL} failed`), '--token *** failed')
  })

  test('mehrfach in einer Zeile', () => {
    assert.equal(redactSecrets(`${NEW} und ${LEGACY}`), '*** und ***')
  })

  test('Git-Commit, Slug und Hostname bleiben stehen', () => {
    const sha = 'e2491c17a8f3b9d0c4e5f6a7b8c9d0e1f2a3b4c5' // 40 Hex
    const slug = 'mein-sehr-langes-projekt-mit-vierzig-zei' // 40, ohne Ziffern/Grossbuchstaben
    const text = `Commit ${sha}, Projekt ${slug}, Host deployer.home.example.ch, Zone 023e105f4ecef8ad9ca31a8372d0c353`
    assert.equal(redactSecrets(text), text)
  })

  test('eigene MCP-Bestätigungscodes (cfm_) bleiben stehen', () => {
    const text = '{"confirm":"cfm_a4_92BcCxYz0123456789ab"}'
    assert.equal(redactSecrets(text), text)
  })

  test('längere Kennungen werden nicht angeschnitten (41+ Zeichen)', () => {
    const long = LEGACY + 'X'
    assert.equal(redactSecrets(long), long)
  })

  test('leer und null', () => {
    assert.equal(redactSecrets(''), '')
    assert.equal(redactSecrets(null), null)
    assert.equal(redactSecrets(undefined), undefined)
  })
})

describe('redactSecrets: bekannte Werte', () => {
  test('registriertes Token in jedem Format', () => {
    const odd = 'kurz-aber-geheim-123'
    registerSecret(odd)
    assert.equal(redactSecrets(`Fehler mit ${odd}!`), 'Fehler mit ***!')
  })

  test('sehr kurze Werte werden nicht registriert (kein Wort-Schwärzen)', () => {
    registerSecret('abc')
    assert.equal(redactSecrets('abc def'), 'abc def')
  })
})

describe('redactDeep', () => {
  test('verschachtelte Werte', () => {
    const out = redactDeep({ steps: [{ text: CADDY_MSG(NEW), tone: 'bad' }], n: 3, ok: true, x: null })
    assert.deepEqual(out, { steps: [{ text: CADDY_MSG('***'), tone: 'bad' }], n: 3, ok: true, x: null })
  })
})

describe('Logger schwärzt', () => {
  test('log.warn mit Token im Fehler', async () => {
    const { log } = await import('./log.js')
    const lines: string[] = []
    const orig = console.warn
    console.warn = (s: string) => lines.push(s)
    try {
      log.warn('Caddy-Abgleich fehlgeschlagen', { err: CADDY_MSG(NEW) })
    } finally {
      console.warn = orig
    }
    assert.equal(lines.length, 1)
    assert.ok(!lines[0]!.includes(NEW))
    assert.ok(lines[0]!.includes('***'))
  })
})
