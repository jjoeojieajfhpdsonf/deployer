import Docker from 'dockerode'
import type { Readable } from 'node:stream'
import { config } from '../config.js'
import { assertCreatePolicy } from './policy.js'
import { AppError } from '../lib/errors.js'

/**
 * Einziger Ort im Projekt, der dockerode kennt. Jede Container-Erstellung
 * geht durch assertCreatePolicy(). Siehe drivers/policy.ts.
 */

export const LABEL_MANAGED = 'deployer.managed'
export const LABEL_PROJECT = 'deployer.project'
export const LABEL_DEPLOYMENT = 'deployer.deployment'

function dockerFromEnv(): Docker {
  const host = config.DOCKER_HOST
  if (host.startsWith('unix://')) return new Docker({ socketPath: host.slice('unix://'.length) })
  const m = /^tcp:\/\/([^:/]+):(\d+)$/.exec(host)
  if (!m) throw new Error(`DOCKER_HOST "${host}" nicht verstanden (erwartet tcp://host:port oder unix:///pfad)`)
  return new Docker({ host: m[1], port: Number(m[2]), protocol: 'http' })
}

export const docker = dockerFromEnv()

export function projectNetworkName(slug: string): string {
  return `dep_${slug}`
}

export function containerName(slug: string, deploymentId: string): string {
  return `dep_${slug}_${deploymentId.replace(/-/g, '').slice(0, 10)}`
}

export interface ContainerSpec {
  name: string
  image: string
  network: string
  env: Record<string, string>
  labels: Record<string, string>
  memoryLimitMb: number
  cpuLimit: number
  volumes?: { source: string; target: string; readOnly?: boolean }[]
}

/**
 * Baut die Nutzlast aus einem engen eigenen Typ. Es wird nie eine von aussen
 * gelieferte Docker-Struktur durchgereicht; die Pruefung danach ist die
 * Zusicherung gegen kuenftige Codepfade, die hier ein Feld ergaenzen.
 */
export function buildCreateOptions(spec: ContainerSpec): Record<string, unknown> {
  const options: Record<string, unknown> = {
    name: spec.name,
    Image: spec.image,
    Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    Labels: spec.labels,
    HostConfig: {
      NetworkMode: spec.network,
      Memory: Math.round(spec.memoryLimitMb * 1024 * 1024),
      NanoCpus: Math.round(spec.cpuLimit * 1e9),
      RestartPolicy: { Name: 'unless-stopped' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '5' } },
      SecurityOpt: ['no-new-privileges:true'],
      ...(spec.volumes?.length
        ? {
            Mounts: spec.volumes.map((v) => ({
              Type: 'volume',
              Source: v.source,
              Target: v.target,
              ...(v.readOnly ? { ReadOnly: true } : {}),
            })),
          }
        : {}),
    },
  }
  assertCreatePolicy(options, spec.network)
  return options
}

export async function ping(): Promise<void> {
  await docker.ping()
}

export async function version(): Promise<string> {
  const v = (await docker.version()) as { Version?: string }
  return v.Version ?? 'unbekannt'
}

/* --- Images --------------------------------------------------------------- */

export async function pullImage(ref: string, onLine?: (line: string) => void): Promise<void> {
  const stream = (await docker.pull(ref)) as Readable
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => (err ? reject(err) : resolve()),
      (event: { status?: string; progress?: string; id?: string }) => {
        if (!onLine || !event.status) return
        onLine([event.id, event.status, event.progress].filter(Boolean).join(' '))
      },
    )
  })
}

export interface ImageInfo {
  /** repo@sha256:... wenn vorhanden, sonst die Image-ID. */
  digest: string
  /** Benutzer aus dem Image. Leer oder "0"/"root" heisst: laeuft als root. */
  user: string
}

export async function inspectImage(ref: string): Promise<ImageInfo> {
  const info = (await docker.getImage(ref).inspect()) as {
    Id: string
    RepoDigests?: string[]
    Config?: { User?: string }
  }
  return {
    digest: info.RepoDigests?.[0] ?? info.Id,
    user: info.Config?.User ?? '',
  }
}

export function runsAsRoot(user: string): boolean {
  const u = user.split(':')[0]?.trim() ?? ''
  return u === '' || u === '0' || u === 'root'
}

/* --- Netzwerke ------------------------------------------------------------ */

export async function ensureNetwork(name: string): Promise<void> {
  const existing = await docker.listNetworks({ filters: { name: [name] } })
  if (existing.some((n) => n.Name === name)) return
  await docker.createNetwork({ Name: name, Driver: 'bridge', CheckDuplicate: true })
}

export async function removeNetwork(name: string): Promise<void> {
  try {
    await docker.getNetwork(name).remove()
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err
  }
}

/*
 * Verbinden und Trennen sind idempotent. Der Statuscode fuer "schon drin" und
 * "nicht drin" ist ueber Docker-Versionen nicht stabil (Docker 29 antwortet
 * auf "is not connected" mit 500, aeltere mit 403/404). Deshalb wird zuerst
 * die Mitgliedschaft geprueft, und erst danach am Meldungstext abgesichert.
 */

