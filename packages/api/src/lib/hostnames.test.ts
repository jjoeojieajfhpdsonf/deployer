import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { primaryHost, aliasHosts, nipHost, labelOf, parseBaseDomain, anyReachable, urlFor } from './hostnames.js'

const ip = '192.168.0.63'

describe('Adressen ohne Basisdomain', () => {
  const s = { baseDomain: null, lanIp: ip, nipio: true }

  test('die primäre Adresse ist der nip.io-Name, nicht ein Platzhalter', () => {
    assert.equal(primaryHost('whoami', s), 'whoami.192-168-0-63.nip.io')
  })

  test('kein doppelter Alias', () => {
    assert.deepEqual(aliasHosts('whoami', s), [])
  })
})

describe('Adressen mit Basisdomain', () => {
  const s = { baseDomain: 'int.meinedomain.ch', lanIp: ip, nipio: true }

  test('primär ist der interne Name', () => {
    assert.equal(primaryHost('whoami', s), 'whoami.int.meinedomain.ch')
  })

  test('nip.io bleibt als Rückfall-Alias', () => {
    assert.deepEqual(aliasHosts('whoami', s), ['whoami.192-168-0-63.nip.io'])
  })

  test('ohne LAN-IP gibt es keinen Alias', () => {
    assert.deepEqual(aliasHosts('whoami', { ...s, lanIp: null }), [])
  })
})

describe('weder Basisdomain noch LAN-IP', () => {
  const s = { baseDomain: null, lanIp: null, nipio: true }

  test('reservierte .invalid-Adresse statt einer, die echt aussieht', () => {
    assert.equal(primaryHost('whoami', s), 'whoami.int.invalid')
    assert.equal(anyReachable(s), false)
  })

  test('nip.io abgeschaltet zählt wie fehlende IP', () => {
    assert.equal(nipHost('whoami', { baseDomain: null, lanIp: ip, nipio: false }), null)
  })
})

describe('Hilfen', () => {
  test('labelOf nimmt alles vor dem ersten Punkt', () => {
    assert.equal(labelOf('whoami.int.example.ch'), 'whoami')
    assert.equal(labelOf('whoami.192-168-0-63.nip.io'), 'whoami')
    assert.equal(labelOf('tailnet-whoami.int.x.ch'), 'tailnet-whoami')
  })

  test('parseBaseDomain: leer heisst nicht gesetzt', () => {
    assert.equal(parseBaseDomain(''), null)
    assert.equal(parseBaseDomain('   '), null)
    assert.equal(parseBaseDomain(undefined), null)
    assert.equal(parseBaseDomain('.Int.MeineDomain.ch.'), 'int.meinedomain.ch')
  })
})

describe('urlFor (M4)', () => {
  const s = { baseDomain: 'int.example.ch', lanIp: '192.168.1.10', nipio: true }
  test('ohne TLS immer http', () => {
    assert.equal(urlFor('solar.int.example.ch', s), 'http://solar.int.example.ch')
  })
  test('mit TLS: https unter der Basisdomain, http für nip.io', () => {
    const t = { ...s, tls: true }
    assert.equal(urlFor('solar.int.example.ch', t), 'https://solar.int.example.ch')
    assert.equal(urlFor('solar.192-168-1-10.nip.io', t), 'http://solar.192-168-1-10.nip.io')
  })
  test('zweite Ebene liegt nicht im Wildcard-Zertifikat: http', () => {
    assert.equal(urlFor('a.b.int.example.ch', { ...s, tls: true }), 'http://a.b.int.example.ch')
  })
  test('TLS ohne Basisdomain: http', () => {
    assert.equal(urlFor('solar.192-168-1-10.nip.io', { baseDomain: null, lanIp: '192.168.1.10', nipio: true, tls: true }), 'http://solar.192-168-1-10.nip.io')
  })
})
