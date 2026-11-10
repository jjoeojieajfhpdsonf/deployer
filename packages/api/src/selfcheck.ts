import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cf, config } from './config.js'
import { db, schema, pool } from './db/index.js'
import { decrypt } from './lib/crypto.js'
import { storedProductionWildcard } from './lib/caddy-storage.js'

/**
 * Selbstprüfung im laufenden Container, für scripts/rename-to-airlock.sh
 * (docs/RENAME.md):
 *
 *   docker exec airlock-app node packages/api/dist/selfcheck.js
 *
 * Gibt JSON aus und endet mit 0, wenn nichts Eingerichtetes fehlt. Liest nur;
 * legt insbesondere keinen neuen Schlüssel an (das täte loadOrCreateKey).
 */

interface Check { ok: boolean; detail: string; skipped?: boolean }

async function main(): Promise<void> {
  const checks: Record<string, Check> = {}

  // Projekte
  const projects = await db.select({ slug: schema.projects.slug }).from(schema.projects)
  checks.projects = { ok: true, detail: `${projects.length} Projekte: ${projects.map((p) => p.slug).sort().join(', ') || '–'}` }

  // Secrets: jeder verschlüsselte Wert muss sich mit dem Schlüssel im Daten-Volume öffnen lassen
  const keyPath = join(config.DATA_DIR, 'keys', 'secrets.key')
  const key = existsSync(keyPath) ? readFileSync(keyPath) : null
  if (!key) {
    checks.secrets = { ok: false, detail: `Schlüssel ${keyPath} fehlt` }
  } else {
    let total = 0
    const failed: string[] = []
    const tryDecrypt = (what: string, blob: Buffer | null | undefined) => {
      if (!blob) return
      total++
      try {
        decrypt(blob, key)
      } catch {
        failed.push(what)
      }
    }
    const env = await db.select({ projectId: schema.projectEnv.projectId, key: schema.projectEnv.key, enc: schema.projectEnv.valueEncrypted }).from(schema.projectEnv)
    for (const e of env) tryDecrypt(`Env ${e.key}`, e.enc)
    const gh = await db.select({ pk: schema.gitConnections.privateKeyEncrypted, cs: schema.gitConnections.clientSecretEncrypted }).from(schema.gitConnections)
    for (const g of gh) {
      tryDecrypt('GitHub-Schlüssel', g.pk)
      tryDecrypt('GitHub-Client-Secret', g.cs)
    }
    // Cloudflare-Token (Einstellungen): beim Laden entschlüsselt
    let cfToken = 'kein Cloudflare-Token gespeichert'
    try {
      const { loadCloudflareSettings } = await import('./domain/cloudflare-settings.js')
      await loadCloudflareSettings()
      if (cf.token()) cfToken = 'Cloudflare-Token lesbar'
    } catch (err) {
      failed.push(`Cloudflare-Einstellungen (${(err as Error).message})`)
    }
    checks.secrets = failed.length
      ? { ok: false, detail: `${failed.length} von ${total} nicht entschlüsselbar: ${failed.join(', ')}` }
      : { ok: true, detail: `${total} verschlüsselte Werte entschlüsselbar; ${cfToken}` }
  }

  // Zertifikat: das produktive Wildcard-Zertifikat liegt in Caddys Speicher (Volume caddy_data)
  const base = cf.baseDomain()
  if (!base || !cf.tls()) {
    checks.certificate = { ok: true, skipped: true, detail: 'kein HTTPS eingerichtet' }
  } else {
    const c = storedProductionWildcard(config.CADDY_DATA_DIR, base, new Date(), 0)
    checks.certificate = c
      ? { ok: true, detail: `*.${base} im Speicher gefunden` }
      : { ok: false, detail: `kein gültiges produktives Zertifikat für *.${base} in ${config.CADDY_DATA_DIR}` }
  }

  // Tunnel: eingerichtet? Dann muss cloudflared verbunden sein.
  if (!cf.tunnelId()) {
    checks.tunnel = { ok: true, skipped: true, detail: 'kein Tunnel eingerichtet' }
  } else {
    const { tunnelStatus } = await import('./domain/public.js')
    const t = await tunnelStatus().catch((err) => ({ status: `Fehler: ${(err as Error).message}`, connections: 0 }))
    checks.tunnel = t && t.connections > 0
      ? { ok: true, detail: `${t.connections} Verbindung(en), Status ${t.status}` }
      : { ok: false, detail: `nicht verbunden (${t?.status ?? 'unbekannt'})` }
  }

  // Übergang: Projekte, die noch mit Containern aus der deployer-Zeit laufen (nur Hinweis)
  try {
    const docker = await import('./drivers/docker.js')
    const legacy = await docker.legacyState()
    checks.legacyContainers = {
      ok: true,
      detail: legacy.slugs.size ? `noch alt (Neu erstellen nötig): ${[...legacy.slugs].sort().join(', ')}` : 'keine',
    }
  } catch (err) {
    checks.legacyContainers = { ok: true, skipped: true, detail: `Docker nicht abfragbar: ${(err as Error).message}` }
  }

  const ok = Object.values(checks).every((c) => c.ok)
  process.stdout.write(JSON.stringify({ ok, checks }, null, 2) + '\n')
  await pool.end().catch(() => {})
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err) }) + '\n')
  process.exit(2)
})
