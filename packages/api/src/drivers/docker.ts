import Docker from 'dockerode'
import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { config } from '../config.js'
import { assertCreatePolicy } from './policy.js'
import { AppError } from '../lib/errors.js'
import { LABEL, LEGACY_LABEL_NS, projectNetwork, legacyProjectNetwork, PROJECT_PREFIX, LEGACY_PROJECT_PREFIX, normalizeLabels } from '../lib/names.js'

/**
 * Einziger Ort im Projekt, der dockerode kennt. Jede Container-Erstellung
 * geht durch assertCreatePolicy(). Siehe drivers/policy.ts.
 */

export const LABEL_MANAGED = LABEL.managed
export const LABEL_PROJECT = LABEL.project
export const LABEL_DEPLOYMENT = LABEL.deployment
export { LABEL }

/**
 * Soll ein Compose-Dienst beim Start und beim Abgleich wieder hochgefahren
 * werden? Nicht, wenn er ein Einmal-Dienst ist (restart: no / on-failure),
 * sonst liefen z.B. Migrationen bei jedem Neustart erneut. Container ohne
 * das Label stammen aus der Zeit davor und gelten als dauerhaft.
 */
export function isPersistentComposeService(labels: Record<string, string>): boolean {
  const r = labels[LABEL.composeRestart]
  return r === undefined || r === 'unless-stopped'
}

function dockerFromEnv(): Docker {
  const host = config.DOCKER_HOST
  if (host.startsWith('unix://')) return new Docker({ socketPath: host.slice('unix://'.length) })
  const m = /^tcp:\/\/([^:/]+):(\d+)$/.exec(host)
  if (!m) throw new Error(`DOCKER_HOST "${host}" nicht verstanden (erwartet tcp://host:port oder unix:///pfad)`)
  return new Docker({ host: m[1], port: Number(m[2]), protocol: 'http' })
}

export const docker = dockerFromEnv()

export function projectNetworkName(slug: string): string {
  return projectNetwork(slug)
}

/** Netz eines Projekts aus der deployer-Zeit (dep_<slug>), nur für den Übergang. */
export function legacyNetworkName(slug: string): string {
  return legacyProjectNetwork(slug)
}

export function containerName(slug: string, deploymentId: string, o: { legacy?: boolean } = {}): string {
  return `${o.legacy ? LEGACY_PROJECT_PREFIX : PROJECT_PREFIX}${slug}_${deploymentId.replace(/-/g, '').slice(0, 10)}`
}

/** Was von einer Fassung zählt, um ihr Netz und ihren Container zu finden. */
export interface DeploymentRef {
  id: string
  /** Compose: Name des Web-Containers aus dem Artefakt */
  webContainer?: string | null
}

/**
 * Netz, in dem eine Fassung läuft. Fassungen aus der deployer-Zeit laufen
 * bis zum nächsten Deploy weiter in dep_<slug>.
 */
export function networkOf(slug: string, d: DeploymentRef | null, legacy: LegacyState): string {
  return d && isLegacyDeployment(d, legacy) ? legacyNetworkName(slug) : projectNetworkName(slug)
}

/** Name des Containers, den Caddy und der Healthcheck ansprechen. */
export function webContainerOf(slug: string, d: DeploymentRef, legacy: LegacyState): string {
  return d.webContainer ?? containerName(slug, d.id, { legacy: legacy.deployments.has(d.id) })
}

function isLegacyDeployment(d: DeploymentRef, legacy: LegacyState): boolean {
  if (d.webContainer) return d.webContainer.startsWith(LEGACY_PROJECT_PREFIX)
  return legacy.deployments.has(d.id)
}

/** Container aus der deployer-Zeit, die noch existieren. */
export interface LegacyState {
  /** Deployment-IDs mit Container unter deployer.*-Labels */
  deployments: Set<string>
  /** Projekte (Slug) mit mindestens einem solchen Container */
  slugs: Set<string>
}

let legacyCache: LegacyState = { deployments: new Set(), slugs: new Set() }

/** Stand vom letzten listManagedContainers(); für synchrone Abfragen (DTOs). */
export const legacySnapshot = (): LegacyState => legacyCache

