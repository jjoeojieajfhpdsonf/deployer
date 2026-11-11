import { test } from 'node:test'
import assert from 'node:assert/strict'
import { caddyAcceptsCloudflareToken } from './cf-token-format.js'

test('Token-Format wie caddy-dns/cloudflare: altes und neues Format', () => {
  assert.equal(caddyAcceptsCloudflareToken('a'.repeat(40)), true)
  assert.equal(caddyAcceptsCloudflareToken('Ab3d-Ef6h_Ij9kLm2nOp5qRs8tUv1wXy4zAb3dE'), true)
  assert.equal(caddyAcceptsCloudflareToken(`cfut_${'x'.repeat(40)}`), true)
  assert.equal(caddyAcceptsCloudflareToken(`cfat_${'x'.repeat(32)}`), true)
})

test('Token-Format: was Caddy beim Laden ablehnt (und damit alle Basen mitreissen würde)', () => {
  assert.equal(caddyAcceptsCloudflareToken('falsch'), false)
  assert.equal(caddyAcceptsCloudflareToken('a'.repeat(31)), false) // früher von Airlock angenommen (30–200)
  assert.equal(caddyAcceptsCloudflareToken('a'.repeat(51)), false)
  // «cfut_» + 257 Zeichen: zu lang für das neue (bis 256) und für das alte Format (bis 50)
  assert.equal(caddyAcceptsCloudflareToken(`cfut_${'x'.repeat(257)}`), false)
  assert.equal(caddyAcceptsCloudflareToken(`"${'a'.repeat(40)}"`), false)
  assert.equal(caddyAcceptsCloudflareToken(''), false)
  assert.equal(caddyAcceptsCloudflareToken(null), false)
})
