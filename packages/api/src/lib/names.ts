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
