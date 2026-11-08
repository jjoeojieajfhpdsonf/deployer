import { request } from 'undici'

/**
 * Prüft vor dem Anlegen, ob es ein Image in der Registry gibt – ohne es zu
 * laden und ohne den Docker-Proxy (DISTRIBUTION bleibt dort aus). Gefragt
 * wird die Registry selbst, anonym, wie `docker pull` es auch täte.
 */

export interface ImageRef { registry: string; repository: string; reference: string }

/** Zerlegt eine Image-Referenz nach den Regeln von Docker. */
export function parseImageRef(ref: string): ImageRef {
  let rest = ref.trim()
  let reference = 'latest'
  const at = rest.indexOf('@')
  if (at >= 0) {
    reference = rest.slice(at + 1)
    rest = rest.slice(0, at)
  } else {
    const colon = rest.lastIndexOf(':')
    if (colon > rest.lastIndexOf('/')) {
      reference = rest.slice(colon + 1)
      rest = rest.slice(0, colon)
    }
  }
  const slash = rest.indexOf('/')
  const first = slash >= 0 ? rest.slice(0, slash) : ''
  const isRegistry = slash >= 0 && (first.includes('.') || first.includes(':') || first === 'localhost')
  let registry = isRegistry ? first : 'registry-1.docker.io'
  let repository = isRegistry ? rest.slice(slash + 1) : rest
  if (registry === 'docker.io' || registry === 'index.docker.io') registry = 'registry-1.docker.io'
  if (registry === 'registry-1.docker.io' && !repository.includes('/')) repository = `library/${repository}`
  return { registry, repository, reference }
}

export type ImageCheck = 'ok' | 'missing' | 'denied' | 'unknown'

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

async function head(url: string, token?: string) {
  const res = await request(url, {
    method: 'HEAD',
    headers: { accept: ACCEPT, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    headersTimeout: 6_000,
    bodyTimeout: 6_000,
  })
  await res.body.dump()
  return res
}

/** Bearer-Challenge der Registry lesen und ein anonymes Token holen. */
async function anonymousToken(challenge: string, repository: string): Promise<string | null> {
  const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]))
  if (!params.realm) return null
  const url = new URL(params.realm)
  if (params.service) url.searchParams.set('service', params.service)
  url.searchParams.set('scope', params.scope ?? `repository:${repository}:pull`)
  const res = await request(url, { headersTimeout: 6_000, bodyTimeout: 6_000 })
  if (res.statusCode !== 200) {
    await res.body.dump()
    return null
  }
  const body = (await res.body.json()) as { token?: string; access_token?: string }
  return body.token ?? body.access_token ?? null
}

export async function checkImageInRegistry(ref: string): Promise<ImageCheck> {
  const { registry, repository, reference } = parseImageRef(ref)
  const url = `https://${registry}/v2/${repository}/manifests/${reference}`
  try {
    let res = await head(url)
    if (res.statusCode === 401) {
      const challenge = String(res.headers['www-authenticate'] ?? '')
      const token = challenge.toLowerCase().startsWith('bearer') ? await anonymousToken(challenge, repository) : null
      if (!token) return 'denied'
      res = await head(url, token)
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return 'ok'
    if (res.statusCode === 404) return 'missing'
    // Docker Hub antwortet auf unbekannte Repos mit 401 auch mit Token
    if (res.statusCode === 401 || res.statusCode === 403) return 'denied'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
