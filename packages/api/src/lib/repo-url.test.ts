import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { checkRepoUrl, type RepoUrlPolicy } from './repo-url.js'

function policy(map: Record<string, string[]> = {}, deniedCidrs: string[] = []): RepoUrlPolicy {
  return {
    deniedHosts: ['postgres', 'socket-proxy', 'caddy', 'airlock-app', 'airlock-caddy'],
    deniedCidrs,
    resolve: async (h) => map[h] ?? [],
  }
}

async function rejectsWith(url: string, p: RepoUrlPolicy, re: RegExp) {
  await assert.rejects(checkRepoUrl(url, p), (err: Error) => {
    assert.match(err.message, re)
    return true
  })
}

describe('Repo-URL: Schemata', () => {
  test('https ist erlaubt', async () => {
    const r = await checkRepoUrl('https://github.com/x/y.git', policy({ 'github.com': ['140.82.121.4'] }))
    assert.equal(r.host, 'github.com')
    assert.equal(r.port, 443)
    assert.deepEqual(r.addresses, ['140.82.121.4'])
  })

  test('http ist erlaubt (Git-Server im LAN)', async () => {
    const r = await checkRepoUrl('http://gitea.lan:3000/x/y.git', policy({ 'gitea.lan': ['192.168.1.20'] }))
    assert.equal(r.port, 3000)
  })

  for (const url of [
    'file:///etc/passwd',
    'ssh://git@github.com/x/y.git',
    'git://github.com/x/y.git',
    'ext::sh -c touch% /tmp/pwned',
    'ftp://example.com/x.git',
  ]) {
    test(`abgelehnt: ${url}`, async () => {
      await rejectsWith(url, policy(), /Schema|keine gültige URL/)
    })
  }

  test('Zugangsdaten in der URL werden abgelehnt (landen sonst in Logs)', async () => {
    await rejectsWith('https://user:token@github.com/x/y.git', policy({ 'github.com': ['140.82.121.4'] }), /Zugangsdaten/)
  })
})

describe('Repo-URL: keine Ziele im eigenen Stack', () => {
  for (const host of ['postgres', 'socket-proxy', 'caddy', 'airlock-app', 'airlock-caddy']) {
    test(`Dienstname ${host}`, async () => {
      await rejectsWith(`http://${host}:2375/x.git`, policy(), /Airlock-Stacks/)
    })
  }

  test('localhost und *.localhost', async () => {
    await rejectsWith('http://localhost/x.git', policy(), /localhost/)
    await rejectsWith('http://foo.localhost/x.git', policy(), /localhost/)
  })

  test('Loopback als IP-Literal', async () => {
    await rejectsWith('http://127.0.0.1/x.git', policy(), /gesperrte Adresse/)
    await rejectsWith('http://[::1]/x.git', policy(), /gesperrte Adresse/)
  })

  test('Name, der auf Loopback auflöst', async () => {
    await rejectsWith('http://evil.example/x.git', policy({ 'evil.example': ['127.0.0.5'] }), /gesperrte Adresse/)
  })

  test('IPv4 in IPv6-Schreibweise wird erkannt', async () => {
    await rejectsWith('http://evil.example/x.git', policy({ 'evil.example': ['::ffff:127.0.0.1'] }), /gesperrte Adresse/)
  })

  test('Cloud-Metadaten (Link-local)', async () => {
    await rejectsWith('http://169.254.169.254/latest/', policy(), /gesperrte Adresse/)
  })

  test('Adresse in einem Netz des Stacks', async () => {
    const p = policy({ 'sneaky.example': ['172.28.0.3'] }, ['172.28.0.0/16'])
    await rejectsWith('http://sneaky.example/x.git', p, /gesperrte Adresse/)
  })

  test('ein einziger gesperrter Eintrag unter mehreren reicht zur Ablehnung', async () => {
    const p = policy({ 'mixed.example': ['93.184.216.34', '127.0.0.1'] })
    await rejectsWith('http://mixed.example/x.git', p, /gesperrte Adresse/)
  })

  test('nicht auflösbar', async () => {
    await rejectsWith('https://gibts-nicht.example/x.git', policy(), /auflösen/)
  })
})
