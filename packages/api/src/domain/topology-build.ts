import { parse } from 'yaml'
import {
  databaseKindOf, imageTag,
  type RouteDto, type TopologyAccessDto, type TopologyDto, type TopologyEdgeDto, type TopologyHealth, type TopologyHostDto,
  type TopologyServiceDto, type TopologyServiceState, type TopologyVolumeDto, type TopologyWay,
} from '@airlock/shared'
import { isOwnImage, projectNetwork } from '../lib/names.js'

/**
 * Reiter «Aufbau»: fasst Dienste, Routen, Netze, Volumes und Zustände eines
 * Projekts zusammen. Reines Modul (kein config.ts, keine Datenbank, kein
 * Docker) – domain/topology.ts sammelt die Eingaben, hier wird nur gerechnet.
 */

/** Ein Dienst aus der normalisierten compose.yaml (Artefakt der aktiven Fassung) */
export interface ComposeServiceSpec {
  image: string | null
  dependsOn: string[]
  volumes: { source: string; target: string }[]
  expose: number[]
  /** restart: no / on-failure (Migration, Seed) */
  oneShot: boolean
}

export interface ComposeSpec {
  /** In der Reihenfolge der Datei */
  services: [string, ComposeServiceSpec][]
  /** Oben unter volumes deklariert */
  volumes: string[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const portOf = (v: unknown): number | null => {
  const n = Number(String(v).split('/')[0])
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null
}

/**
 * Liest, was der Aufbau braucht, aus der normalisierten compose.yaml (die
 * Datei hat normalizeCompose() geschrieben: Image, depends_on, Volumes,
 * expose, restart). Unlesbar: null.
 */
export function parseComposeSpec(text: string): ComposeSpec | null {
  let doc: unknown
  try {
    doc = parse(text, { maxAliasCount: 50 })
  } catch {
    return null
  }
  if (!isObj(doc) || !isObj(doc.services)) return null
  const services: [string, ComposeServiceSpec][] = []
  for (const [name, raw] of Object.entries(doc.services)) {
    if (!isObj(raw)) continue
    const dependsOn = Array.isArray(raw.depends_on) ? raw.depends_on.filter((d): d is string => typeof d === 'string')
      : isObj(raw.depends_on) ? Object.keys(raw.depends_on) : []
    const volumes: { source: string; target: string }[] = []
    for (const v of Array.isArray(raw.volumes) ? raw.volumes : []) {
      if (typeof v === 'string') {
        const [source, target] = v.split(':')
        // Anonyme Volumes ("/pfad") haben keinen Namen
        if (source && target && !source.startsWith('/')) volumes.push({ source, target })
      } else if (isObj(v) && typeof v.source === 'string' && typeof v.target === 'string') {
        volumes.push({ source: v.source, target: v.target })
      }
    }
    const expose = (Array.isArray(raw.expose) ? raw.expose : []).map(portOf).filter((p): p is number => p !== null)
    const restart = typeof raw.restart === 'string' ? raw.restart : undefined
    services.push([name, {
      image: typeof raw.image === 'string' ? raw.image : null,
      dependsOn, volumes, expose,
      // wie isPersistentComposeService: ohne Angabe oder unless-stopped läuft er dauerhaft
      oneShot: restart !== undefined && restart !== 'unless-stopped' && restart !== 'always',
    }])
  }
  return { services, volumes: isObj(doc.volumes) ? Object.keys(doc.volumes) : [] }
}

/** Ein Container des Projekts, wie Docker ihn auflistet */
export interface ContainerInfo {
  id: string
  /** Compose-Dienst (Label), sonst null */
  service: string | null
  image: string
  /** running, exited, restarting, created, paused, dead */
  state: string
  /** z. B. «Up 2 hours (healthy)», «Exited (1) 3 minutes ago» */
  status: string
  /** Eingehängte benannte Volumes (Docker-Name) */
  mounts: { name: string; destination: string }[]
  /** Ports im Container (EXPOSE, nicht veröffentlicht) */
  ports: number[]
}

export interface TopologyInput {
  kind: TopologyDto['kind']
  slug: string
  /** Port des Web-Dienstes (Projekt) */
  port: number | null
  /** Compose: Dienst, an den die Routen gehen */
  webService: string | null
  /** Fassung der aktiven Deployments (Commit oder Digest) */
  version: string | null
  hasActive: boolean
  activeContainerId: string | null
  desiredRunning: boolean
  compose: ComposeSpec | null
  containers: ContainerInfo[]
  /** Compose-Volumes: Docker-Name → Name in compose.yaml */
  composeVolumes: { name: string; volume: string | null }[]
  routes: RouteDto[]
  headers: number
  /** Wege, die es in der Umgebung gibt (Tailnet/LAN mit Bereich und IP der nip.io-Namen) */
  ways: { public: boolean; tailnet: { cidr: string; ip: string | null } | null; lan: { cidr: string; ip: string | null } | null }
  /** Problem des Zertifikats der Umgebung (für https-Namen) */
  tlsProblem: string | null
  /** CPU/RAM je Container-ID (nur laufende) */
  usage: Record<string, { cpu: number; memMb: number } | null>
  limits: { cpu: number; memoryMb: number }
  /** Etappe 4: eigene interne Adressen von Diensten (Adminer usw.) */
  internalHosts?: { service: string; hostname: string; url: string; ways: TopologyWay[] }[]
}

const HEALTH: [RegExp, TopologyHealth][] = [[/\(unhealthy\)/, 'unhealthy'], [/\(healthy\)/, 'healthy'], [/health: starting/, 'starting']]
const healthOf = (status: string): TopologyHealth => HEALTH.find(([re]) => re.test(status))?.[1] ?? null
const exitCodeOf = (status: string): number | null => {
  const m = /Exited \((\d+)\)/.exec(status)
  return m ? Number(m[1]) : null
}
/** Anonyme Volumes heissen wie ein Hash: kein Name, nichts zu zeigen */
const anonymous = (name: string) => /^[0-9a-f]{64}$/.test(name)

function stateOf(c: ContainerInfo | undefined, i: TopologyInput): TopologyServiceState {
  if (!c) return i.desiredRunning && i.hasActive ? 'missing' : 'stopped'
  if (c.state === 'running') return 'running'
  if (c.state === 'restarting') return 'restarting'
  return i.desiredRunning ? 'exited' : 'stopped'
}

/** Pro Dienst einer: laufend vor gestoppt */
function pick(list: ContainerInfo[]): ContainerInfo | undefined {
  return list.find((c) => c.state === 'running') ?? list.find((c) => c.state === 'restarting') ?? list[0]
}

const isUp = (s: TopologyServiceDto | undefined) => s?.state === 'running' || s?.state === 'static'

export function buildTopology(i: TopologyInput): TopologyDto {
  const services: TopologyServiceDto[] = []
  const volumes = new Map<string, TopologyVolumeDto>()
  const versionFor = (image: string | null) => (image && isOwnImage(image) ? i.version : imageTag(image) ?? i.version)

  const volumeName = (dockerName: string) =>
    i.composeVolumes.find((v) => v.name === dockerName)?.volume
    ?? (dockerName.startsWith(`${composeProject(i.slug)}_`) ? dockerName.slice(composeProject(i.slug).length + 1) : dockerName)
  const mount = (svc: TopologyServiceDto, name: string, target: string | null) => {
    const id = `vol:${name}`
    const v = volumes.get(id) ?? { id, name, mountPath: target, sizeBytes: null, usedBy: [], paths: {} }
    if (!v.usedBy.includes(svc.id)) v.usedBy.push(svc.id)
    v.mountPath ??= target
    if (target) v.paths[svc.id] ??= target
    volumes.set(id, v)
    if (!svc.volumes.includes(id)) svc.volumes.push(id)
  }

  /* --- Dienste ------------------------------------------------------------ */
  if (i.kind === 'static') {
    services.push({
      id: `svc:${i.slug}`, name: i.slug, image: null, port: null,
      state: !i.hasActive ? 'missing' : i.desiredRunning ? 'static' : 'stopped',
      health: null, exitCode: null, version: i.version, web: true, oneShot: false, database: null, usage: null, volumes: [],
    })
  } else if (i.kind === 'compose') {
    const fromFile = i.compose?.services ?? []
    // Ohne lesbare Datei: Dienste aus den Labels der Container
    const names = fromFile.length ? fromFile.map(([n]) => n) : [...new Set(i.containers.map((c) => c.service).filter((s): s is string => Boolean(s)))]
    const web = i.webService && names.includes(i.webService) ? i.webService : names[0] ?? null
    // Web-Dienst zuerst, sonst wie in der Datei
    const ordered = web ? [web, ...names.filter((n) => n !== web)] : names
    for (const name of ordered) {
      const spec = fromFile.find(([n]) => n === name)?.[1]
      const c = pick(i.containers.filter((x) => x.service === name))
      const image = spec?.image ?? c?.image ?? null
      const isWeb = name === web
      const svc: TopologyServiceDto = {
        id: `svc:${name}`, name, image,
        port: isWeb ? i.port : spec?.expose[0] ?? c?.ports[0] ?? null,
        state: stateOf(c, i), health: c ? healthOf(c.status) : null, exitCode: c ? exitCodeOf(c.status) : null,
        version: versionFor(image), web: isWeb, oneShot: spec?.oneShot ?? false,
        database: isWeb ? null : databaseKindOf(image),
        usage: c && c.state === 'running' ? i.usage[c.id] ?? null : null,
        volumes: [],
      }
      services.push(svc)
      for (const v of spec?.volumes ?? []) mount(svc, v.source, v.target)
      for (const m of c?.mounts ?? []) if (!anonymous(m.name)) mount(svc, volumeName(m.name), m.destination)
    }
    // Deklariert, aber von keinem Dienst eingehängt: trotzdem zeigen (es liegen vielleicht Daten darin)
    for (const name of i.compose?.volumes ?? []) {
      const id = `vol:${name}`
      if (!volumes.has(id)) volumes.set(id, { id, name, mountPath: null, sizeBytes: null, usedBy: [], paths: {} })
    }
  } else {
    const c = i.containers.find((x) => x.id === i.activeContainerId) ?? pick(i.containers)
    const image = c?.image ?? null
    const svc: TopologyServiceDto = {
      id: `svc:${i.slug}`, name: i.slug, image, port: i.port,
      state: stateOf(c, i), health: c ? healthOf(c.status) : null, exitCode: c ? exitCodeOf(c.status) : null,
      // Selbst gebaut (Dockerfile): die Fassung; sonst der Tag des Images
      version: i.kind === 'dockerfile' ? i.version : versionFor(image),
      web: true, oneShot: false, database: null,
      usage: c && c.state === 'running' ? i.usage[c.id] ?? null : null,
      volumes: [],
    }
    services.push(svc)
    for (const m of c?.mounts ?? []) if (!anonymous(m.name)) mount(svc, m.name, m.destination)
  }
  const main = services.find((s) => s.web) ?? services[0] ?? null

  /* --- Eingang: je Name ein Host, nip.io als Ausweich ---------------------- */
  const hosts: TopologyHostDto[] = []
  for (const r of i.routes) {
    const targets = (r.targets ?? [r.target]) as TopologyWay[]
    const pub = r.target === 'public'
    const paused = Boolean(r.pausedAt)
    const base = { headers: i.headers, accessProtected: Boolean(r.accessProtected), paused, service: main?.id ?? null }
    const primaryUrl = r.urls[0] ?? `http://${r.hostname}`
    const tls: TopologyHostDto['tls'] = pub ? 'cloudflare' : primaryUrl.startsWith('https:') ? 'https' : 'http'
    hosts.push({ ...base, id: `host:${r.hostname}`, hostname: r.hostname, url: primaryUrl, ways: targets, fallback: false, tls, tlsProblem: tls === 'https' ? i.tlsProblem : null })
    r.aliases.forEach((alias, n) => {
      // nip.io-Name auf der LAN- bzw. Tailnet-IP: führt nur über diesen Weg
      const onIp = (ip: string | null | undefined) => Boolean(ip && alias.includes(`.${ip.replace(/\./g, '-')}.`))
      const way: TopologyWay | null = onIp(i.ways.lan?.ip) ? 'lan' : onIp(i.ways.tailnet?.ip) ? 'tailnet' : null
      const ways = way && targets.includes(way) ? [way] : targets
      const url = r.urls[n + 1] ?? `http://${alias}`
      hosts.push({ ...base, id: `host:${alias}`, hostname: alias, url, ways, fallback: true, tls: url.startsWith('https:') ? 'https' : 'http', tlsProblem: null })
    })
  }

  // Etappe 4: interne Adresse eines Dienstes (nur LAN/Tailnet), führt zu diesem Dienst statt zum Web-Dienst
  for (const ih of i.internalHosts ?? []) {
    const target = services.find((s) => s.name === ih.service)
    if (!target) continue
    hosts.push({
      id: `host:${ih.hostname}`, hostname: ih.hostname, url: ih.url, ways: ih.ways.filter((w) => w !== 'public'), fallback: false,
      headers: i.headers, tls: ih.url.startsWith('https:') ? 'https' : 'http', tlsProblem: ih.url.startsWith('https:') ? i.tlsProblem : null,
      accessProtected: false, paused: false, service: target.id, internal: true,
    })
  }

  /* --- Zugang: nur Wege, die es in der Umgebung gibt (oder die das Projekt schon nutzt) --- */
  const access: TopologyAccessDto[] = []
  const pubRoute = i.routes.find((r) => r.target === 'public')
  const uses = (w: TopologyWay) => i.routes.some((r) => (r.targets ?? [r.target]).includes(w))
  if (i.ways.public || pubRoute) {
    const paused = Boolean(pubRoute?.pausedAt)
    access.push({
      id: 'way:public', way: 'public', on: Boolean(pubRoute) && !paused, paused,
      detail: pubRoute ? (pubRoute.accessProtected ? 'Cloudflare Access' : 'Cloudflare Tunnel') : null,
    })
  }
  if (i.ways.tailnet || uses('tailnet')) access.push({ id: 'way:tailnet', way: 'tailnet', on: uses('tailnet'), paused: false, detail: i.ways.tailnet?.cidr ?? null })
  if (i.ways.lan || uses('lan')) access.push({ id: 'way:lan', way: 'lan', on: uses('lan'), paused: false, detail: i.ways.lan?.cidr ?? null })

  /* --- Linien --------------------------------------------------------------- */
  const edges: TopologyEdgeDto[] = []
  // Hauptname intern: dorthin zeigt ein abgeschalteter Weg (gestrichelt – der Schalter würde ihn verbinden)
  const mainHost = hosts.find((h) => !h.fallback && !h.internal && !h.ways.includes('public')) ?? null
  for (const a of access) {
    const reached = hosts.filter((h) => h.ways.includes(a.way))
    if (reached.length) for (const h of reached) edges.push({ from: a.id, to: h.id, on: a.on && !h.paused, via: 'route' })
    else if (mainHost) edges.push({ from: a.id, to: mainHost.id, on: false, via: 'route' })
  }
  for (const h of hosts) if (h.service) edges.push({ from: h.id, to: h.service, on: !h.paused && isUp(services.find((s) => s.id === h.service)), via: 'route' })

  // Dienst → Datenbank: gemäss depends_on; hängt niemand ausdrücklich davon ab, alle Dienste im Projekt-Netz
  const dbs = services.filter((s) => s.database)
  const apps = services.filter((s) => !s.database)
  const deps = new Map(i.compose?.services ?? [])
  for (const d of dbs) {
    const explicit = apps.filter((s) => deps.get(s.name)?.dependsOn.includes(d.name))
    const via = explicit.length ? 'depends_on' : 'network'
    for (const s of explicit.length ? explicit : apps) edges.push({ from: s.id, to: d.id, on: isUp(s) && isUp(d), via })
  }
  for (const s of services) for (const v of s.volumes) edges.push({ from: s.id, to: v, on: isUp(s), via: 'mount' })

  return {
    kind: i.kind,
    access,
    hosts,
    services,
    volumes: [...volumes.values()],
    edges,
    main: main?.id ?? null,
    limits: i.limits,
  }
}

/** Name des Compose-Projekts (= Projekt-Netz air_<slug>), Präfix der Docker-Volumes */
const composeProject = projectNetwork
