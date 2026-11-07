import { join } from 'node:path'
import { config, nipioEnabled } from './config.js'
import { runMigrations } from './db/migrate.js'
import { pool } from './db/index.js'
import { loadOrCreateKey } from './lib/crypto.js'
import { ensureAdminPassword } from './http/auth.js'
import { buildApp } from './http/app.js'
import { reconcileOnBoot } from './jobs/reconcile.js'
import { startCleanupJob } from './jobs/cleanup.js'
import { startExpiryJob } from './jobs/expiry.js'
import { startSecurityJobs } from './jobs/security.js'
import { startCertJob } from './jobs/cert.js'
import { ensureTailnetDnsOnBoot } from './domain/tailnet.js'
import { abandonUnfinishedScans } from './security/scan.js'
import { log } from './lib/log.js'

async function main(): Promise<void> {
  log.info('deployer startet', { version: config.version, env: config.NODE_ENV })

  await runMigrations((msg) => log.info(msg))
  loadOrCreateKey(join(config.DATA_DIR, 'keys', 'secrets.key'))
  await ensureAdminPassword()

  if (!config.CADDY_IP_FILTER) {
    // Ein stiller Schalter landet irgendwann unbemerkt auf dem Server.
    log.warn(
      'CADDY_IP_FILTER=off – interne Hostnamen sind ohne Herkunftsprüfung erreichbar. ' +
        'Nur für Docker Desktop auf dem Mac gedacht, nicht für den Server.',
    )
  }
  if (!config.INTERNAL_BASE_DOMAIN) {
    log.info('Keine Basisdomain gesetzt: Projekte sind über ihre nip.io-Adresse erreichbar.')
  }
  if (!nipioEnabled) {
    log.warn('nip.io-Rückfall inaktiv: SERVER_LAN_IP ist nicht gesetzt ("pnpm ip" auf dem Server).')
  }
  if (!config.INTERNAL_BASE_DOMAIN && !nipioEnabled) {
    // Weder Basisdomain noch nip.io: die Adressen enden auf .int.invalid und
    // sind nirgends erreichbar. Laut, damit es nicht wie ein Netzproblem aussieht.
    log.error(
      'Weder INTERNAL_BASE_DOMAIN noch SERVER_LAN_IP gesetzt – kein Projekt ist erreichbar. ' +
        'Mindestens eines davon in .env eintragen.',
    )
  }

  try {
    await reconcileOnBoot()
  } catch (err) {
    // Ohne Caddy laeuft nichts, aber die UI soll trotzdem starten und den
    // Fehler anzeigen koennen.
    log.error('Abgleich beim Start fehlgeschlagen', { err: String(err) })
  }

  // M4: Tailnet-DNS und Zertifikat (nur mit TLS_MODE=cloudflare)
  // Im Hintergrund: ein langsames Cloudflare soll den Start nicht aufhalten.
  void ensureTailnetDnsOnBoot()
  startCertJob()

  startCleanupJob()
  startExpiryJob()
  // M6
  await abandonUnfinishedScans()
  startSecurityJobs()

  const app = await buildApp()
  await app.listen({ host: '0.0.0.0', port: config.PORT })
  log.info('bereit', { port: config.PORT })

  const shutdown = async (signal: string) => {
    log.info('fahre herunter', { signal })
    await app.close()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  log.error('Start fehlgeschlagen', { err: (err as Error).stack ?? String(err) })
  process.exit(1)
})
