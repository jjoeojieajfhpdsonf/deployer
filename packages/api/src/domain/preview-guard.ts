import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { AppError } from '../lib/errors.js'
import { PreviewPublicError } from '../lib/previews.js'

/**
 * Etappe 6: Vorschauen sind immer nur intern – durchgesetzt am Server, an
 * jeder Stelle, die eine öffentliche Route anlegt oder vormerkt (planPublic,
 * applyPublic, requestPublic, setRoutes). Ohne weitere Abhängigkeiten, damit
 * public.ts und routes.ts es ohne Zyklus einbinden.
 */
export const previewPublicError = () => new AppError('preview_internal_only', new PreviewPublicError().message, 400)

export function assertNotPreviewRow(p: { previewOf?: string | null }): void {
  if (p.previewOf) throw previewPublicError()
}

export async function isPreviewProject(projectId: string): Promise<boolean> {
  const r = (await db.select({ previewOf: schema.projects.previewOf }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1))[0]
  return Boolean(r?.previewOf)
}

export async function assertNotPreview(projectId: string): Promise<void> {
  if (await isPreviewProject(projectId)) throw previewPublicError()
}
