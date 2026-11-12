import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AuthService } from './auth/service.js'

/**
 * Notausgang auf dem Server (Nacht 3, Etappe 1). Läuft IM Airlock-Container,
 * dort gibt es node:
 *
 *   docker compose exec airlock node dist/cli.js reset-2fa admin
 *   docker exec airlock-app node dist/cli.js reset-2fa admin
 *
 * (`dist/` im Arbeitsverzeichnis /app ist ein Verweis auf packages/api/dist,
 * siehe Dockerfile.) reset-2fa entfernt alle Passkeys, die Authenticator-App
 * und die Wiederherstellungscodes, setzt «Zweiter Faktor erforderlich» auf
 * den Standard zurück, meldet alle Sitzungen ab und schreibt ins Audit-Log.
 * Danach geht die Anmeldung wieder mit dem Passwort allein. Passwort
 * vergessen: ADMIN_PASSWORD in .env ändern und Airlock neu starten.
 */

export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
}

const USAGE = [
  'Airlock – Befehle im Container',
  '',
  '  node dist/cli.js reset-2fa <benutzer>   Passkeys, Authenticator-App und Wiederherstellungscodes',
  '                                          entfernen, alle Sitzungen abmelden (Notausgang)',
  '  node dist/cli.js help                   diese Hilfe',
  '',
  'Airlock kennt ein Konto. Als <benutzer> gehen «admin» oder der Anzeigename aus ADMIN_NAME.',
]

/** Vergleichbar machen: klein, ohne Akzente («Joël» = «joel») */
const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase()

/** Namen, unter denen das (einzige) Konto auf der Kommandozeile gemeint ist */
export function accountNames(adminName: string): string[] {
  return [...new Set(['admin', 'joel', ...(adminName.trim() ? [fold(adminName)] : [])])]
}

export async function runCli(argv: string[], io: CliIo, deps: { service: () => Promise<AuthService>; adminName: string }): Promise<number> {
  const [cmd, user, ...rest] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    USAGE.forEach((l) => io.out(l))
    return cmd ? 0 : 2
  }
  if (cmd !== 'reset-2fa') {
    io.err(`Unbekannter Befehl «${cmd}».`)
    USAGE.forEach((l) => io.err(l))
    return 2
  }
  if (!user || rest.length) {
    io.err('Aufruf: node dist/cli.js reset-2fa <benutzer>')
    return 2
  }
  const names = accountNames(deps.adminName)
  if (!names.includes(fold(user))) {
    io.err(`Unbekannter Benutzer «${user}». Airlock kennt ein Konto: ${names.join(', ')}.`)
    return 2
  }
  const service = await deps.service()
  const r = await service.resetTwoFactor(`cli:${fold(user)}`)
  io.out('Zweiter Faktor zurückgesetzt:')
  io.out(`  Passkeys entfernt:              ${r.passkeys}`)
  io.out(`  Authenticator-App entfernt:     ${r.totp ? 'ja' : 'war nicht eingerichtet'}`)
  io.out(`  Wiederherstellungscodes:        ${r.recoveryCodes} entfernt`)
  io.out(`  Sitzungen abgemeldet:           ${r.sessions}`)
  io.out('Anmelden geht jetzt wieder mit dem Passwort allein. Eintrag im Audit-Log: auth.2fa.reset.')
  io.out('Sperren nach Fehlversuchen (im laufenden Airlock) hebt ein Neustart auf: docker restart airlock-app')
  return 0
}

/** Im Betrieb: Dienst mit PostgreSQL, Migrationen falls nötig (z. B. erster Start ist gescheitert) */
async function productionService(): Promise<AuthService> {
  const { pool } = await import('./db/index.js')
  const exists = await pool.query<{ t: string | null }>("SELECT to_regclass('auth_sessions')::text AS t")
  if (!exists.rows[0]?.t) {
    const { runMigrations } = await import('./db/migrate.js')
    await runMigrations((m) => console.log(m))
  }
  const { auth } = await import('./http/auth.js')
  return auth()
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const io: CliIo = { out: (l) => console.log(l), err: (l) => console.error(l) }
  let code = 2
  try {
    code = await runCli(argv, io, {
      service: productionService,
      // config.ts erst laden, wenn ein Befehl die Datenbank braucht (Hilfe geht ohne Umgebung)
      get adminName() { return process.env.ADMIN_NAME ?? '' },
    })
  } catch (err) {
    console.error(`Fehler: ${(err as Error).message}`)
    code = 1
  } finally {
    if (argv[0] === 'reset-2fa') {
      const { pool } = await import('./db/index.js').catch(() => ({ pool: null }))
      await pool?.end().catch(() => {})
    }
  }
  process.exit(code)
}

// Direkt aufgerufen (auch über den Verweis /app/dist → packages/api/dist): ausführen
const self = fileURLToPath(import.meta.url)
const invoked = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]!) } catch { return process.argv[1]! } })() : ''
if (invoked === self) void main()
