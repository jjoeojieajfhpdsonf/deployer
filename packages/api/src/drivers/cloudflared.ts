import tarStream from 'tar-stream'
import { config } from '../config.js'
import * as docker from './docker.js'
import { AppError } from '../lib/errors.js'

/**
 * cloudflared als Container, den deployer selbst startet und verwaltet
 * (seit «Cloudflare verbinden»; früher compose.public.yaml).
 *
 * Das Tunnel-Token steht weder in der Umgebung noch in den Argumenten
 * (beides zeigt docker inspect): Es wird vor dem Start als Datei in den
 * Container gelegt und mit --token-file gelesen. Feste Ausstattung, keine
 * Projekt-Erlaubnisliste – der Container ist Teil des Stacks.
 */

export const SYSTEM_LABEL = 'deployer.system'
const TOKEN_DIR = '/etc/cloudflared'
const NONROOT_UID = 65532 // Benutzer im offiziellen Image

export interface CloudflaredState { exists: boolean; running: boolean; restarting: boolean; ours: boolean; startedAt: string | null; image: string | null; networks: string[] }

async function inspect(): Promise<{ Id: string; State: { Running: boolean; Restarting?: boolean; StartedAt: string }; Config: { Labels?: Record<string, string>; Image: string }; NetworkSettings?: { Networks?: Record<string, unknown> } } | null> {
  try {
    return (await docker.docker.getContainer(config.CLOUDFLARED_CONTAINER).inspect()) as never
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null
    throw err
  }
}

export async function cloudflaredState(): Promise<CloudflaredState> {
  const i = await inspect()
  if (!i) return { exists: false, running: false, restarting: false, ours: false, startedAt: null, image: null, networks: [] }
  return {
    exists: true,
    // Docker meldet auch während einer Neustart-Schleife Running=true
    running: i.State.Running && !i.State.Restarting,
    restarting: Boolean(i.State.Restarting),
    ours: i.Config.Labels?.[SYSTEM_LABEL] === 'cloudflared',
    startedAt: i.State.StartedAt ?? null,
    image: i.Config.Image,
    networks: Object.keys(i.NetworkSettings?.Networks ?? {}).sort(),
  }
}

function tokenArchive(token: string) {
  const pack = tarStream.pack()
  pack.entry({ name: 'etc/cloudflared', type: 'directory', mode: 0o755, uid: NONROOT_UID, gid: NONROOT_UID })
  pack.entry({ name: 'etc/cloudflared/token', mode: 0o400, uid: NONROOT_UID, gid: NONROOT_UID }, token)
  pack.finalize()
  return pack
}

/**
 * Container (neu) aufsetzen: alten eigenen entfernen, Image holen, anlegen,
 * Token hineinlegen, starten. Ein fremder Container gleichen Namens (aus
 * compose.public.yaml) bleibt unangetastet – dann Fehler mit Hinweis.
 */
export async function startCloudflared(tunnelToken: string, image = config.CLOUDFLARED_IMAGE): Promise<void> {
  const existing = await cloudflaredState()
  if (existing.exists && !existing.ours) {
    throw new AppError(
      'cloudflared_foreign',
      `Es läuft schon ein Container «${config.CLOUDFLARED_CONTAINER}», vermutlich aus compose.public.yaml. Stack ohne diese Datei neu starten, dann übernimmt deployer.`,
      409,
    )
  }
  if (existing.exists) await removeCloudflared()

  await docker.pullImage(image)
  const c = await docker.docker.createContainer({
    name: config.CLOUDFLARED_CONTAINER,
    Image: image,
    Cmd: ['tunnel', '--no-autoupdate', 'run', '--token-file', `${TOKEN_DIR}/token`],
    Labels: { [SYSTEM_LABEL]: 'cloudflared' },
    HostConfig: {
      // Nur im Netz «tunnel» (mit Caddy): nicht im edge-Netz, also nie direkt
      // beim deployer; keine Projekt-Netze, nicht das interne Netz.
      NetworkMode: config.TUNNEL_NETWORK,
      RestartPolicy: { Name: 'unless-stopped' },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: 256 * 1024 * 1024,
      NanoCpus: 500_000_000,
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '5' } },
    },
  })
  await c.putArchive(tokenArchive(tunnelToken) as unknown as NodeJS.ReadableStream, { path: '/' })
  await c.start()
}

