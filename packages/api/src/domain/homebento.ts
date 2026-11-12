import { mainUrlOf } from '@airlock/shared'
import { routeDtosFor } from './routes.js'
import { homebentoIconForImage, homebentoLabels } from '../lib/names.js'

/**
 * Labels für HomeBento an den Containern eines Projekts (Abgrenzung HomeBento).
 * Die Adresse ist die beim Deploy gültige Hauptadresse; ändert sie sich
 * (öffentlich gemacht, pausiert), zieht das Label beim nächsten Deploy nach –
 * Docker kann Labels laufender Container nicht ändern.
 */
export async function projectHomebentoLabels(project: { id: string; slug: string; name: string }, image?: string | null): Promise<Record<string, string>> {
  const href = mainUrlOf(await routeDtosFor(project.id, project.slug))
  return homebentoLabels({ name: project.name, href, icon: homebentoIconForImage(image) })
}

/** Hauptadresse eines Projekts (für Compose: kommt in ComposeContext.homebento) */
export async function projectMainUrl(project: { id: string; slug: string }): Promise<string | null> {
  return mainUrlOf(await routeDtosFor(project.id, project.slug))
}
