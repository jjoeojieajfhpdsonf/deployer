import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { validateExternalHostname, txtRecordName, txtMatches, verifyTxt, isPublicAddress, assertPublicTarget, type TxtResolver } from './external.js'
import { redact, renderMessage, mergeMatrix, DEFAULT_MATRIX } from '../notify/render.js'

describe('Externe Ziele: Hostname', () => {
  test('gültige Namen, klein geschrieben', () => {
    assert.equal(validateExternalHostname('Shop.MeineDomain.ch.', null), 'shop.meinedomain.ch')
  })
  for (const bad of ['192.168.1.1', '::1', 'localhost', 'nas.local', 'x.internal', 'a.test', 'foo', '-a.ch', 'a..ch', 'x.192-168-0-1.nip.io', 'shop.example']) {
    test(`abgelehnt: ${bad}`, () => {
      assert.throws(() => validateExternalHostname(bad, null))
    })
  }
  test('nicht unter der internen Basisdomain', () => {
    assert.throws(() => validateExternalHostname('blog.int.meinedomain.ch', 'int.meinedomain.ch'), /internen Basisdomain/)
    assert.equal(validateExternalHostname('blog.meinedomain.ch', 'int.meinedomain.ch'), 'blog.meinedomain.ch')
  })
})

describe('Externe Ziele: TXT-Nachweis', () => {
  const token = 'abc123'
  test('Eintragname und Inhalt', () => {
    assert.equal(txtRecordName('shop.x.ch'), '_airlock-verify.shop.x.ch')
    assert.ok(txtMatches([['airlock-verify=abc', '123']], token), 'TXT in Stücken')
    assert.ok(!txtMatches([['airlock-verify=falsch']], token))
  })

  test('Übergang: Nachweis aus der deployer-Zeit gilt weiter', async () => {
    assert.ok(txtMatches([['deployer-verify=abc123']], token))
    const byName: TxtResolver = async (_s, name) => {
      if (name === '_deployer-verify.shop.x.ch') return [['deployer-verify=abc123']]
      throw Object.assign(new Error('keine Daten'), { code: 'ENODATA' })
    }
    const r = await verifyTxt('shop.x.ch', token, byName)
    assert.equal(r.verified, true)
    assert.deepEqual(r.errors, [])
  })

  const resolver = (answers: Record<string, string[][] | Error>): TxtResolver => async (server) => {
    const a = answers[server]
    if (a instanceof Error) throw a
    return a ?? []
  }
  const ok = [['airlock-verify=abc123']]

  test('zwei von drei Resolvern genügen', async () => {
    const r = await verifyTxt('shop.x.ch', token, resolver({ '1.1.1.1': ok, '8.8.8.8': ok, '9.9.9.9': new Error('ETIMEOUT') }))
    assert.equal(r.verified, true)
    assert.deepEqual(r.confirmedBy, ['1.1.1.1', '8.8.8.8'])
  })
  test('ein einzelner Resolver reicht nicht', async () => {
    const r = await verifyTxt('shop.x.ch', token, resolver({ '1.1.1.1': ok, '8.8.8.8': [], '9.9.9.9': [] }))
    assert.equal(r.verified, false)
  })
  test('falscher Inhalt reicht nicht', async () => {
    const r = await verifyTxt('shop.x.ch', token, resolver({ '1.1.1.1': [['x']], '8.8.8.8': [['x']], '9.9.9.9': [['x']] }))
    assert.equal(r.verified, false)
  })
})

describe('Benachrichtigungen', () => {
  test('Secrets werden entfernt, auch mehrfach und überlappend', () => {
    assert.equal(redact('db=supergeheim und supergeheim2', ['supergeheim', 'supergeheim2']), 'db=*** und ***')
    assert.equal(redact('kurz ab', ['ab']), 'kurz ab', 'zu kurze Werte nicht')
  })
  test('Standard-Kanäle laut SPEC', () => {
    assert.deepEqual(DEFAULT_MATRIX.finding_critical, { push: true, email: true })
    assert.deepEqual(DEFAULT_MATRIX.finding_high, { push: false, email: true })
    assert.deepEqual(DEFAULT_MATRIX.deploy_failed, { push: true, email: false })
  })
  test('gespeicherte Einstellungen überschreiben einzeln, Unsinn wird ignoriert', () => {
    const m = mergeMatrix({ deploy_failed: { push: false }, foo: { push: true }, finding_high: { email: 'ja' } })
    assert.equal(m.deploy_failed.push, false)
    assert.equal(m.finding_high.email, true)
  })
  test('Texte enthalten Titel und Stellen der Befunde', () => {
    const m = renderMessage('finding_critical', { target: 'shop', score: 50, grade: 'C', findings: [{ title: 'Secret im Code', location: 'config.js:1' }] })
    assert.match(m.title, /1 neue kritische Befunde: shop/)
    assert.match(m.body, /Secret im Code \(config\.js:1\)/)
    assert.equal(m.priority, 5)
  })
})

describe('Ziel muss öffentlich sein (Review M6)', () => {
  test('private, Loopback-, CGNAT- und Link-local-Adressen sind nicht öffentlich', () => {
    for (const ip of ['192.168.1.1', '10.0.0.5', '172.20.0.2', '127.0.0.1', '100.100.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.1', '224.0.0.1']) {
      assert.equal(isPublicAddress(ip), false, ip)
    }
    for (const ip of ['1.1.1.1', '185.199.108.153', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      assert.equal(isPublicAddress(ip), true, ip)
    }
    assert.equal(isPublicAddress('kein-ip'), false)
  })

  test('eine einzige private Adresse genügt zur Ablehnung', async () => {
    await assert.rejects(assertPublicTarget('meine.example.com', async () => ['1.1.1.1', '192.168.1.1']), /nicht öffentliche Adresse \(192\.168\.1\.1\)/)
  })

  test('löst nicht auf: abgelehnt', async () => {
    await assert.rejects(assertPublicTarget('weg.example.com', async () => []), /löst nicht auf/)
    await assert.rejects(assertPublicTarget('weg.example.com', async () => { throw new Error('NXDOMAIN') }), /löst nicht auf/)
  })

  test('nur öffentliche Adressen: angenommen', async () => {
    assert.deepEqual(await assertPublicTarget('ok.example.com', async () => ['1.1.1.1']), ['1.1.1.1'])
  })
})