export async function removeCloudflared(): Promise<void> {
  const s = await cloudflaredState()
  if (!s.exists || !s.ours) return
  await docker.stopContainer(config.CLOUDFLARED_CONTAINER, 5).catch(() => {})
  await docker.removeContainer(config.CLOUDFLARED_CONTAINER).catch(() => {})
}

/** Beim Start des deployers: eigener Container gestoppt? Wieder starten (Neustart-Regel greift sonst nur bei Docker). */
export async function ensureCloudflaredRunning(tunnelToken: string, image = config.CLOUDFLARED_IMAGE): Promise<'running' | 'started' | 'created'> {
  const s = await cloudflaredState()
  // Ein älterer eigener Container im falschen Netz (vor «tunnel» im edge-Netz) wird neu angelegt
  if (s.exists && s.ours && s.networks.join() !== config.TUNNEL_NETWORK) {
    await startCloudflared(tunnelToken, image)
    return 'created'
  }
  if (s.exists && s.ours && s.running) return 'running'
  if (s.exists && s.ours) {
    await docker.startContainer(config.CLOUDFLARED_CONTAINER)
    return 'started'
  }
  await startCloudflared(tunnelToken, image)
  return 'created'
}

/** Letzte Zeilen der Ausgabe, für die Fehlersuche auf der Systemseite. */
export async function cloudflaredLogTail(lines = 20): Promise<string> {
  return docker.getLogs(config.CLOUDFLARED_CONTAINER, { tail: lines }).catch(() => '')
}

/* --- Version ------------------------------------------------------------------- */

/** «cloudflare/cloudflared:2025.8.1» -> «2025.8.1»; ohne festen Tag null. */
export function versionOf(image: string | null | undefined): string | null {
  const m = /:(\d{4}\.\d{1,2}\.\d+)$/.exec(image ?? '')
  return m ? m[1]! : null
}

/** Versionen der Form JJJJ.M.P vergleichen. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

/** Höchste Release-Version aus einer Tag-Liste (ohne latest, -rc, -arm64 …). */
export function newestVersion(tags: string[]): string | null {
  const v = tags.filter((t) => /^\d{4}\.\d{1,2}\.\d+$/.test(t))
  return v.sort(compareVersions).at(-1) ?? null
}

let latestCache: { at: number; v: string | null; error: string | null } | null = null

/**
 * Neueste cloudflared-Version auf Docker Hub (dort kommt das Image her).
 * Sechs Stunden zwischengespeichert; ohne Netz bleibt es bei «unbekannt».
 */
export async function latestCloudflaredVersion(fresh = false): Promise<{ version: string | null; error: string | null }> {
  if (!fresh && latestCache && Date.now() - latestCache.at < 6 * 60 * 60_000) return { version: latestCache.v, error: latestCache.error }
  const repo = config.CLOUDFLARED_IMAGE.split(':')[0]!.replace(/^docker\.io\//, '')
  try {
    const res = await fetch(`${config.DOCKER_HUB_API}/repositories/${repo}/tags?page_size=100&ordering=last_updated`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`Docker Hub: HTTP ${res.status}`)
    const data = (await res.json()) as { results?: { name: string }[] }
    latestCache = { at: Date.now(), v: newestVersion((data.results ?? []).map((r) => r.name)), error: null }
  } catch (err) {
    latestCache = { at: Date.now() - 5 * 60 * 60_000, v: latestCache?.v ?? null, error: (err as Error).message } // in einer Stunde erneut
  }
  return { version: latestCache.v, error: latestCache.error }
}

/** Image mit anderer Version, gleiches Repository. */
export const imageWithVersion = (version: string) => `${config.CLOUDFLARED_IMAGE.split(':')[0]}:${version}`
