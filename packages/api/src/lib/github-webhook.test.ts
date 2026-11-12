import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { verifyWebhookSignature, signWebhook } from './github-webhook.js'

/**
 * Etappe 6: Signatur von GitHub-Webhooks (X-Hub-Signature-256). Ohne
 * Endpunkt – Airlock ist nie öffentlich; die Prüfung liegt für einen
 * späteren Weg bereit (siehe github-webhook.ts).
 */
describe('Webhook-Signatur', () => {
  const secret = 'testgeheimnis-nur-fuer-tests' // allowlist-secret
  const body = '{"action":"opened","number":7}'

  test('Beispiel aus der GitHub-Dokumentation', () => {
    // docs.github.com «Validating webhook deliveries»: secret «It's a Secret to Everybody», payload «Hello, World!»
    const sig = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17' // allowlist-secret
    assert.equal(verifyWebhookSignature("It's a Secret to Everybody", 'Hello, World!', sig), true) // allowlist-secret
  })

  test('richtige Signatur über die rohen Bytes', () => {
    assert.equal(verifyWebhookSignature(secret, body, signWebhook(secret, body)), true)
    assert.equal(verifyWebhookSignature(secret, Buffer.from(body), signWebhook(secret, body)), true)
    // Gross geschriebenes Hex ist dieselbe Signatur
    assert.equal(verifyWebhookSignature(secret, body, signWebhook(secret, body).replace(/[a-f]/g, (c) => c.toUpperCase()).replace('SHA256', 'sha256')), true)
  })

  test('geänderter Body, falsches Secret, neu serialisiertes JSON: ungültig', () => {
    const sig = signWebhook(secret, body)
    assert.equal(verifyWebhookSignature(secret, `${body} `, sig), false)
    assert.equal(verifyWebhookSignature('anderes', body, sig), false)
    assert.equal(verifyWebhookSignature(secret, JSON.stringify(JSON.parse(body), null, 2), sig), false)
  })

  test('fehlend, leer, falsches Format oder alter SHA-1-Header: ungültig', () => {
    const sha1 = `sha1=${createHmac('sha1', secret).update(body).digest('hex')}`
    for (const h of [undefined, null, '', 'sha256=', 'sha256=zz', sha1, `sha256=${'0'.repeat(63)}`, `sha512=${'0'.repeat(64)}`]) {
      assert.equal(verifyWebhookSignature(secret, body, h as string | null | undefined), false, String(h))
    }
  })

  test('ohne Secret nie gültig', () => {
    assert.equal(verifyWebhookSignature('', body, signWebhook('', body)), false)
    assert.equal(verifyWebhookSignature(null, body, signWebhook('x', body)), false)
  })
})
