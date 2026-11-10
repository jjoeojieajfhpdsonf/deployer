import tarStream from 'tar-stream'
import type { Readable } from 'node:stream'
import * as docker from '../drivers/docker.js'
import { AppError } from '../lib/errors.js'
import { log } from '../lib/log.js'
import { StageTimeout } from './progress.js'

/**
 * Startet einen Scanner als Wegwerf-Container – über die Erlaubnisliste wie
 * jeder andere Container, ohne Docker-Socket, ohne Bind-Mount. Eingaben per
 * PUT /archive, der Bericht per GET /archive.
 */

export const SCANNER_IMAGES = {
  trivy: 'aquasec/trivy:0.58.1',
  zap: 'zaproxy/zap-stable:2.16.0',
  nuclei: 'projectdiscovery/nuclei:v3.3.8',
  testssl: 'drwetter/testssl.sh:3.2',
  // Wie Caddy im Stack: liefert auch Punktdateien (.env) aus. busybox httpd
  // verweigert sie – der Scan übersähe genau das, was Caddy ausliefert.
  httpd: 'caddy:2-alpine',
  // CSP-Fix: Funktionsprüfung einer scharfen CSP im Headless-Browser
  chrome: 'zenika/alpine-chrome:124',
} as const

/** Caches der Scanner (Trivy-Datenbank, Nuclei-Vorlagen), über Scans hinweg. */
export const SCANNER_CACHES = {
  trivy: 'deployer_scan-trivy',
  nuclei: 'deployer_scan-nuclei',
} as const

const MAX_REPORT_BYTES = 50 * 1024 * 1024
const LOG_POLL_MS = 2_500

export interface ScannerRun {
  name: string
  image: string
  network: string
  cmd: string[]
  entrypoint?: string[]
  env?: Record<string, string>
  user?: string
  inputs?: { tar: Readable; path: string }[]
  /** Datei im Container, die nach dem Lauf als Bericht geholt wird. */
  reportPath?: string
  cache?: { volume: string; target: string }
  /** Nur lesend eingehängte Volumes (z.B. die statischen Seiten). */
  readOnlyVolumes?: { volume: string; target: string }[]
  labels: Record<string, string>
  timeoutMs: number
  memoryMb?: number
  /** Live-Ausgabe: wird alle paar Sekunden mit den letzten Logzeilen gerufen. */
  onLogs?: (text: string) => void
}

export interface ScannerResult {
  exitCode: number
  timedOut: boolean
  report: Buffer | null
  logs: string
}

export async function ensureImage(ref: string): Promise<void> {
  if (!(await docker.imageExists(ref))) await docker.pullImage(ref)
}

export async function runScanner(o: ScannerRun): Promise<ScannerResult> {
  await ensureImage(o.image)
  if (o.cache) await docker.ensureVolume(o.cache.volume)

  const volumes = [
    ...(o.cache ? [{ source: o.cache.volume, target: o.cache.target }] : []),
    ...(o.readOnlyVolumes ?? []).map((v) => ({ source: v.volume, target: v.target, readOnly: true })),
  ]
  const id = await docker.createOnly({
    name: o.name,
    image: o.image,
    network: o.network,
    env: o.env ?? {},
    labels: { [docker.LABEL_MANAGED]: 'true', 'deployer.role': 'scanner', ...o.labels },
    memoryLimitMb: o.memoryMb ?? 1024,
    cpuLimit: 2,
    oneShot: true,
    cmd: o.cmd,
    ...(o.entrypoint ? { entrypoint: o.entrypoint } : {}),
    ...(o.user ? { user: o.user } : {}),
    volumes,
    extraVolumes: [
      ...(o.cache ? [{ name: o.cache.volume }] : []),
      ...(o.readOnlyVolumes ?? []).map((v) => ({ name: v.volume, readOnly: true })),
    ],
  })

  try {
    for (const input of o.inputs ?? []) await docker.putArchive(id, input.tar, input.path)
    await docker.startById(id)
    let poll: NodeJS.Timeout | undefined
    if (o.onLogs) {
      const onLogs = o.onLogs
      poll = setInterval(() => {
        void docker.getLogs(id, { tail: 40 }).then(onLogs, () => {})
      }, LOG_POLL_MS)
    }
    let r: { exitCode: number; timedOut: boolean }
    try {
      r = await docker.waitForExit(id, o.timeoutMs)
    } finally {
      clearInterval(poll)
    }
    const logs = await docker.getLogs(id, { tail: 80 }).catch(() => '')
    o.onLogs?.(logs)
    // Klare Meldung statt «kein Bericht»: das Zeitlimit hat die Stufe beendet.
    if (r.timedOut) throw new StageTimeout(o.timeoutMs)
    let report: Buffer | null = null
    if (o.reportPath) {
      report = await readFileFromContainer(id, o.reportPath).catch((err) => {
        log.warn('Scanner-Bericht nicht lesbar', { scanner: o.name, err: String(err) })
        return null
      })
    }
    return { exitCode: r.exitCode, timedOut: r.timedOut, report, logs }
  } finally {
    await docker.removeContainer(id)
  }
}

/** Erste Datei aus dem Tar von GET /archive, mit Grössengrenze. */
async function readFileFromContainer(id: string, path: string): Promise<Buffer | null> {
  const tar = await docker.getArchive(id, path).catch((err) => {
    if ((err as { statusCode?: number }).statusCode === 404) return null
    throw err
  })
  if (!tar) return null
  const extract = tarStream.extract()
  const chunks: Buffer[] = []
  let size = 0
  let got = false
  await new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      if (got || header.type !== 'file') {
        stream.resume()
        stream.on('end', next)
        return
      }
      got = true
      stream.on('data', (chunk: unknown) => {
        const c = chunk as Buffer
        size += c.length
        if (size > MAX_REPORT_BYTES) {
          extract.destroy(new AppError('report_too_large', 'Scanner-Bericht zu gross', 500))
          return
        }
        chunks.push(c)
      })
      stream.on('end', next)
    })
    extract.on('finish', () => resolve())
    extract.on('error', reject)
    tar.pipe(extract)
  })
  return got ? Buffer.concat(chunks) : null
}

/** Ein einzelner Eintrag als Tar (z.B. das exportierte Image für Trivy). */
export function singleFileTar(name: string, size: number, content: Readable): Readable {
  const pack = tarStream.pack()
  const entry = pack.entry({ name, size, mode: 0o644 }, (err) => {
    if (err) pack.destroy(err)
    else pack.finalize()
  })
  content.pipe(entry)
  return pack as unknown as Readable
}
