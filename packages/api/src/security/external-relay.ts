import { createServer, connect, type Server, type Socket } from 'node:net'
import { config } from '../config.js'
import * as docker from '../drivers/docker.js'
import { withProjectNetwork } from '../deploy/attach.js'
import { externalUpstream } from '../domain/external.js'
import type { schema } from '../db/index.js'

type Row = typeof schema.projects.$inferSelect

/**
 * Scan eines bestehenden Dienstes. Scanner-Container entstehen nach der
 * Richtlinie nur in Netzen air_<slug> – in ein fremdes Netz kommen sie nicht,
 * und an den fremden Container hängt Airlock nichts. Deshalb leitet Airlock
 * für die Dauer des Scans eine TCP-Verbindung durch: Airlock hängt sich in
 * air_<slug> und (bei einem Container) in dessen Netz, lauscht NUR auf seiner
 * Adresse im Projekt-Netz und verbindet jede Verbindung roh mit dem Ziel. TLS
 * bleibt dabei Ende-zu-Ende (testssl sieht das Zertifikat des Ziels).
 */
export interface Relay {
  /** z. B. «http://airlock-app:40123/» – im Projekt-Netz auflösbar */
  url: string
  host: string
  isHttps: boolean
  stop(): Promise<void>
}

/** Rohes Durchleiten; exportiert für den Test */
export function pipeTo(dial: { host: string; port: number }): (client: Socket) => void {
  return (client) => {
    const upstream = connect(dial.port, dial.host)
    const close = () => { client.destroy(); upstream.destroy() }
    client.on('error', close)
    upstream.on('error', close)
    client.pipe(upstream)
    upstream.pipe(client)
  }
}

export async function startRelay(project: Pick<Row, 'slug' | 'sourceConfig' | 'externalMissingSince'>, projectNetwork: string): Promise<Relay> {
  const up = externalUpstream(project)
  if (!up) throw new Error('Ziel fehlt – nichts zu scannen')
  const [host, portText] = [up.dial.slice(0, up.dial.lastIndexOf(':')), up.dial.slice(up.dial.lastIndexOf(':') + 1)]
  const dial = { host, port: Number(portText) }

  // Airlock bleibt in beiden Netzen, bis stop() läuft (Zähler je Netz, deploy/attach.ts)
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  const ready: Promise<void>[] = []
  const hold = (net: string) => {
    let entered!: () => void
    ready.push(new Promise<void>((r) => { entered = r }))
    void withProjectNetwork(net, async () => { entered(); await held }).catch(() => entered())
  }
  hold(projectNetwork)
  if (up.network) hold(up.network)
  await Promise.all(ready)

  const ip = await docker.containerIp(config.AIRLOCK_CONTAINER, projectNetwork)
  if (!ip) { release(); throw new Error('Airlock ist nicht im Projekt-Netz – Scan nur im Container-Betrieb') }
  const server: Server = createServer(pipeTo(dial))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, ip, () => resolve())
  })
  const port = (server.address() as { port: number }).port
  const isHttps = Boolean(up.tls)
  return {
    url: `${isHttps ? 'https' : 'http'}://${config.AIRLOCK_CONTAINER}:${port}/`,
    host: config.AIRLOCK_CONTAINER,
    isHttps,
    stop: async () => {
      await new Promise<void>((r) => server.close(() => r()))
      release()
    },
  }
}
