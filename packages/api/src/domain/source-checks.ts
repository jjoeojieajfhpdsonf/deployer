import { eq } from 'drizzle-orm'
import { readFile } from 'node:fs/promises'
import { db, schema } from '../db/index.js'
import { checkRepoUrl } from '../lib/repo-url.js'
import { normalizeCompose } from '../lib/compose.js'
import { badRequest } from '../lib/errors.js'
import { repoUrlPolicy } from './git-policy.js'
import { composeUploadPath, COMPOSE_MAX_BYTES } from '../deploy/sources/compose.js'
import { repoAddressKind, type Source } from '@airlock/shared'
import { assertRepoReachable } from './git-access.js'
import { projectNetwork } from '../lib/names.js'
import * as docker from '../drivers/docker.js'
import { checkImageInRegistry, parseImageRef } from '../lib/registry.js'
import { log } from '../lib/log.js'

/**
 * Prüfungen, die schon beim Anlegen oder Ändern eines Projekts laufen, damit
 * ein Fehler sofort mit 400 und Feldnamen zurückkommt – nicht erst als
 * gescheiterter Deploy. Die Pipeline prüft beim Deploy trotzdem erneut
 * (Repo-Inhalte können sich ändern, DNS auch).
 */
export async function checkSourceEarly(
  source: Source,
  slug: string,
  /** Nacht 3, Etappe 2: Zugang (eben erzeugt) bzw. das Projekt, dessen Zugang gilt */
  access: { credentialId?: string; project?: typeof schema.projects.$inferSelect } = {},
): Promise<void> {
  if (source.type === 'image') await checkImageEarly(source.image)

  const repoUrl = 'repoUrl' in source ? source.repoUrl : undefined
  if (repoUrl) {
    // Gesperrte Ziele (Stack, Loopback) wie bisher sofort; dann «Repo erreichbar?»
    // über genau den Weg, den der Deploy nimmt (GitHub-App, Deploy-Key, Token, ohne)
    await checkRepoUrl(repoUrl, await repoUrlPolicy(), { allowSsh: repoAddressKind(repoUrl) === 'ssh' })
    await assertRepoReachable({ repoUrl, ref: 'ref' in source ? source.ref : undefined, ...access })
  }

  if (source.type === 'compose' && source.uploadId) {
    const rows = await db.select().from(schema.uploads).where(eq(schema.uploads.id, source.uploadId)).limit(1)
    const upload = rows[0]
    if (!upload || upload.kind !== 'compose') throw badRequest('Die hochgeladene compose.yaml wurde nicht gefunden')
    const text = await readFile(composeUploadPath(upload.id), 'utf8').catch(() => {
      throw badRequest('Die hochgeladene compose.yaml liegt nicht mehr auf der Platte')
    })
    if (Buffer.byteLength(text) > COMPOSE_MAX_BYTES) throw badRequest('compose.yaml ist zu gross')
    await normalizeCompose(text, {
      slug,
      deploymentId: '00000000-0000-0000-0000-000000000000',
      deploymentShort: 'pruefung',
      webService: source.webService,
      network: projectNetwork(slug),
      memoryLimitMb: 512,
      cpuLimit: 1,
      projectEnv: {},
      repo: null,
    })
  }
}

/**
 * Gibt es das Image? Liegt es schon auf dem Server, reicht das. Sonst fragt
 * Airlock die Registry. Ist sie nicht erreichbar, wird nicht blockiert:
 * dann sagt es der Deploy.
 */
async function checkImageEarly(image: string): Promise<void> {
  if (await docker.imageExists(image).catch(() => false)) return
  const result = await checkImageInRegistry(image)
  if (result === 'ok') return
  if (result === 'unknown') {
    log.warn('Registry für die Image-Prüfung nicht erreichbar', { image })
    return
  }
  const { registry, reference } = parseImageRef(image)
  const where = registry === 'registry-1.docker.io' ? 'Docker Hub' : registry
  const message = result === 'missing'
    ? `Das Image «${image}» gibt es bei ${where} nicht. Prüfe Name und Tag («${reference}»), z.B. nginx:alpine.`
    : `«${image}» ist bei ${where} nicht öffentlich abrufbar – es existiert nicht oder ist privat. Private Images unterstützt Airlock nicht; prüfe den Namen, z.B. nginx:alpine.`
  throw badRequest(message, [{ path: 'source.image', message }])
}
