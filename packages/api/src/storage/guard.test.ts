import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Nacht 3, Etappe 3: Deploys ab 95 % belegter Platte ablehnen – mit klarer
 * Meldung; darunter und bei unlesbarer Platte nicht sperren.
 */
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
process.env.NODE_ENV = 'test'

const { assertDiskRoom, setDiskReader, diskFullMessage } = await import('./service.js')
const disk = (percent: number) => async () => ({ usedBytes: percent * 1e9, totalBytes: 100e9, percent, level: 'ok' as const })

describe('Deploy-Sperre der Platte', () => {
  after(() => setDiskReader(null))

  test('ab 95 %: abgelehnt mit Meldung, die den Weg nennt', async () => {
    setDiskReader(disk(96))
    await assert.rejects(assertDiskRoom(), (err: Error & { code?: string; status?: number }) => {
      assert.equal(err.code, 'disk_full')
      assert.equal(err.status, 409)
      assert.match(err.message, /zu 96 % belegt/)
      assert.match(err.message, /Server › Speicher/)
      assert.match(err.message, /Rollback/)
      return true
    })
    setDiskReader(disk(95))
    await assert.rejects(assertDiskRoom())
  })

  test('unter 95 % und bei unlesbarer Platte: kein Hindernis', async () => {
    setDiskReader(disk(94))
    await assertDiskRoom()
    setDiskReader(async () => null)
    await assertDiskRoom()
    setDiskReader(async () => { throw new Error('statfs kaputt') })
    await assertDiskRoom()
  })

  test('Meldung', () => {
    assert.match(diskFullMessage(97), /Ab 95 % nimmt Airlock keine Deploys an/)
  })
})
