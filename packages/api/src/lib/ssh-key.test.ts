import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { generateDeployKey, fingerprintOfPublicKey, parseHostKeys, knownHostsFor, hostAlias } from './ssh-key.js'

/** Nacht 3, Etappe 2: Deploy-Keys im OpenSSH-Format, ohne Bibliothek */

const hasKeygen = (() => {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' })
    return true
  } catch (err) {
    // ssh-keygen -? endet mit Code 1, ist aber da
    return (err as { status?: number }).status !== undefined && (err as { code?: string }).code !== 'ENOENT'
  }
})()

describe('Deploy-Key (ed25519)', () => {
  test('ssh-keygen liest den privaten Schlüssel und leitet denselben öffentlichen ab', { skip: hasKeygen ? false : 'ssh-keygen fehlt' }, () => {
    const k = generateDeployKey('airlock-test')
    const dir = mkdtempSync(join(tmpdir(), 'airlock-key-'))
    try {
      const file = join(dir, 'id')
      writeFileSync(file, k.privateKey, { mode: 0o600 })
      const pub = execFileSync('ssh-keygen', ['-y', '-f', file], { encoding: 'utf8' }).trim()
      assert.equal(pub.split(' ').slice(0, 2).join(' '), k.publicKey.split(' ').slice(0, 2).join(' '))
      const fp = execFileSync('ssh-keygen', ['-l', '-f', file], { encoding: 'utf8' })
      assert.match(fp, new RegExp(k.fingerprint.replace(/[+/]/g, '\\$&')))
      assert.match(fp, /ED25519/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Format: OpenSSH-Kopf, Fingerabdruck wie ssh-keygen', () => {
    const k = generateDeployKey('x')
    assert.match(k.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END OPENSSH PRIVATE KEY-----\n$/) // allowlist-secret (nur das Format, kein Schlüssel)
    assert.equal(fingerprintOfPublicKey(k.publicKey), k.fingerprint)
    assert.match(k.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/)
  })
})

describe('Server-Schlüssel (known_hosts)', () => {
  // Öffentlicher ed25519-Schlüssel (nur Testdaten)
  const ED = 'AAAAC3NzaC1lZDI1NTE5AAAAIL4YROAWh8lwT3fJvYpHN6lQTfVsfMne6rBWf10pmrsA'

  test('ssh-keyscan-Ausgabe lesen: Kommentare, fremde Typen, Typ-Fälschung und Doppelte fallen weg', () => {
    const keys = parseHostKeys([
      '# 1.2.3.4:22 SSH-2.0-OpenSSH_9.6',
      `1.2.3.4 ssh-ed25519 ${ED}`,
      `1.2.3.4 ssh-ed25519 ${ED}`,
      `1.2.3.4 ssh-rsa ${ED}`, // Typ passt nicht zum Inhalt
      '1.2.3.4 ssh-dss AAAAB3NzaC1kc3M=',
      'kaputt',
    ].join('\n'))
    assert.equal(keys.length, 1)
    assert.equal(keys[0]!.type, 'ssh-ed25519')
    assert.equal(keys[0]!.fingerprint, 'SHA256:1I/Wlmie4RkkJ2wFkgP8SQQ5NZgpcIr1MhEI7UeCyr0')
  })

  test('known_hosts unter dem Namen (HostKeyAlias), Port ≠ 22 in Klammern', () => {
    const keys = parseHostKeys(`x ssh-ed25519 ${ED}`)
    assert.equal(knownHostsFor('gitlab.com', keys), `gitlab.com ssh-ed25519 ${ED}\n`)
    assert.equal(hostAlias('gitlab.com', 22), 'gitlab.com')
    assert.equal(hostAlias('gitea.lan', 2222), '[gitea.lan]:2222')
    assert.throws(() => knownHostsFor('a b', keys))
    // Gespeicherte Zeilen lassen sich wieder lesen
    assert.equal(parseHostKeys(knownHostsFor('[gitea.lan]:2222', keys))[0]!.fingerprint, keys[0]!.fingerprint)
  })
})
