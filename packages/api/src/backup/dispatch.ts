import { randomBytes } from 'node:crypto'
import { open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '../lib/errors.js'
import {
  formatEnvFile, formatJob, isJobId, jobFiles, lastLines, newJobId, parseResult, waitVerdict,
  type JobResult, type JobSpec, type WaitLimits,
} from './jobs.js'

/**
 * Meilenstein Backup: Aufträge in das Auftrags-Volume legen und auf das
 * Ergebnis des Ausführers im Backup-Container warten (Format und Regeln in
 * backup/jobs.ts, Gegenseite backup/runner.sh).
 *
 * Reihenfolge beim Anlegen: zuerst <id>.env (0600, nur wenn es Geheimnisse
 * gibt), dann <id>.job per rename – der Ausführer sieht den Auftrag erst,
 * wenn beides vollständig ist.
 */

const POLL_MS = 500
/** Ausgabe höchstens so viel vom Ende lesen (restic --json schreibt Statuszeilen) */
const MAX_READ = 4 * 1024 * 1024

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const exists = (p: string) => stat(p).then(() => true, () => false)
const rmQuiet = (p: string) => unlink(p).catch(() => {})

async function readTail(path: string): Promise<string> {
  const fh = await open(path, 'r').catch(() => null)
  if (!fh) return ''
  try {
    const { size } = await fh.stat()
    const len = Math.min(size, MAX_READ)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

export interface DispatchOptions {
  /** Taktung beim Warten (Tests) */
  pollMs?: number
  maxLines?: number
  /** Fristen fürs Abholen, das Lebenszeichen und die Nachfrist (Tests) */
  limits?: WaitLimits
}

/**
 * Einen Auftrag ausführen lassen und auf das Ergebnis warten. Beim
 * Zeitlimit bricht der Ausführer den Befehl selbst ab; kommt danach nichts
 * mehr, legt Airlock <id>.cancel hin und meldet timedOut.
 */
export async function runJob(dir: string, spec: JobSpec, o: DispatchOptions = {}): Promise<JobResult> {
  const id = newJobId(Date.now(), randomBytes(6).toString('hex'))
  const f = jobFiles(id)
  const p = (name: string) => join(dir, name)
  const jobText = formatJob(spec)
  const envText = formatEnvFile(spec.env ?? {})
  const maxLines = o.maxLines ?? 400

  if (envText) await writeFile(p(f.env), envText, { mode: 0o600, flag: 'wx' })
  try {
    await writeFile(p(f.jobTmp), jobText, { mode: 0o600, flag: 'wx' })
    await rename(p(f.jobTmp), p(f.job))
  } catch (err) {
    await Promise.all([rmQuiet(p(f.env)), rmQuiet(p(f.jobTmp))])
    throw new AppError('backup_jobs', `Auftrag an den Backup-Container nicht geschrieben (${dir}): ${(err as Error).message}`, 503)
  }

  const started = Date.now()
  let lastMtime: number | null = null
  let lastChangeAt: number | null = null
  for (;;) {
    await sleep(o.pollMs ?? POLL_MS)
    const hasResult = await exists(p(f.result))
    const pending = !hasResult && (await exists(p(f.job)))
    if (!hasResult && !pending) {
      const m = await stat(p(f.run)).then((s) => s.mtimeMs, () => null)
      if (lastChangeAt === null || (m !== null && m !== lastMtime)) {
        lastMtime = m
        lastChangeAt = Date.now()
      }
    }
    const verdict = waitVerdict({
      elapsedMs: Date.now() - started,
      timeoutMs: spec.timeoutMs,
      hasResult,
      pending,
      sinceHeartbeatMs: lastChangeAt === null ? null : Date.now() - lastChangeAt,
    }, o.limits)
    if (verdict === 'wait') continue

    if (verdict === 'not_picked_up') {
      // Zurückziehen; schlägt das fehl, hat der Ausführer ihn gerade abgeholt
      const withdrawn = await unlink(p(f.job)).then(() => true, () => false)
      if (!withdrawn) continue
      await rmQuiet(p(f.env))
      throw new AppError(
        'backup_container',
        'Der Backup-Container nimmt keine Aufträge an (läuft er?). Auf dem Server: «docker compose up -d backup» im Ordner von Airlock.',
        503,
      )
    }

    if (verdict === 'done') {
      const parsed = parseResult(await readFile(p(f.result), 'utf8').catch(() => ''))
      // Ergebnis per rename geschrieben: unvollständig heisst kaputt, nicht «noch nicht fertig»
      const [out, err] = await Promise.all([readTail(p(f.out)), readTail(p(f.err))])
      await cleanup(dir, id)
      if (!parsed) return { exitCode: -1, timedOut: false, stdout: lastLines(out, maxLines), stderr: [...lastLines(err, maxLines), 'Ergebnis des Backup-Containers unlesbar'] }
      return { exitCode: parsed.exitCode, timedOut: parsed.timedOut, stdout: lastLines(out, maxLines), stderr: lastLines(err, maxLines) }
    }

    // stalled / overdue: abbrechen lassen und aufgeben; die Reste räumt der Ausführer weg
    await writeFile(p(f.cancel), '').catch(() => {})
    const [out, err] = await Promise.all([readTail(p(f.out)), readTail(p(f.err))])
    if (verdict === 'overdue') return { exitCode: -1, timedOut: true, stdout: lastLines(out, maxLines), stderr: lastLines(err, maxLines) }
    return {
      exitCode: -1, timedOut: false, stdout: lastLines(out, maxLines),
      stderr: [...lastLines(err, maxLines), 'Der Backup-Container gibt kein Lebenszeichen mehr (neu gestartet?)'],
    }
  }
}

/** Alle Dateien eines Auftrags löschen */
async function cleanup(dir: string, id: string): Promise<void> {
  const f = jobFiles(id)
  await Promise.all(Object.values(f).map((n) => rmQuiet(join(dir, n))))
}

/**
 * Beim Start von Airlock: laufende Aufträge eines früheren Prozesses
 * abbrechen lassen, nicht abgeholte zurückziehen (samt Geheimnissen),
 * fertige Reste löschen. Gibt die Zahl der abgebrochenen bzw.
 * zurückgezogenen Aufträge zurück.
 */
export async function abandonJobs(dir: string): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[])
  const ids = new Set<string>()
  for (const n of names) {
    const id = n.split('.')[0] ?? ''
    if (isJobId(id)) ids.add(id)
  }
  let n = 0
  for (const id of ids) {
    const f = jobFiles(id)
    if (await exists(join(dir, f.run))) {
      await writeFile(join(dir, f.cancel), '').catch(() => {})
      n++
    } else {
      if (await exists(join(dir, f.job))) n++
      await cleanup(dir, id)
    }
  }
  return n
}
