import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { BASE, env } from './lib.js'

/**
 * Konto: Passwort ändern. Ändert das echte Passwort des lokalen Stacks und
 * setzt es am Ende in jedem Fall zurück (finally).
 */

async function loginWith(password: string): Promise<string | null> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
  if (!res.ok) return null
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? null
}

async function me(cookie: string) {
  const r = await fetch(`${BASE}/api/v1/auth/me`, { headers: { cookie } })
  return r.json() as Promise<{ loggedIn: boolean; name?: string; passwordSource?: string }>
}

async function change(cookie: string, current: string, next: string) {
  const r = await fetch(`${BASE}/api/v1/auth/password`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ current, next }) })
  return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '', data: await r.json().catch(() => ({})) }
}

describe('Konto: Passwort ändern', () => {
  test('ändern, alte Sitzungen abgemeldet, eigene bleibt; zurücksetzen', async () => {
    const original = env.ADMIN_PASSWORD
    const neu = 'e2e-neues-passwort-' + Date.now()
    const a = (await loginWith(original))!
    const b = (await loginWith(original))!
    assert.ok(a && b)
    assert.equal((await me(a)).loggedIn, true)

    // Prüfungen: falsches bisheriges, zu kurz, ohne Anmeldung
    assert.equal((await change(a, 'falsch', neu)).status, 400)
    assert.equal((await change(a, original, 'kurz')).status, 400)
    const anon = await fetch(`${BASE}/api/v1/auth/password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current: original, next: neu }) })
    assert.equal(anon.status, 401)

    let current = original
    let session = a
    try {
      const r = await change(a, original, neu)
      assert.equal(r.status, 200, JSON.stringify(r.data))
      current = neu
      session = r.cookie
      assert.equal((await me(r.cookie)).loggedIn, true, 'eigene Sitzung bleibt (neues Cookie)')
      assert.equal((await me(b)).loggedIn, false, 'andere Sitzung abgemeldet')
      assert.equal(await loginWith(original), null, 'altes Passwort gilt nicht mehr')
      assert.ok(await loginWith(neu))
      assert.equal((await me(r.cookie)).passwordSource, 'ui')
    } finally {
      if (current !== original) {
        const back = await change(session, current, original)
        assert.equal(back.status, 200, 'Zurücksetzen fehlgeschlagen – Passwort ist jetzt: siehe Test')
      }
    }
    assert.ok(await loginWith(original), 'ursprüngliches Passwort gilt wieder')
  })
})