/** Frisch von Docker: welche Fassungen laufen noch unter den alten Namen? */
export async function legacyState(): Promise<LegacyState> {
  await listManagedContainers()
  return legacyCache
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
  /** M2, Wegwerf-Container: einmal laufen, nicht neu starten. */
  oneShot?: boolean
  cmd?: string[]
  workingDir?: string
  user?: string
  /** M6, Scanner */
  entrypoint?: string[]
  /** M6: ausdrücklich erlaubte Volumes ausserhalb des Projekts (Scanner-Caches). */
  extraVolumes?: { name: string; readOnly?: boolean }[]
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
    ...(spec.cmd ? { Cmd: spec.cmd } : {}),
    ...(spec.entrypoint ? { Entrypoint: spec.entrypoint } : {}),
    ...(spec.workingDir ? { WorkingDir: spec.workingDir } : {}),
    ...(spec.user ? { User: spec.user } : {}),
    HostConfig: {
      NetworkMode: spec.network,
      Memory: Math.round(spec.memoryLimitMb * 1024 * 1024),
      NanoCpus: Math.round(spec.cpuLimit * 1e9),
      RestartPolicy: { Name: spec.oneShot ? 'no' : 'unless-stopped' },
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
  assertCreatePolicy(options, spec.network, { extraVolumes: spec.extraVolumes })
  return options
}

/** Image als Tar (GET /images/{name}/get), für Trivy ohne Docker-Socket. */
export async function exportImage(ref: string): Promise<Readable> {
  return (await docker.getImage(ref).get()) as unknown as Readable
}

export async function ensureVolume(name: string): Promise<void> {
  try {
    await docker.getVolume(name).inspect()
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err
    await docker.createVolume({ Name: name, Labels: { [LABEL_MANAGED]: 'true', [LABEL.role]: 'scanner-cache' } })
  }
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
    // Gateway von Caddy oder Airlock werden. Sonst liefe deren ausgehender
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

/** Nur anlegen (z.B. um vor dem Start Dateien hineinzukopieren). */
export async function createOnly(spec: ContainerSpec): Promise<string> {
  const options = buildCreateOptions(spec)
  const container = await docker.createContainer(options as Docker.ContainerCreateOptions)
  return container.id
}

/** Tar in den Container entpacken (PUT /containers/{id}/archive). */
export async function putArchive(id: string, tar: Readable, path: string): Promise<void> {
  await docker.getContainer(id).putArchive(tar, { path })
}

/** Pfad aus dem Container als Tar holen (GET /containers/{id}/archive). */
export async function getArchive(id: string, path: string): Promise<Readable> {
  return (await docker.getContainer(id).getArchive({ path })) as unknown as Readable
}

/** Wartet auf das Ende eines Containers, mit Zeitlimit. */
export async function waitForExit(id: string, timeoutMs: number): Promise<{ exitCode: number; timedOut: boolean }> {
  const c = docker.getContainer(id)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<{ exitCode: number; timedOut: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({ exitCode: -1, timedOut: true }), timeoutMs)
  })
  const waited = c.wait().then((r: { StatusCode: number }) => ({ exitCode: r.StatusCode, timedOut: false }))
  const result = await Promise.race([waited, timeout])
  clearTimeout(timer)
  if (result.timedOut) await c.kill().catch(() => {})
  return result
}

export async function startById(id: string): Promise<void> {
  await docker.getContainer(id).start()
}

/* --- Bauen ----------------------------------------------------------------- */

export interface BuildOptions {
  tag: string
  /** Pfad des Dockerfiles relativ zum Kontext. */
  dockerfile: string
  labels: Record<string, string>
  memoryMb: number
  timeoutMs: number
  onLine?: (line: string) => void
}

/**
 * Baut ein Image aus einem Tar-Kontext ueber POST /build (klassischer
 * Builder, version=1: dockerode kann keine BuildKit-Sitzung aufbauen).
 */