export async function connectToNetwork(network: string, container: string): Promise<void> {
  if ((await networksOfContainer(container)).includes(network)) return
  try {
    // Niedrige Gateway-Prioritaet: ein Projekt-Netz darf nie zum Standard-
    // Gateway von Caddy oder deployer werden. Sonst liefe deren ausgehender
    // Verkehr durch das Projekt-Netz, und beim Trennen risse die
    // Port-Veroeffentlichung von Caddy ab (beobachtet unter Docker 29).
    // Zweite Absicherung zu gw_priority in compose.yaml.
    await docker.getNetwork(network).connect({
      Container: container,
      EndpointConfig: { GwPriority: -100 },
    } as Record<string, unknown>)
  } catch (err) {
    const e = err as { message?: string }
    if (/already exists|already connected/i.test(e.message ?? '')) return
    throw err
  }
}

export async function disconnectFromNetwork(network: string, container: string): Promise<void> {
  if (!(await networksOfContainer(container)).includes(network)) return
  try {
    await docker.getNetwork(network).disconnect({ Container: container, Force: true })
  } catch (err) {
    const e = err as { statusCode?: number; message?: string }
    if (e.statusCode === 404) return
    if (/not connected|no such (network|container)/i.test(e.message ?? '')) return
    throw err
  }
}

/** Netze, in denen ein Container gerade haengt. Fuer den Reconcile. */
export async function networksOfContainer(container: string): Promise<string[]> {
  try {
    const info = (await docker.getContainer(container).inspect()) as {
      NetworkSettings?: { Networks?: Record<string, unknown> }
    }
    return Object.keys(info.NetworkSettings?.Networks ?? {})
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return []
    throw err
  }
}

/* --- Container ------------------------------------------------------------ */

export async function createAndStart(spec: ContainerSpec): Promise<string> {
  const options = buildCreateOptions(spec)
  const container = await docker.createContainer(options as Docker.ContainerCreateOptions)
  await container.start()
  return container.id
}

export async function stopContainer(id: string, timeoutSec = 10): Promise<void> {
  try {
    await docker.getContainer(id).stop({ t: timeoutSec })
  } catch (err) {
    const e = err as { statusCode?: number }
    if (e.statusCode === 404 || e.statusCode === 304) return
    throw err
  }
}

export async function removeContainer(id: string): Promise<void> {
  try {
    await docker.getContainer(id).remove({ force: true, v: false })
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err
  }
}

export async function startContainer(id: string): Promise<void> {
  try {
    await docker.getContainer(id).start()
  } catch (err) {
    const e = err as { statusCode?: number }
    if (e.statusCode === 304) return // laeuft schon
    throw err
  }
}

export interface ContainerState {
  id: string
  name: string
  running: boolean
  exitCode: number | null
  startedAt: string | null
}

export async function inspectContainer(id: string): Promise<ContainerState | null> {
  try {
    const info = (await docker.getContainer(id).inspect()) as {
      Id: string
      Name: string
      State: { Running: boolean; ExitCode: number; StartedAt: string }
    }
    return {
      id: info.Id,
      name: info.Name.replace(/^\//, ''),
      running: info.State.Running,
      exitCode: info.State.Running ? null : info.State.ExitCode,
      startedAt: info.State.StartedAt ?? null,
    }
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null
    throw err
  }
}

/** Alle von deployer verwalteten Container, auch gestoppte. */
export async function listManagedContainers(): Promise<
  { id: string; names: string[]; labels: Record<string, string>; running: boolean }[]
> {
  const list = await docker.listContainers({
    all: true,
    filters: { label: [`${LABEL_MANAGED}=true`] },
  })
  return list.map((c) => ({
    id: c.Id,
    names: c.Names.map((n) => n.replace(/^\//, '')),
    labels: c.Labels ?? {},
    running: c.State === 'running',
  }))
}

/* --- Logs ----------------------------------------------------------------- */

/**
 * Docker multiplext stdout/stderr mit einem 8-Byte-Kopf pro Rahmen, wenn der
 * Container kein TTY hat. Reine Funktion, damit sie testbar bleibt.
 */
export function demuxDockerLog(buf: Buffer): string {
  const out: string[] = []
  let i = 0
  while (i + 8 <= buf.length) {
    const type = buf[i]
    // Ein gueltiger Kopf hat Stream-Typ 0-2 und drei Nullbytes danach.
    if (type !== undefined && type <= 2 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 0) {
      const len = buf.readUInt32BE(i + 4)
      if (i + 8 + len > buf.length) break
      out.push(buf.subarray(i + 8, i + 8 + len).toString('utf8'))
      i += 8 + len
    } else {
      // Kein Multiplexing (TTY): Rest als Klartext.
      return out.join('') + buf.subarray(i).toString('utf8')
    }
  }
  return out.join('')
}

export async function getLogs(
  id: string,
  opts: { tail?: number; since?: number } = {},
): Promise<string> {
  try {
    const buf = (await docker.getContainer(id).logs({
      stdout: true,
      stderr: true,
      tail: opts.tail ?? 200,
      ...(opts.since ? { since: opts.since } : {}),
      timestamps: false,
    })) as unknown as Buffer
    return demuxDockerLog(Buffer.from(buf))
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new AppError('not_found', 'Container nicht gefunden', 404)
    }
    throw err
  }
}

export async function followLogs(id: string, since?: number): Promise<Readable> {
  return (await docker.getContainer(id).logs({
    stdout: true,
    stderr: true,
    follow: true,
    tail: 100,
    ...(since ? { since } : {}),
  })) as unknown as Readable
}
