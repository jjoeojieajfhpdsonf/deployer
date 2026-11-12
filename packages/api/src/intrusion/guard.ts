import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { AppError } from '../lib/errors.js'

/**
 * Nacht 3, Etappe 5: «Container jetzt isolieren» verweigert Start, Neustart,
 * Deploy und Rollback, bis Joël die Isolation freigibt. Klein und ohne
 * weitere Abhängigkeiten, damit Lebenszyklus und Pipeline es einbinden
 * können, ohne die Einbruchserkennung zu laden.
 */
export function isolatedError(name: string): AppError {
  return new AppError('isolated', `«${name}» ist isoliert. Start, Neustart und Deploy gehen erst nach der Freigabe (Projekt › Security › «Isolation aufheben»).`, 409)
}

export async function assertNotIsolated(p: { name: string; isolatedAt?: Date | null; previewOf?: string | null }): Promise<void> {
  if (p.isolatedAt) throw isolatedError(p.name)
  // Vorschauen folgen ihrem Projekt
  if (p.previewOf) {
    const parent = (await db.select({ name: schema.projects.name, isolatedAt: schema.projects.isolatedAt }).from(schema.projects).where(eq(schema.projects.id, p.previewOf)).limit(1))[0]
    if (parent?.isolatedAt) throw isolatedError(parent.name)
  }
}
