import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from './index.js'

/**
 * Minimaler Migrator: alle .sql-Dateien in migrations/ in Namensreihenfolge,
 * jede in einer eigenen Transaktion, Fortschritt in _migrations.
 * Laeuft beim Boot - NFR "Datenbank-Migrationen laufen automatisch".
 */
export async function runMigrations(log: (msg: string) => void): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url))
  // dist/db/ -> ../../migrations ; src/db/ -> ../../migrations
  const dir = join(here, '..', '..', 'migrations')

  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`)
    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM _migrations')).rows.map((r) => r.name),
    )
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()

    for (const file of files) {
      if (applied.has(file)) continue
      const sql = readFileSync(join(dir, file), 'utf8')
      log(`Migration ${file} wird angewendet`)
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${file} fehlgeschlagen: ${(err as Error).message}`)
      }
    }
  } finally {
    client.release()
  }
}
