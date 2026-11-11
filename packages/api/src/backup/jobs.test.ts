import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatEnvFile, formatJob, isJobId, jobFiles, lastLines, newJobId, parseResult, waitVerdict, GRACE_MS, PICKUP_MS, STALL_MS,
  type WaitState,
} from './jobs.js'
import { abandonJobs, runJob } from './dispatch.js'

const SECRET = 'repo-passwort-geheim' // allowlist-secret: Testwert

describe('Backup-Auftrag: Format', () => {
  test('Auftrag zeilenweise, ein Argument pro Zeile, Zeitlimit in Sekunden', () => {
    const text = formatJob({ op: 'restic', args: ['backup', '--tag', 'airlock', '/staging/db'], timeoutMs: 1500 })
    assert.equal(text, 'v 1\nop restic\ntimeout 2\narg backup\narg --tag\narg airlock\narg /staging/db\n')
  })
  test('Argumente mit Leerzeichen und Shell-Zeichen bleiben ein Argument', () => {
    const text = formatJob({ op: 'restic', args: ['a b', '$(rm -rf /)', "'x'"], timeoutMs: 1000 })
    assert.ok(text.includes('arg a b\n') && text.includes('arg $(rm -rf /)\n'))
  })
  test('Zeilenumbruch in einem Argument wird abgelehnt (wäre eine zweite Angabe)', () => {
    assert.throws(() => formatJob({ op: 'restic', args: ['x\nop pg-dump'], timeoutMs: 1000 }), /Zeilenumbruch/)
    assert.throws(() => formatJob({ op: 'restic', args: ['x\r'], timeoutMs: 1000 }), /Zeilenumbruch/)
  })
  test('ohne Zeitlimit kein Auftrag', () => {
    assert.throws(() => formatJob({ op: 'pg-dump', timeoutMs: 0 }), /Zeitlimit/)
  })
  test('Geheimnisse nur in der Umgebungsdatei, nie im Auftrag', () => {
    const env = { RESTIC_PASSWORD: SECRET, RESTIC_REPOSITORY: '/target/airlock' }
    const job = formatJob({ op: 'restic', args: ['snapshots'], env, timeoutMs: 1000 })
    assert.ok(!job.includes(SECRET))
    assert.equal(formatEnvFile(env), `RESTIC_PASSWORD=${SECRET}\nRESTIC_REPOSITORY=/target/airlock\n`)
  })
  test('Umgebung: nur erlaubte Variablen, keine Zeilenumbrüche', () => {
    assert.throws(() => formatEnvFile({ LD_PRELOAD: '/x.so' }), /nicht erlaubt/)
    assert.throws(() => formatEnvFile({ RESTIC_PASSWORD: 'a\nAWS_ACCESS_KEY_ID=b' }), /Zeilenumbruch/)
    assert.equal(formatEnvFile({}), '')
  })
  test('Kennung: sortierbar, nur a-z, 0-9 und -', () => {
    const a = newJobId(1_000_000, 'ABCDEF012345')
    const b = newJobId(2_000_000, 'abcdef012345')
    assert.ok(isJobId(a) && isJobId(b) && a < b)
    assert.ok(!isJobId('../etc/passwd') && !isJobId('x.job'))
    assert.throws(() => jobFiles('../x'))
  })
})

describe('Backup-Auftrag: Ergebnis', () => {
  test('Exit, Zeitlimit, Abbruch', () => {
    assert.deepEqual(parseResult('exit 0\ntimedout 0\ncancelled 0\n'), { exitCode: 0, timedOut: false, cancelled: false })
    assert.deepEqual(parseResult('exit 143\ntimedout 1\ncancelled 0\n'), { exitCode: 143, timedOut: true, cancelled: false })
  })
  test('ohne Exit unbrauchbar', () => {
    assert.equal(parseResult(''), null)
    assert.equal(parseResult('timedout 0\n'), null)
    assert.equal(parseResult('exit abc\n'), null)
  })
  test('Ausgabe: letzte Zeilen, ohne leere Schlusszeile, ohne \\r', () => {
    assert.deepEqual(lastLines('a\r\nb\nc\n', 2), ['b', 'c'])
    assert.deepEqual(lastLines(''), [])
  })
})

describe('Backup-Auftrag: Warten und Zeitüberschreitung', () => {
  const base: WaitState = { elapsedMs: 0, timeoutMs: 60_000, hasResult: false, pending: true, sinceHeartbeatMs: null }
  test('Ergebnis da: fertig, auch nach dem Zeitlimit', () => {
    assert.equal(waitVerdict({ ...base, hasResult: true, pending: false, elapsedMs: 10 * 60_000 }), 'done')
  })
  test('nicht abgeholt: erst nach der Abholfrist ein Fehler', () => {
    assert.equal(waitVerdict({ ...base, elapsedMs: PICKUP_MS - 1 }), 'wait')
    assert.equal(waitVerdict({ ...base, elapsedMs: PICKUP_MS }), 'not_picked_up')
  })
  test('läuft mit Lebenszeichen: warten bis Zeitlimit plus Nachfrist', () => {
    const run = { ...base, pending: false, sinceHeartbeatMs: 1000 }
    assert.equal(waitVerdict({ ...run, elapsedMs: 60_000 + GRACE_MS - 1 }), 'wait')
    assert.equal(waitVerdict({ ...run, elapsedMs: 60_000 + GRACE_MS }), 'overdue')
  })
  test('kein Lebenszeichen mehr: Container weg', () => {
    assert.equal(waitVerdict({ ...base, pending: false, elapsedMs: 5000, sinceHeartbeatMs: STALL_MS }), 'stalled')
    assert.equal(waitVerdict({ ...base, pending: false, elapsedMs: 5000, sinceHeartbeatMs: STALL_MS - 1 }), 'wait')
  })
})

