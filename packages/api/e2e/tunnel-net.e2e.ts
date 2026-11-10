import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

/**
 * Abnahme Netz «tunnel»: Aus dem cloudflared-Container (sein eigener
 * Netz-Namensraum, `--network container:`) ist Caddy erreichbar, der
 * Airlock nicht – weder über den Namen noch über seine Adressen.
 *
 * Voraussetzung: cloudflared läuft (System → Cloudflare verbinden, oder mit
 * der Attrappe, siehe docs/CLOUDFLARE.md «Prüfung»). Sonst übersprungen.
 */

const CURL = 'curlimages/curl:8.10.1'
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** HTTP-Status aus Sicht von cloudflared, oder «000», wenn keine Verbindung zustande kommt. */
function fromCloudflared(url: string): string {
  try {
    return docker('run', '--rm', '--network', 'container:airlock-cloudflared', CURL, '-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '4', url)
  } catch (err) {
    return ((err as { stdout?: string }).stdout ?? '').trim() || '000'
  }
}

let running = false
let airlockIps: string[] = []

before(() => {
  try {
    running = docker('inspect', '-f', '{{.State.Running}} {{.State.Restarting}}', 'airlock-cloudflared') === 'true false'
  } catch {
    running = false
  }
  if (running) docker('pull', '-q', CURL)
  airlockIps = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', 'airlock-app').split(/\s+/).filter(Boolean)
})

describe('Netz tunnel', { skip: false }, () => {
  test('cloudflared hängt nur im Netz airlock_tunnel', (t) => {
    if (!running) return t.skip('cloudflared läuft nicht')
    const nets = docker('inspect', '-f', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}', 'airlock-cloudflared').split(/\s+/).filter(Boolean)
    assert.deepEqual(nets, ['airlock_tunnel'])
  })

  test('Caddy ist erreichbar (http://caddy:80)', (t) => {
    if (!running) return t.skip('cloudflared läuft nicht')
    const code = fromCloudflared('http://caddy:80/')
    assert.notEqual(code, '000', 'keine Verbindung zu Caddy')
  })

  test('Airlock-Port ist nicht erreichbar: weder Name noch Adressen', (t) => {
    if (!running) return t.skip('cloudflared läuft nicht')
    assert.equal(fromCloudflared('http://airlock-app:3000/health'), '000')
    assert.equal(fromCloudflared('http://airlock:3000/health'), '000')
    assert.ok(airlockIps.length > 0)
    for (const ip of airlockIps) assert.equal(fromCloudflared(`http://${ip}:3000/health`), '000', `Airlock über ${ip} erreichbar`)
  })
})
