import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pruneTraffic, retentionCutoff } from './retention.js'
import type { TrafficStore } from './store.js'
import type { TrafficCount } from './aggregate.js'

describe('Besucher: Löschfrist 13 Monate', () => {
  test('Grenze: gleiche Stunde, 13 Kalendermonate zurück', () => {
    assert.equal(new Date(retentionCutoff(Date.parse('2026-11-11T14:30:00Z'))).toISOString(), '2025-10-11T14:00:00.000Z')
  })

  test('Monatsende: 31. März − 13 Monate = 28. Februar', () => {
    assert.equal(new Date(retentionCutoff(Date.parse('2027-03-31T08:10:00Z'))).toISOString(), '2026-02-28T08:00:00.000Z')
  })

  test('der Job löscht alles vor der Grenze und nichts danach', async () => {
    const now = Date.parse('2026-11-11T14:30:00Z')
    const h = (iso: string): TrafficCount => ({
      projectId: 'p1', hour: Date.parse(iso), way: 'public', path: '/', country: '', city: '', referrer: '', device: 'desktop', status: 200, bot: false, views: 1, visitors: 1,
    })
    let rows = [h('2025-09-30T10:00:00Z'), h('2025-10-11T13:00:00Z'), h('2025-10-11T14:00:00Z'), h('2026-11-11T14:00:00Z')]
    let asked: number | null = null
    const store: Pick<TrafficStore, 'deleteBefore'> = {
      async deleteBefore(cutoff) {
        asked = cutoff
        const before = rows.length
        rows = rows.filter((r) => r.hour >= cutoff)
        return before - rows.length
      },
    }
    const n = await pruneTraffic(store as TrafficStore, now)
    assert.equal(n, 2)
    assert.equal(new Date(asked!).toISOString(), '2025-10-11T14:00:00.000Z')
    assert.deepEqual(rows.map((r) => new Date(r.hour).toISOString()), ['2025-10-11T14:00:00.000Z', '2026-11-11T14:00:00.000Z'])
  })
})
