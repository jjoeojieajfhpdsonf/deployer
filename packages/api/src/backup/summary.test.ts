import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BackupStatusDto } from '@airlock/shared'
import { mcpBackupStatus } from './summary.js'

const status = (patch: Partial<BackupStatusDto> = {}): BackupStatusDto => ({
  settings: {
    configured: true, enabled: true,
    target: { kind: 's3', endpoint: 'https://s3.example.com', bucket: 'geheim-bucket', prefix: 'server1', region: 'eu', hasAccessKey: true, hasSecretKey: true },
    hasPassword: true, time: '03:30', timeZone: 'Europe/Zurich', retention: { daily: 7, weekly: 4, monthly: 6 },
    projects: { foto: 'stop' }, repositoryCheckedAt: null, lastCheckAt: null,
  },
  projects: [{ slug: 'foto', name: 'Foto', environment: 'Privat', sourceType: 'compose' }],
  key: { fingerprint: 'a1b2 c3d4 e5f6 0718', savedAt: null, method: null },
  restore: null,
  running: false,
  lastRun: {
    id: 'r1', trigger: 'schedule', actor: 'system', status: 'ok', startedAt: '2026-11-11T02:30:00.000Z', finishedAt: '2026-11-11T02:31:30.000Z',
    durationMs: 90_400, snapshotId: 'abc', bytesNew: 1, bytesTotal: 2, filesNew: 3, error: null, warnings: ['x'],
  },
  lastSuccessAt: '2026-11-11T02:31:30.000Z',
  stale: false,
  nextRunAt: '2026-11-12T02:30:00.000Z',
  runs: [],
  ...patch,
})

test('get_backup_status: letzter Lauf, Alter, Art des Ziels', () => {
  const s = mcpBackupStatus(status(), new Date('2026-11-11T14:31:30.000Z'))
  assert.equal(s.target_kind, 's3')
  assert.equal(s.age_hours, 12)
  assert.equal(s.last_run?.duration_s, 90)
  assert.equal(s.last_run?.warnings, 1)
  assert.equal(s.stale, false)
})

test('get_backup_status: kein Endpoint, kein Bucket, keine Projekte, keine Zugangsdaten', () => {
  const text = JSON.stringify(mcpBackupStatus(status()))
  for (const leak of ['s3.example.com', 'geheim-bucket', 'server1', 'foto', 'hasAccessKey', 'snapshot', 'a1b2', 'fingerprint']) assert.ok(!text.includes(leak), leak)
})

test('get_backup_status: nicht eingerichtet', () => {
  const s = mcpBackupStatus(status({ settings: { ...status().settings, configured: false, target: null }, lastRun: null, lastSuccessAt: null, nextRunAt: null }))
  assert.deepEqual([s.configured, s.target_kind, s.last_run, s.age_hours], [false, null, null, null])
})
