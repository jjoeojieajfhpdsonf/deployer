/**
 * Wegwerf-Postgres für Skript-Tests (M9): ein postgres:17-alpine-Container
 * auf einem freien Port, nach dem Lauf wieder entfernt. Setzt
 * DATABASE_URL und die Pfade, die config.ts braucht, in process.env – die
 * Module von Airlock danach erst dynamisch importieren.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

const sh = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
    s.on('error', reject)
  })
}

export interface Throwaway {
  url: string
  dir: string
  stop(): void
}

export async function startThrowawayPostgres(name: string): Promise<Throwaway> {
  const port = await freePort()
  try {
    sh(['rm', '-f', name])
  } catch {
    /* gab es nicht */
  }
  sh(['run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_USER=airlock', '-e', 'POSTGRES_DB=airlock', '-p', `127.0.0.1:${port}:5432`, 'postgres:17-alpine'])
  const url = `postgres://airlock:test@127.0.0.1:${port}/airlock`
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      sh(['exec', name, 'pg_isready', '-U', 'airlock', '-d', 'airlock', '-h', '127.0.0.1'])
      break
    } catch {
      if (Date.now() > deadline) throw new Error('Postgres startet nicht')
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  // pg_isready meldet sich vor dem letzten Neustart des Init-Skripts: kurz warten und nochmals
  await new Promise((r) => setTimeout(r, 1500))
  for (;;) {
    try {
      sh(['exec', name, 'psql', '-U', 'airlock', '-d', 'airlock', '-h', '127.0.0.1', '-c', 'select 1'])
      break
    } catch {
      if (Date.now() > deadline) throw new Error('Postgres nimmt keine Verbindung an')
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))
  Object.assign(process.env, {
    DATABASE_URL: url,
    ADMIN_PASSWORD: 'test-passwort',
    NODE_ENV: 'test',
    DATA_DIR: join(dir, 'data'),
    SITES_DIR: join(dir, 'sites'),
    CADDY_SECRETS_DIR: join(dir, 'caddy-secrets'),
    CADDY_DATA_DIR: join(dir, 'caddy-data'),
    // Kein Docker und kein Caddy: alles, was dorthin geht, schlägt schnell fehl
    DOCKER_HOST: 'tcp://127.0.0.1:1',
    CADDY_ADMIN_SOCKET: join(dir, 'admin.sock'),
    CADDY_PROBE_SOCKET: join(dir, 'probe.sock'),
    CLOUDFLARE_API_BASE: process.env.CLOUDFLARE_API_BASE ?? 'http://127.0.0.1:1/client/v4',
  })
  return {
    url,
    dir,
    stop() {
      try {
        sh(['rm', '-f', name])
      } catch {
        /* schon weg */
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Kleine Prüf-Ausgabe wie in den übrigen Skript-Tests. */
export function checker() {
  let failures = 0
  let total = 0
  return {
    check(ok: boolean, what: string, detail?: unknown) {
      total++
      console.log(`${ok ? '✓' : '✗'} ${what}${!ok && detail !== undefined ? ` – ${JSON.stringify(detail)}` : ''}`)
      if (!ok) failures++
    },
    done(): never {
      console.log(`\n${total - failures} von ${total} Prüfungen bestanden`)
      process.exit(failures ? 1 : 0)
    },
  }
}
