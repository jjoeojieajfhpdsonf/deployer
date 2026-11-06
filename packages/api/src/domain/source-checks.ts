import { eq } from 'drizzle-orm'
import { readFile } from 'node:fs/promises'
import { db, schema } from '../db/index.js'
import { checkRepoUrl } from '../lib/repo-url.js'
import { normalizeCompose } from '../lib/compose.js'
import { badRequest } from '../lib/errors.js'
import { repoUrlPolicy } from './git-policy.js'
import { composeUploadPath, COMPOSE_MAX_BYTES } from '../deploy/sources/compose.js'
import type { Source } from '@deployer/shared'

/**
 * Prüfungen, die schon beim Anlegen oder Ändern eines Projekts laufen, damit
 * ein Fehler sofort mit 400 und Feldnamen zurückkommt – nicht erst als
 * gescheiterter Deploy. Die Pipeline prüft beim Deploy trotzdem erneut
 * (Repo-Inhalte können sich ändern, DNS auch).
 */
export async function checkSourceEarly(source: Source, slug: string): Promise<void> {
  const repoUrl = 'repoUrl' in source ? source.repoUrl : undefined
  if (repoUrl) await checkRepoUrl(repoUrl, await repoUrlPolicy())

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
      network: `dep_${slug}`,
      memoryLimitMb: 512,
      cpuLimit: 1,
      projectEnv: {},
      repo: null,
    })
  }
}
