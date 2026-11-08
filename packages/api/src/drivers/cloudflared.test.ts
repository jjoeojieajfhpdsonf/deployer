import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'

/** cloudflared: Version aus dem Image-Tag, neueste Version aus der Tag-Liste. */

let mod: typeof import('./cloudflared.js')

before(async () => {
  process.env.DATABASE_URL ??= 'postgres://x@localhost/x'
  process.env.ADMIN_PASSWORD ??= 'x'
  mod = await import('./cloudflared.js')
})

describe('cloudflared-Version', () => {
  test('aus dem festen Tag', () => {
    assert.equal(mod.versionOf('cloudflare/cloudflared:2025.8.1'), '2025.8.1')
    assert.equal(mod.versionOf('cloudflare/cloudflared:latest'), null)
    assert.equal(mod.versionOf(null), null)
  })
  test('neueste Release-Version, ohne latest und Varianten', () => {
    assert.equal(mod.newestVersion(['latest', '2025.8.1', '2025.10.0', '2025.9.12', '2025.11.0-arm64', 'nightly']), '2025.10.0')
    assert.equal(mod.newestVersion(['latest']), null)
  })
  test('Vergleich nach Zahlen, nicht nach Text', () => {
    assert.ok(mod.compareVersions('2025.10.0', '2025.9.9') > 0)
    assert.equal(mod.compareVersions('2025.8.1', '2025.8.1'), 0)
  })
  test('neues Image im selben Repository', () => {
    assert.equal(mod.imageWithVersion('2025.10.0'), 'cloudflare/cloudflared:2025.10.0')
  })
})
