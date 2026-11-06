import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { config } from '../config.js'
import * as schema from './schema.js'

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 })
export const db = drizzle(pool, { schema })
export { schema }

export async function getSetting(key: string): Promise<string | null> {
  const rows = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).limit(1)
  return rows[0]?.value ?? null
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(schema.appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: new Date() } })
}

/* --- Advisory Lock pro Projekt -------------------------------------------
 * Sitzungsweit (nicht transaktionsweit): ein Deploy dauert Minuten und
 * umfasst viele Transaktionen. Nicht blockierend: ein zweiter Deploy soll
 * sofort 409 bekommen, nicht warten. Selbstheilend: stirbt der Prozess,
 * schliesst Postgres die Verbindung und gibt den Lock frei.
 * -------------------------------------------------------------------------- */

const LOCK_CLASS = 0x6465 // 'de'

function lockKeyFor(projectId: string): number {
  // Stabiler 31-Bit-Hash (FNV-1a) der Projekt-ID.
  let h = 0x811c9dc5
  for (let i = 0; i < projectId.length; i++) {
    h ^= projectId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h & 0x7fffffff
}

export interface ProjectLock {
  release(): Promise<void>
}

/** null, wenn bereits ein Deploy fuer dieses Projekt laeuft. */
export async function tryLockProject(projectId: string): Promise<ProjectLock | null> {
  const key = lockKeyFor(projectId)
  const client = await pool.connect()
  try {
    const res = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [LOCK_CLASS, key],
    )
    if (!res.rows[0]?.locked) {
      client.release()
      return null
    }
  } catch (err) {
    client.release()
    throw err
  }

  let released = false
  return {
    async release() {
      if (released) return
      released = true
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_CLASS, key])
      } finally {
        client.release()
      }
    },
  }
}

export const __testing = { lockKeyFor }
