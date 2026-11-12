import { chooseNetwork, detectAdminUi, type ExternalContainerDto, type NetworkChoice } from '@airlock/shared'

/**
 * Bestehender Dienst – reine Logik ohne Docker und Datenbank: Container aus
 * GET /containers/json abbilden, Airlocks eigene und schon vergebene
 * aussortieren, Ziel für Caddy bestimmen. Treiber: drivers/foreign.ts.
 */

/** Ausschnitt aus GET /containers/json (Docker Engine API) */
export interface RawContainer {
  Id: string
  Names?: string[]
  Image?: string
  State?: string
  Status?: string
  Labels?: Record<string, string> | null
  Ports?: { PrivatePort: number; PublicPort?: number; Type?: string }[]
  HostConfig?: { NetworkMode?: string }
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> | null }
}

export interface ForeignContainer {
  id: string
  name: string
  image: string
  running: boolean
  status: string
  labels: Record<string, string>
  composeProject: string | null
  composeService: string | null
  hostMode: boolean
  networks: { name: string; ip: string | null }[]
  ports: { port: number; published: number | null }[]
}

export function toForeign(c: RawContainer): ForeignContainer {
  const labels = c.Labels ?? {}
  const ports = new Map<number, number | null>()
  for (const p of c.Ports ?? []) {
    if (p.Type && p.Type !== 'tcp') continue
    const prev = ports.get(p.PrivatePort)
    ports.set(p.PrivatePort, prev ?? p.PublicPort ?? null)
  }
  const mode = c.HostConfig?.NetworkMode ?? ''
  return {
    id: c.Id.slice(0, 12),
    name: (c.Names?.[0] ?? c.Id).replace(/^\//, ''),
    image: c.Image ?? '',
    running: c.State === 'running',
    status: c.Status ?? '',
    labels,
    composeProject: labels['com.docker.compose.project'] ?? null,
    composeService: labels['com.docker.compose.service'] ?? null,
    hostMode: mode === 'host',
    networks: Object.entries(c.NetworkSettings?.Networks ?? {}).map(([name, n]) => ({ name, ip: n?.IPAddress || null })),
    ports: [...ports.entries()].sort((a, b) => a[0] - b[0]).map(([port, published]) => ({ port, published })),
  }
}

/**
 * Gehört der Container zu Airlock selbst oder wird er von Airlock verwaltet?
 * Dann wird er nie als «bestehender Dienst» angeboten: Projekte (airlock.managed,
 * auch aus der deployer-Zeit), Wegwerf- und System-Container (airlock.system,
 * airlock.role) und der Stack von Airlock (Compose-Projekt airlock/deployer,
 * Namen airlock-*).
 */
export function isAirlockOwn(c: Pick<ForeignContainer, 'labels' | 'name' | 'composeProject'>): boolean {
  const l = c.labels
  if (l['airlock.managed'] === 'true' || l['deployer.managed'] === 'true') return true
  if (l['airlock.system'] !== undefined || l['airlock.role'] !== undefined || l['airlock.check'] !== undefined || l['airlock.smoke'] !== undefined) return true
  if (c.composeProject === 'airlock' || c.composeProject === 'deployer') return true
  return /^(airlock|deployer)-/.test(c.name) || /^(air|dep)_/.test(c.name)
}

/** Projekt, das schon auf diesen Container zeigt (Name, sonst Compose-Projekt + Dienst) */
export interface TakenTarget { projectName: string; container: string; composeProject?: string | null; composeService?: string | null }

export function takenBy(c: Pick<ForeignContainer, 'name' | 'composeProject' | 'composeService'>, taken: TakenTarget[]): string | null {
  const t = taken.find((x) => x.container === c.name
    || (x.composeProject && x.composeService && x.composeProject === c.composeProject && x.composeService === c.composeService))
  return t?.projectName ?? null
}

/** Liste für «Neues Projekt › Bestehender Dienst»: laufend, nicht Airlocks eigene, sortiert; vergebene markiert */
export function offerable(list: ForeignContainer[], taken: TakenTarget[]): ExternalContainerDto[] {
  return list
    .filter((c) => c.running && !isAirlockOwn(c))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({
      id: c.id,
      name: c.name,
      image: c.image,
      status: c.status,
      composeProject: c.composeProject,
      composeService: c.composeService,
      hostMode: c.hostMode,
      networks: c.networks.map((n) => n.name).filter((n) => n !== 'host' && n !== 'none'),
      ports: c.ports,
      adminUi: detectAdminUi({ image: c.image }),
      takenBy: takenBy(c, taken),
    }))
}

/**
 * Wiederfinden nach Löschen/Neuerstellen: zuerst am Namen, sonst am
 * Compose-Projekt und -Dienst (Compose vergibt den Namen neu, wenn das
 * Projekt umbenannt oder skaliert wird). Laufende vor gestoppten.
 */
export function refind(list: ForeignContainer[], want: { container: string; composeProject?: string | null; composeService?: string | null }): ForeignContainer | null {
  const byName = list.filter((c) => c.name === want.container)
  const byCompose = want.composeProject && want.composeService
    ? list.filter((c) => c.composeProject === want.composeProject && c.composeService === want.composeService)
    : []
  const pick = (xs: ForeignContainer[]) => xs.find((c) => c.running) ?? xs[0] ?? null
  return pick(byName) ?? pick(byCompose)
}

/** Wohin Caddy den Verkehr gibt (dial «host:port») und in welches Netz er dafür muss */
export function containerUpstream(c: Pick<ForeignContainer, 'name' | 'hostMode' | 'networks'>, port: number): { dial: string; choice: NetworkChoice } {
  const choice = chooseNetwork(c)
  return { dial: choice.mode === 'none' ? '' : `${choice.dialHost}:${port}`, choice }
}