/* --- Ablauf gegen einen nachgebauten Ausführer (nur Dateisystem) ----------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Holt einen Auftrag ab wie backup/runner.sh und gibt Auftrag und Umgebung zurück */
async function pickUp(dir: string): Promise<{ id: string; job: string; env: string; envMode: number | null }> {
  for (let i = 0; i < 200; i++) {
    const job = (await readdir(dir)).find((n) => n.endsWith('.job'))
    if (job) {
      const id = job.slice(0, -4)
      const f = jobFiles(id)
      const envMode = await stat(join(dir, f.env)).then((s) => s.mode & 0o777, () => null)
      await rename(join(dir, f.job), join(dir, f.run))
      const env = await readFile(join(dir, f.env), 'utf8').catch(() => '')
      await rm(join(dir, f.env), { force: true })
      return { id, job: await readFile(join(dir, f.run), 'utf8'), env, envMode }
    }
    await sleep(5)
  }
  throw new Error('kein Auftrag')
}

async function finish(dir: string, id: string, result: string, out = '', err = ''): Promise<void> {
  const f = jobFiles(id)
  await writeFile(join(dir, f.out), out)
  await writeFile(join(dir, f.err), err)
  await writeFile(join(dir, `${f.result}.tmp`), result)
  await rename(join(dir, `${f.result}.tmp`), join(dir, f.result))
  await rm(join(dir, f.run), { force: true })
}

describe('Backup-Auftrag: Ablauf über das Auftrags-Verzeichnis', () => {
  const fast = { pollMs: 10, limits: { pickupMs: 200, stallMs: 200, graceMs: 100 } }

  test('Auftrag, Geheimnis 0600, Ergebnis lesen, danach alles weg', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airlock-jobs-'))
    try {
      const pending = runJob(dir, { op: 'restic', args: ['snapshots', '--json'], env: { RESTIC_PASSWORD: SECRET }, timeoutMs: 5000 }, fast)
      const got = await pickUp(dir)
      assert.equal(got.envMode, 0o600)
      assert.equal(got.env, `RESTIC_PASSWORD=${SECRET}\n`)
      assert.ok(!got.job.includes(SECRET))
      assert.match(got.job, /^v 1\nop restic\ntimeout 5\narg snapshots\narg --json\n$/)
      await finish(dir, got.id, 'exit 0\ntimedout 0\ncancelled 0\n', '[]\n', 'warnung\n')
      const r = await pending
      assert.deepEqual(r, { exitCode: 0, timedOut: false, stdout: ['[]'], stderr: ['warnung'] })
      assert.deepEqual(await readdir(dir), [])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('Zeitlimit des Ausführers kommt als timedOut zurück', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airlock-jobs-'))
    try {
      const pending = runJob(dir, { op: 'pg-dump', timeoutMs: 1000 }, fast)
      const got = await pickUp(dir)
      assert.equal(got.envMode, null, 'ohne Geheimnisse keine Umgebungsdatei')
      await finish(dir, got.id, 'exit 143\ntimedout 1\ncancelled 0\n')
      const r = await pending
      assert.equal(r.timedOut, true)
      assert.equal(r.exitCode, 143)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('nicht abgeholt: Auftrag und Geheimnis werden zurückgezogen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airlock-jobs-'))
    try {
      await assert.rejects(
        runJob(dir, { op: 'restic', args: ['snapshots'], env: { RESTIC_PASSWORD: SECRET }, timeoutMs: 5000 }, fast),
        /nimmt keine Aufträge an/,
      )
      assert.deepEqual(await readdir(dir), [])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('abgeholt, dann kein Lebenszeichen: Abbruch angefordert, Fehler statt Hängen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airlock-jobs-'))
    try {
      const pending = runJob(dir, { op: 'restic', args: ['check'], timeoutMs: 60_000 }, fast)
      const got = await pickUp(dir)
      const r = await pending
      assert.equal(r.exitCode, -1)
      assert.equal(r.timedOut, false)
      assert.match(r.stderr.join('\n'), /kein Lebenszeichen/)
      assert.ok((await readdir(dir)).includes(`${got.id}.cancel`))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('mit Lebenszeichen, aber über Zeitlimit und Nachfrist: timedOut und Abbruch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airlock-jobs-'))
    try {
      const pending = runJob(dir, { op: 'restic', args: ['check'], timeoutMs: 100 }, { ...fast, limits: { ...fast.limits, stallMs: 10_000 } })
      const got = await pickUp(dir)
      let done = false
      const beat = (async () => {
        for (let t = 1; !done; t++) {
          await utimes(join(dir, `${got.id}.run`), t, t).catch(() => {})
          await sleep(20)
        }
      })()
      const r = await pending
      done = true
      await beat
      assert.equal(r.timedOut, true)
      assert.ok((await readdir(dir)).includes(`${got.id}.cancel`))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('beim Start: laufende abbrechen, offene zurückziehen (samt Geheimnis), Reste löschen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airlock-jobs-'))
    try {
      const running = newJobId(1, 'aaaaaa')
      const open = newJobId(2, 'bbbbbb')
      const old = newJobId(3, 'cccccc')
      await writeFile(join(dir, `${running}.run`), '')
      await writeFile(join(dir, `${open}.job`), '')
      await writeFile(join(dir, `${open}.env`), `RESTIC_PASSWORD=${SECRET}\n`)
      await writeFile(join(dir, `${old}.result`), 'exit 0\n')
      await writeFile(join(dir, `${old}.out`), '')
      assert.equal(await abandonJobs(dir), 2)
      assert.deepEqual((await readdir(dir)).sort(), [`${running}.cancel`, `${running}.run`])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
