/**
 * Namen, unter denen Airlock Docker-Objekte anlegt und wiedererkennt.
 *
 * Reines Modul (kein config.ts), damit Policy und Compose-Prüfung es ohne
 * Umgebung benutzen können.
 *
 * Übergang deployer → Airlock (docs/RENAME.md): Angelegt wird nur noch mit
 * `airlock.*`-Labels und dem Präfix `air_`. Container, Netze und Volumes aus
 * der deployer-Zeit (`deployer.*`, `dep_`) werden beim Lesen weiter erkannt
 * und beim nächsten Deploy bzw. per «Neu erstellen» ersetzt. Alles mit
 * LEGACY im Namen fällt weg, sobald auf dem Server keine solchen Objekte mehr
 * existieren.
 */

const NS = 'airlock'

export const LABEL = {
  managed: `${NS}.managed`,
  project: `${NS}.project`,
  deployment: `${NS}.deployment`,
  role: `${NS}.role`,
  scan: `${NS}.scan`,
  system: `${NS}.system`,
  composeService: `${NS}.compose-service`,
  composeRestart: `${NS}.compose-restart`,
} as const

/* --- HomeBento ------------------------------------------------------------
 * HomeBento (Dashboard für den ganzen Homeserver) schlägt Container anhand
 * ihrer Docker-Labels als Kacheln vor. Projekt-Container tragen Name,
 * Hauptadresse und – falls bekannt – ein Icon aus dashboard-icons; alles
 * andere, was Airlock startet (Scan, Build, Kopier- und Prüf-Container),
 * trägt homebento.ignore, damit es nicht als Dienst erscheint.
 */
export const HOMEBENTO = {
  name: 'homebento.name',
  href: 'homebento.href',
  icon: 'homebento.icon',
  ignore: 'homebento.ignore',
} as const

/** Labels eines Projekt-Containers; ohne Adresse bzw. Icon fehlt der Schlüssel ganz. */
export function homebentoLabels(o: { name: string; href?: string | null; icon?: string | null }): Record<string, string> {
  return {
    [HOMEBENTO.name]: o.name,
    ...(o.href ? { [HOMEBENTO.href]: o.href } : {}),
    ...(o.icon ? { [HOMEBENTO.icon]: o.icon } : {}),
  }
}

/** Anzeigename eines Compose-Dienstes in HomeBento: «Projekt · Dienst» */
export const homebentoServiceName = (project: string, service: string): string => `${project} · ${service}`

/**
 * Compose: der Web-Dienst trägt die Hauptadresse, die übrigen Dienste nur
 * «Projekt · Dienst» (und ein Icon, falls das Image bekannt ist).
 */
export function composeHomebentoLabels(o: { projectName: string; service: string; webService: string; href: string | null; image?: string | null }): Record<string, string> {
  return homebentoLabels({
    name: homebentoServiceName(o.projectName, o.service),
    href: o.service === o.webService ? o.href : null,
    icon: homebentoIconForImage(o.image),
  })
}

/**
 * Wer nichts über HomeBento sagt, wird ausgeblendet: Container ohne
 * homebento.name bekommen homebento.ignore=true. So erscheint ein
 * Wegwerf-Container nie als Kachel, auch wenn ein neuer Codepfad das Label vergisst.
 */
export function withHomebentoDefault(labels: Record<string, string>): Record<string, string> {
  if (labels[HOMEBENTO.name] !== undefined || labels[HOMEBENTO.ignore] !== undefined) return labels
  return { ...labels, [HOMEBENTO.ignore]: 'true' }
}

/**
 * Icon (Name aus dashboard-icons) für bekannte Images, sonst null. Nur
 * Hilfsdienste mit eindeutigem Image; eigene Apps haben kein bekanntes Icon.
 */
export function homebentoIconForImage(image: string | null | undefined): string | null {
  // Selbst gebaute Images (airlock/<slug>) heissen wie das Projekt – das sagt nichts über ein Icon
  if (!image || isOwnImage(image)) return null
  // registry/namespace/name:tag@digest → name
  const base = image.split('@')[0]!.split('/').pop()!.split(':')[0]!.toLowerCase()
  return KNOWN_ICONS[base] ?? null
}

const KNOWN_ICONS: Record<string, string> = {
  postgres: 'postgres',
  postgis: 'postgres',
  postgresql: 'postgres',
  mariadb: 'mariadb',
  mysql: 'mysql',
  mongo: 'mongodb',
  redis: 'redis',
  valkey: 'valkey',
  adminer: 'adminer',
  nginx: 'nginx',
  caddy: 'caddy',
  minio: 'minio',
  rabbitmq: 'rabbitmq',
  memcached: 'memcached',
  meilisearch: 'meilisearch',
  elasticsearch: 'elasticsearch',
  grafana: 'grafana',
  prometheus: 'prometheus',
  'n8n': 'n8n',
}

/** Präfix für Projekt-Netze, -Container und Compose-Projekte. */
export const PROJECT_PREFIX = 'air_'

/** Präfix lokal gebauter Images. */
export const IMAGE_PREFIX = 'airlock/'

/* --- Übergang aus der deployer-Zeit ------------------------------------- */

export const LEGACY_LABEL_NS = 'deployer'
export const LEGACY_PROJECT_PREFIX = 'dep_'
export const LEGACY_IMAGE_PREFIX = 'deployer/'

/** Netz eines Projekts: air_<slug> */
export const projectNetwork = (slug: string): string => `${PROJECT_PREFIX}${slug}`

/** Netz eines Projekts aus der deployer-Zeit: dep_<slug> */
export const legacyProjectNetwork = (slug: string): string => `${LEGACY_PROJECT_PREFIX}${slug}`

/** Netz, Container oder Compose-Projekt von Airlock (neu oder alt)? */
export const isProjectScoped = (name: string): boolean =>
  name.startsWith(PROJECT_PREFIX) || name.startsWith(LEGACY_PROJECT_PREFIX)

/** Ein Name aus der deployer-Zeit (dep_…)? */
export const isLegacyName = (name: string): boolean => name.startsWith(LEGACY_PROJECT_PREFIX)

/** Lokal gebautes Image (airlock/… oder deployer/…)? */
export const isOwnImage = (ref: string): boolean => ref.startsWith(IMAGE_PREFIX) || ref.startsWith(LEGACY_IMAGE_PREFIX)

/**
 * Labels eines Containers auf die neuen Schlüssel abbilden: `deployer.x`
 * wird zu `airlock.x`, sofern es den neuen Schlüssel nicht schon gibt. So
 * prüft der übrige Code nur noch `airlock.*`.
 */
export function normalizeLabels(labels: Record<string, string>): { labels: Record<string, string>; legacy: boolean } {
  const legacy = labels[`${LEGACY_LABEL_NS}.managed`] === 'true' && labels[LABEL.managed] !== 'true'
  if (!legacy) return { labels, legacy: false }
  const out: Record<string, string> = { ...labels }
  const prefix = `${LEGACY_LABEL_NS}.`
  for (const [k, v] of Object.entries(labels)) {
    if (!k.startsWith(prefix)) continue
    const nk = `${NS}.${k.slice(prefix.length)}`
    if (!(nk in out)) out[nk] = v
  }
  return { labels: out, legacy: true }
}