export async function buildImage(context: Readable, o: BuildOptions): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), o.timeoutMs)
  try {
    const stream = (await docker.buildImage(context as unknown as NodeJS.ReadableStream, {
      t: o.tag,
      dockerfile: o.dockerfile,
      labels: o.labels,
      memory: o.memoryMb * 1024 * 1024,
      rm: true,
      forcerm: true,
      version: '1',
      abortSignal: controller.signal,
    } as Docker.ImageBuildOptions)) as Readable

    await new Promise<void>((resolve, reject) => {
      let buildError: string | null = null
      docker.modem.followProgress(
        stream,
        (err: Error | null) => {
          if (err) return reject(err)
          if (buildError) return reject(new AppError('build_failed', `Build fehlgeschlagen: ${buildError}`, 400))
          resolve()
        },
        (event: { stream?: string; error?: string; errorDetail?: { message?: string }; status?: string }) => {
          if (event.error || event.errorDetail) buildError = event.errorDetail?.message ?? event.error ?? 'unbekannt'
          const text = event.stream ?? event.status
          if (text && o.onLine) for (const l of text.split('\n')) if (l.trim()) o.onLine(l.trimEnd())
        },
      )
    })
  } catch (err) {
    if (controller.signal.aborted) {
      throw new AppError('build_timeout', `Build nach ${Math.round(o.timeoutMs / 60000)} Minuten abgebrochen`, 400)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export async function imageExists(ref: string): Promise<boolean> {
  try {
    await docker.getImage(ref).inspect()
    return true
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return false
    throw err
  }
}

/** Entfernt ein Image, falls nichts es mehr benutzt; sonst still. */
export async function removeImageIfUnused(ref: string): Promise<void> {
  try {
    await docker.getImage(ref).remove({ force: false })
  } catch (err) {
    const s = (err as { statusCode?: number }).statusCode
    if (s === 404 || s === 409) return
    throw err
  }
}

/**
 * Entfernt die benannten Volumes eines Compose-Projekts (Label
 * com.docker.compose.project). Nur auf ausdrücklichen Wunsch aufrufen:
 * darin liegen Daten.
 */
export async function removeProjectVolumes(composeProject: string): Promise<string[]> {
  const res = (await docker.listVolumes({
    filters: { label: [`com.docker.compose.project=${composeProject}`] },
  })) as { Volumes?: { Name: string }[] }
  const removed: string[] = []
  for (const v of res.Volumes ?? []) {
    try {
      await docker.getVolume(v.Name).remove()
      removed.push(v.Name)
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err
    }
  }
  return removed
}

/** Subnetze eines Netzes, z.B. fuer die Sperrliste der Repo-URLs. */
/** IPv4-Adresse eines Containers in einem Netz; null, wenn nicht vorhanden. */
export async function containerIp(container: string, network: string): Promise<string | null> {
  try {
    const info = (await docker.getContainer(container).inspect()) as {
      State?: { Running?: boolean }
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> }
    }
    if (!info.State?.Running) return null
    return info.NetworkSettings?.Networks?.[network]?.IPAddress || null
  } catch {
    return null
  }
}

export async function networkSubnets(name: string): Promise<string[]> {
  try {
    const info = (await docker.getNetwork(name).inspect()) as { IPAM?: { Config?: { Subnet?: string }[] } }
    return (info.IPAM?.Config ?? []).map((c) => c.Subnet).filter((s): s is string => !!s)
  } catch {
    return []
  }
}

/**
 * Gateway-Adressen aller Bridge-Netze (docker0, br-…). Verkehr, den der Host
 * in ein Docker-Netz maskiert (Tailscale als Subnet-Router, docker-proxy für
 * Anfragen auf localhost), kommt in Caddy mit dieser Absenderadresse an.
 */
export async function bridgeGateways(): Promise<string[]> {
  try {
    const nets = (await docker.listNetworks({ filters: { driver: ['bridge'] } })) as { IPAM?: { Config?: { Gateway?: string }[] } }[]
    return [...new Set(nets.flatMap((n) => (n.IPAM?.Config ?? []).map((c) => c.Gateway).filter((g): g is string => !!g)))]
  } catch {
    return []
  }
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
  /** Von Docker wegen der Speichergrenze beendet */
  oomKilled?: boolean
}

export async function inspectContainer(id: string): Promise<ContainerState | null> {
  try {
    const info = (await docker.getContainer(id).inspect()) as {
      Id: string
      Name: string
      State: { Running: boolean; ExitCode: number; StartedAt: string; OOMKilled?: boolean }
    }
    return {
      id: info.Id,
      name: info.Name.replace(/^\//, ''),
      running: info.State.Running,
      exitCode: info.State.Running ? null : info.State.ExitCode,
      startedAt: info.State.StartedAt ?? null,
      oomKilled: info.State.OOMKilled === true,
    }
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null
    throw err
  }
}

export interface ManagedContainer {
  id: string
  names: string[]
  /** Labels, alte deployer.*-Schlüssel zusätzlich als airlock.* (lib/names.ts) */
  labels: Record<string, string>
  running: boolean
  /** Angelegt in der deployer-Zeit (deployer.*-Labels, dep_-Namen) */
  legacy: boolean
}

/**
 * Alle von Airlock verwalteten Container, auch gestoppte – inklusive der
 * Container aus der deployer-Zeit (Übergang, siehe docs/RENAME.md).
 */
export async function listManagedContainers(): Promise<ManagedContainer[]> {
  const [current, old] = await Promise.all([
    docker.listContainers({ all: true, filters: { label: [`${LABEL_MANAGED}=true`] } }),
    docker.listContainers({ all: true, filters: { label: [`${LEGACY_LABEL_NS}.managed=true`] } }),
  ])
  const seen = new Set<string>()
  const out: ManagedContainer[] = []
  for (const c of [...current, ...old]) {
    if (seen.has(c.Id)) continue
    seen.add(c.Id)
    const { labels, legacy } = normalizeLabels(c.Labels ?? {})
    out.push({
      id: c.Id,
      names: c.Names.map((n) => n.replace(/^\//, '')),
      labels,
      running: c.State === 'running',
      legacy,
    })
  }
  const next: LegacyState = { deployments: new Set(), slugs: new Set() }
  for (const c of out) {
    if (!c.legacy) continue
    const slug = c.labels[LABEL_PROJECT]
    if (slug) next.slugs.add(slug)
    const dep = c.labels[LABEL_DEPLOYMENT]
    if (dep) next.deployments.add(dep)
  }
  legacyCache = next
  return out
}

/**
 * Reiter «Aufbau»: alle Container eines Projekts (auch gestoppte, auch aus
 * der deployer-Zeit) mit Image, Zustand, eingehängten benannten Volumes und
 * Ports im Container. Nur GET /containers/json – nichts, was der
 * Socket-Proxy nicht ohnehin erlaubt.
 */
export async function listProjectContainers(slug: string): Promise<{
  id: string; service: string | null; image: string; state: string; status: string
  mounts: { name: string; destination: string }[]; ports: number[]
}[]> {
  const [current, old] = await Promise.all([
    docker.listContainers({ all: true, filters: { label: [`${LABEL_MANAGED}=true`, `${LABEL_PROJECT}=${slug}`] } }),
    docker.listContainers({ all: true, filters: { label: [`${LEGACY_LABEL_NS}.managed=true`, `${LEGACY_LABEL_NS}.project=${slug}`] } }),
  ])
  const seen = new Set<string>()
  const out = []
  for (const c of [...current, ...old]) {
    if (seen.has(c.Id)) continue
    seen.add(c.Id)
    const { labels } = normalizeLabels(c.Labels ?? {})
    const mounts = (c.Mounts ?? [])
      .filter((m) => m.Type === 'volume' && m.Name)
      .map((m) => ({ name: m.Name!, destination: m.Destination }))
    const ports = [...new Set((c.Ports ?? []).map((p) => p.PrivatePort).filter((p) => Number.isInteger(p) && p > 0))].sort((a, b) => a - b)
    out.push({ id: c.Id, service: labels[LABEL.composeService] ?? null, image: c.Image, state: c.State, status: c.Status, mounts, ports })
  }
  return out
}

/** Volumes eines Compose-Projekts (Label com.docker.compose.project). */
export async function listComposeVolumes(composeProject: string): Promise<{ name: string; volume: string | null }[]> {
  const res = (await docker.listVolumes({
    filters: { label: [`com.docker.compose.project=${composeProject}`] },
  })) as { Volumes?: { Name: string; Labels?: Record<string, string> }[] }
  return (res.Volumes ?? []).map((v) => ({ name: v.Name, volume: v.Labels?.['com.docker.compose.volume'] ?? null }))
}

/**
 * Etappe 4: einzelne Volumes eines Compose-Projekts löschen (Dienst entfernt,
 * «Volume löschen» ausdrücklich gewählt). Nur Volumes mit dem Label genau
 * dieses Projekts und dem Compose-Namen – nie ein fremdes. Gibt die
 * gelöschten Docker-Namen zurück; ein noch eingehängtes (409) bleibt.
 */
export async function removeComposeVolumes(composeProject: string, volumes: string[]): Promise<{ removed: string[]; failed: string[] }> {
  const all = await listComposeVolumes(composeProject)
  const removed: string[] = []
  const failed: string[] = []
  for (const v of all.filter((x) => x.volume && volumes.includes(x.volume))) {
    try {
      await docker.getVolume(v.name).remove()
      removed.push(v.name)
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) failed.push(v.name)
    }
  }
  return { removed, failed }
}

export async function volumeExists(name: string): Promise<boolean> {
  try {
    await docker.getVolume(name).inspect()
    return true
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return false
    throw err
  }
}

/** Volume so anlegen, wie Compose es für <project> selbst anlegen würde (keine Warnung beim up). */
export async function createComposeVolume(name: string, composeProject: string, volume: string): Promise<void> {
  await docker.createVolume({
    Name: name,
    Labels: { 'com.docker.compose.project': composeProject, 'com.docker.compose.volume': volume },
  })
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

/**
 * UI-Qualität 4: Docker-Log eines laufenden Stroms in ganze Zeilen zerlegen.
 * Anders als demuxDockerLog behält der Decoder angefangene Rahmen und halbe
 * Zeilen bis zum nächsten Stück (ein Rahmen oder eine Zeile kann über zwei
 * Stücke gehen). Mit TTY gibt es keine Rahmen, nur Text.
 */
export class DockerLogDecoder {
  private buf: Buffer = Buffer.alloc(0)
  private tty: boolean | null = null
  private text = new StringDecoder('utf8')
  private partial = ''

  /** Neue Bytes; zurück kommen die vollständigen Zeilen */
  push(chunk: Buffer): string[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    if (this.tty === null) {
      if (this.buf.length < 8) return []
      const b = this.buf
      this.tty = !(b[0]! <= 2 && b[1] === 0 && b[2] === 0 && b[3] === 0)
    }
    let out = ''
    if (this.tty) {
      out = this.text.write(this.buf)
      this.buf = Buffer.alloc(0)
    } else {
      let i = 0
      while (i + 8 <= this.buf.length) {
        const len = this.buf.readUInt32BE(i + 4)
        if (i + 8 + len > this.buf.length) break
        out += this.text.write(this.buf.subarray(i + 8, i + 8 + len))
        i += 8 + len
      }
      this.buf = this.buf.subarray(i)
    }
    const lines = (this.partial + out).split('\n')
    this.partial = lines.pop() ?? ''
    return lines
  }

  /** Am Ende: angefangene letzte Zeile */
  flush(): string[] {
    const rest = this.partial + this.text.end()
    this.partial = ''
    return rest ? [rest] : []
  }
}

export async function getLogs(
  id: string,
  opts: { tail?: number; since?: number; timestamps?: boolean } = {},
): Promise<string> {
  try {
    const buf = (await docker.getContainer(id).logs({
      stdout: true,
      stderr: true,
      tail: opts.tail ?? 200,
      ...(opts.since ? { since: opts.since } : {}),
      timestamps: opts.timestamps ?? false,
    })) as unknown as Buffer
    return demuxDockerLog(Buffer.from(buf))
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new AppError('not_found', 'Container nicht gefunden', 404)
    }
    throw err
  }
}

export async function followLogs(id: string, since?: number, o: { tail?: number; timestamps?: boolean } = {}): Promise<Readable> {
  return (await docker.getContainer(id).logs({
    stdout: true,
    stderr: true,
    follow: true,
    tail: o.tail ?? 100,
    timestamps: o.timestamps ?? false,
    ...(since ? { since } : {}),
  })) as unknown as Readable
}
