import { join } from 'node:path'
import { cf, config, nipioEnabled } from './config.js'
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
import { startMonitorJob } from './jobs/monitor.js'
import { loadCloudflareSettings, ensureManagedTunnelOnBoot } from './domain/cloudflare-settings.js'
import { startNetworkWatch } from './domain/network.js'
import { scrubAuditSecrets } from './domain/audit.js'
import { scrubDeploymentLogs } from './deploy/journal.js'
import { ensureTailnetDnsOnBoot } from './domain/tailnet.js'
import { reconcilePublicOnBoot } from './domain/public.js'
import { startCloudflaredWatch } from './domain/routes.js'
import { abandonUnfinishedScans } from './security/scan.js'
import { log } from './lib/log.js'

async function main(): Promise<void> {
  log.info('deployer startet', { version: config.version, env: config.NODE_ENV })

  await runMigrations((msg) => log.info(msg))
  loadOrCreateKey(join(config.DATA_DIR, 'keys', 'secrets.key'))
  await ensureAdminPassword()
  // Cloudflare aus der Datenbank (Systemseite), vor allem, was Adressen braucht
  await loadCloudflareSettings()
  // Tokens aus alten Audit-Einträgen entfernen (bekanntes Token ist jetzt registriert)
  await scrubAuditSecrets().catch((err) => log.warn('Audit-Einträge nicht bereinigt', { err: String(err) }))
  void scrubDeploymentLogs()
    .then((n) => n && log.warn('Tokens aus Deploy-Logs entfernt', { dateien: n }))
    .catch((err) => log.warn('Deploy-Logs nicht bereinigt', { err: String(err) }))
  // LAN-IP, LAN-Netz und Tailscale-IP vom Host (stündlich erneut), vor allem, was Adressen braucht
  await startNetworkWatch()

  if (!config.CADDY_IP_FILTER) {
    // Ein stiller Schalter landet irgendwann unbemerkt auf dem Server.
    log.warn(
      'CADDY_IP_FILTER=off – interne Hostnamen sind ohne Herkunftsprüfung erreichbar. ' +
        'Nur für Docker Desktop auf dem Mac gedacht, nicht für den Server.',
    )
  }
  if (!cf.baseDomain()) {
    log.info('Keine Basisdomain gesetzt: Projekte sind über ihre nip.io-Adresse erreichbar.')
  }
  if (!nipioEnabled()) {
    log.warn('nip.io-Rückfall inaktiv: weder Tailscale- noch LAN-IP bekannt (Erkennung ohne Ergebnis, SERVER_LAN_IP leer).')
  }
  if (!cf.baseDomain() && !nipioEnabled()) {
    // Weder Basisdomain noch nip.io: die Adressen enden auf .int.invalid und
    // sind nirgends erreichbar. Laut, damit es nicht wie ein Netzproblem aussieht.
    log.error(
      'Weder Basisdomain noch eine IP des Servers bekannt – kein Projekt ist erreichbar. ' +
        'Tailscale einrichten (siehe docs/INSTALL.md) oder SERVER_LAN_IP in .env eintragen.',
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
  // M5: Domains und Tunnel-Ingress aus der Datenbank, ebenfalls im Hintergrund.
  void reconcilePublicOnBoot()
  void ensureManagedTunnelOnBoot()
  startCloudflaredWatch()
  startCertJob()

  startCleanupJob()
  startExpiryJob()
  // M6
  await abandonUnfinishedScans()
  startSecurityJobs()
  startMonitorJob()

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
