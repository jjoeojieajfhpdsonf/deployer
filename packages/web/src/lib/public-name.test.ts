import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { PublicNameCheckDto } from '@airlock/shared'
import { applyNameInput, hostOf, nameFromHost, normalizeWhileTyping, verdictOf } from './public-name.js'

const zones = ['example.ch', 'example.dev']
const cur = { label: '', zone: 'example.ch', apex: false }
const check = (p: Partial<PublicNameCheckDto> = {}): PublicNameCheckDto => ({
  host: 'solar.example.ch', label: 'solar', zone: 'example.ch', apex: false, zones, problems: [], existing: null, ...p,
})
const o = { checking: false, takeOver: false, canTakeOver: true }

describe('Öffentliche Adresse: Eingabe', () => {
  test('beim Tippen normalisiert, Bindestrich am Ende bleibt', () => {
    assert.equal(normalizeWhileTyping('Mein '), 'mein-')
    assert.equal(normalizeWhileTyping('Mein Shop'), 'mein-shop')
    assert.equal(normalizeWhileTyping('Grösse Über'), 'groesse-ueber')
    assert.equal(normalizeWhileTyping('  a__b'), 'a-b')
    assert.equal(normalizeWhileTyping('x'.repeat(80)).length, 63)
  })

  test('eingefügter voller Name wird zerlegt', () => {
    assert.deepEqual(applyNameInput('https://solar.example.dev/pfad', zones, cur), { name: { label: 'solar', zone: 'example.dev', apex: false }, note: null })
    assert.deepEqual(applyNameInput('example.ch', zones, cur).name, { label: '', zone: 'example.ch', apex: true })
  })

  test('voller Name in fremder Domain: Name bleibt, Hinweis nennt die möglichen', () => {
    const r = applyNameInput('solar.andere.ch', zones, cur)
    assert.equal(r.name.label, 'solar')
    assert.equal(r.name.zone, 'example.ch')
    assert.match(r.note ?? '', /andere\.ch ist keine Domain dieser Umgebung \(möglich: example\.ch, example\.dev\)/)
  })

  test('Vorschau und Zerlegen der aktuellen Adresse', () => {
    assert.equal(hostOf({ label: 'Solar-', zone: 'example.ch', apex: false }), 'solar.example.ch')
    assert.equal(hostOf({ label: '', zone: 'example.ch', apex: false }), null)
    assert.equal(hostOf({ label: 'egal', zone: 'example.ch', apex: true }), 'example.ch')
    assert.deepEqual(nameFromHost('shop.example.dev', zones, 'example.ch'), { label: 'shop', zone: 'example.dev', apex: false })
    assert.deepEqual(nameFromHost('x.fremd.ch', zones, 'example.ch'), { label: '', zone: 'example.ch', apex: false })
  })
})

describe('Öffentliche Adresse: Ergebnis der Prüfung', () => {
  test('frei, wird geprüft, aktuelle Adresse', () => {
    assert.deepEqual(verdictOf(check(), o), { verdict: { tone: 'ok', word: 'Frei' }, blocking: false })
    assert.equal(verdictOf(check(), { ...o, checking: true }).verdict.tone, 'checking')
    assert.deepEqual(verdictOf(check(), { ...o, current: 'solar.example.ch' }).verdict, { tone: 'ok', word: 'Aktuelle Adresse' })
  })

  test('vergeben und reserviert halten auf', () => {
    const taken = verdictOf(check({ problems: [{ kind: 'taken', message: 'solar.example.ch ist in Airlock schon vergeben' }] }), o)
    assert.equal(taken.blocking, true)
    assert.deepEqual(taken.verdict, { tone: 'bad', word: 'Vergeben', text: 'solar.example.ch ist in Airlock schon vergeben' })
    assert.equal(verdictOf(check({ problems: [{ kind: 'reserved', message: '«int» ist reserviert' }] }), o).verdict.tone, 'bad')
  })

  test('fremder Eintrag: erst nach «ersetzen» frei; beim Anlegen nicht ersetzbar', () => {
    const c = check({ existing: { type: 'CNAME', content: 'alt.example.net', worker: false }, problems: [{ kind: 'dns', message: 'x' }] })
    assert.deepEqual(verdictOf(c, o), { verdict: { tone: 'warn', word: 'Eintrag vorhanden', text: 'CNAME → alt.example.net, nicht von Airlock' }, blocking: true })
    assert.equal(verdictOf(c, { ...o, takeOver: true }).blocking, false)
    assert.equal(verdictOf(c, { ...o, takeOver: true }).verdict.tone, 'warn')
    assert.equal(verdictOf(c, { ...o, canTakeOver: false }).blocking, true)
  })

  test('Worker bzw. Custom Domain: nie ersetzbar, Hinweis auf Cloudflare', () => {
    const c = check({ existing: { type: 'AAAA', content: '100::', worker: true }, problems: [{ kind: 'dns', message: 'x' }] })
    const v = verdictOf(c, { ...o, takeOver: true })
    assert.equal(v.blocking, true)
    assert.match(v.verdict.tone === 'bad' ? v.verdict.text : '', /Worker oder eine Custom Domain bei Cloudflare – dort entfernen/)
  })

  test('Prüfung nicht möglich: Warnung, hält nicht auf (der Server prüft beim Speichern)', () => {
    assert.deepEqual(verdictOf(null, { ...o, failed: 'Der Airlock-Server antwortet nicht.' }), { verdict: { tone: 'warn', word: 'Nicht geprüft', text: 'Der Airlock-Server antwortet nicht.' }, blocking: false })
  })
})
