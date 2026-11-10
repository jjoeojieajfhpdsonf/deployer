import { PolicyError } from '../lib/errors.js'

/**
 * Richtlinienprüfung für Container-Erstellung.
 *
 * ERLAUBNISLISTE, keine Sperrliste: In HostConfig sind genau die unten
 * aufgeführten Felder zulässig, jedes andere führt zur Ablehnung – auch eines,
 * das heute noch niemand kennt. Eine Sperrliste wäre nach dem nächsten
 * Docker-Release still löchrig, weil ein neues Feld standardmässig durchginge.
 *
 * Der Socket-Proxy hilft hier nicht: Wer POST /containers/create aufrufen darf,
 * kann mit Privileged + Bind-Mount auf / Root auf dem Host werden. Der Proxy
 * filtert Endpunkte, nicht Nutzlasten. Diese Datei ist die eigentliche Schranke.
 *
 * Bei Verstoss wird abgebrochen, nicht korrigiert: stilles Zurechtbiegen würde
 * den Fehler verstecken.
 */

export const ALLOWED_HOST_CONFIG_FIELDS = [
  'NetworkMode',
  'Memory',
  'NanoCpus',
  'RestartPolicy',
  'LogConfig',
  'SecurityOpt',
  'Mounts',
] as const

export const ALLOWED_CREATE_FIELDS = [
  'name',
  'Image',
  'Env',
  'Labels',
  'Hostname',
  'HostConfig',
  'NetworkingConfig',
  // M2: fuer Wegwerf-Container (statischer Build). Beruehren den Host nicht.
  'Cmd',
  'Entrypoint',
  'WorkingDir',
  'User',
] as const

/**
 * Neue Container entstehen nur in Netzen air_<slug>. Netze aus der
 * deployer-Zeit (dep_<slug>) bekommen bewusst keine neuen Container mehr.
 */
export const PROJECT_NETWORK_RE = /^air_[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/

export const REQUIRED_SECURITY_OPT = ['no-new-privileges:true']
export const REQUIRED_LOG_CONFIG = {
  Type: 'json-file',
  Config: { 'max-size': '10m', 'max-file': '5' },
}

function fail(rule: string, message: string): never {
  throw new PolicyError(rule, message)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Prüft die vollständige Nutzlast für POST /containers/create.
 * `expectedNetwork` ist das Projekt-Netz, in dem der Container laufen MUSS.
 */
export interface PolicyOptions {
  /**
   * M6: zusätzlich erlaubte benannte Volumes, mit exaktem Namen – etwa der
   * Cache eines Scanners. `readOnly: true` erzwingt den Mount nur lesend.
   * Leer im Normalfall; Projekt-Container bekommen hier nie etwas.
   */
  extraVolumes?: { name: string; readOnly?: boolean }[]
}

export function assertCreatePolicy(
  options: Record<string, unknown>,
  expectedNetwork: string,
  opts: PolicyOptions = {},
): void {
  if (!PROJECT_NETWORK_RE.test(expectedNetwork)) {
    fail('network.name', `Projekt-Netz "${expectedNetwork}" entspricht nicht dem Muster air_<slug>`)
  }

  for (const key of Object.keys(options)) {
    if (!(ALLOWED_CREATE_FIELDS as readonly string[]).includes(key)) {
      fail(
        'create.unknown_field',
        `Feld "${key}" ist bei der Container-Erstellung nicht erlaubt. ` +
          `Erlaubt sind nur: ${ALLOWED_CREATE_FIELDS.join(', ')}.`,
      )
    }
  }

  if (typeof options.Image !== 'string' || options.Image.length === 0) {
    fail('create.image', 'Image fehlt oder ist kein String')
  }

  if (options.Env !== undefined) {
    if (!Array.isArray(options.Env) || options.Env.some((e) => typeof e !== 'string')) {
      fail('create.env', 'Env muss ein Array von Strings sein')
    }
  }

  for (const key of ['Cmd', 'Entrypoint'] as const) {
    const v = options[key]
    if (v !== undefined && (!Array.isArray(v) || v.some((e) => typeof e !== 'string'))) {
      fail(`create.${key.toLowerCase()}`, `${key} muss ein Array von Strings sein`)
    }
  }
  if (options.WorkingDir !== undefined) {
    if (typeof options.WorkingDir !== 'string' || !options.WorkingDir.startsWith('/')) {
      fail('create.workingdir', 'WorkingDir muss ein absoluter Pfad sein')
    }
  }
  if (options.User !== undefined && typeof options.User !== 'string') {
    fail('create.user', 'User muss ein String sein')
  }

  const hostConfig = options.HostConfig
  if (!isPlainObject(hostConfig)) fail('hostconfig.missing', 'HostConfig fehlt')
  assertHostConfigPolicy(hostConfig, expectedNetwork, opts)

  if (options.NetworkingConfig !== undefined) {
    assertNetworkingConfigPolicy(options.NetworkingConfig, expectedNetwork)
  }
}

export function assertHostConfigPolicy(
  hostConfig: Record<string, unknown>,
  expectedNetwork: string,
  opts: PolicyOptions = {},
): void {
  // --- Der Kern: alles ausserhalb der Erlaubnisliste fliegt raus. ----------
  for (const key of Object.keys(hostConfig)) {
    if (!(ALLOWED_HOST_CONFIG_FIELDS as readonly string[]).includes(key)) {
      fail(
        'hostconfig.unknown_field',
        `HostConfig-Feld "${key}" ist nicht erlaubt. Die Prüfung ist eine ` +
          `Erlaubnisliste; zulässig sind nur: ${ALLOWED_HOST_CONFIG_FIELDS.join(', ')}.`,
      )
    }
  }

  // --- NetworkMode: genau das Projekt-Netz --------------------------------
  const net = hostConfig.NetworkMode
  if (typeof net !== 'string') fail('hostconfig.networkmode', 'NetworkMode fehlt')
  if (net !== expectedNetwork) {
    fail(
      'hostconfig.networkmode',
      `NetworkMode muss "${expectedNetwork}" sein, war "${net}". ` +
        `host, none und container:<id> sind nie zulässig.`,
    )
  }

  // --- Limits --------------------------------------------------------------
  const mem = hostConfig.Memory
  if (typeof mem !== 'number' || !Number.isInteger(mem) || mem <= 0) {
    fail('hostconfig.memory', 'Memory muss eine positive ganze Zahl (Bytes) sein')
  }
  const cpus = hostConfig.NanoCpus
  if (typeof cpus !== 'number' || !Number.isInteger(cpus) || cpus <= 0) {
    fail('hostconfig.nanocpus', 'NanoCpus muss eine positive ganze Zahl sein')
  }

  // --- RestartPolicy -------------------------------------------------------
  // "no" fuer Wegwerf-Container (Build): mit unless-stopped startete ein
  // beendeter Build endlos neu. "no" ist strikt weniger, nie mehr.
  const rp = hostConfig.RestartPolicy
  if (!isPlainObject(rp) || (rp.Name !== 'unless-stopped' && rp.Name !== 'no')) {
    fail('hostconfig.restartpolicy', 'RestartPolicy muss "unless-stopped" oder "no" sein')
  }
  for (const k of Object.keys(rp)) {
    if (k !== 'Name' && k !== 'MaximumRetryCount') {
      fail('hostconfig.restartpolicy', `Unerwartetes Feld "${k}" in RestartPolicy`)
    }
  }

  // --- LogConfig: feste Rotation ------------------------------------------
  const lc = hostConfig.LogConfig
  if (!isPlainObject(lc) || lc.Type !== 'json-file') {
    fail('hostconfig.logconfig', 'LogConfig muss Type "json-file" verwenden')
  }
  const lcc = lc.Config
  if (
    !isPlainObject(lcc) ||
    lcc['max-size'] !== REQUIRED_LOG_CONFIG.Config['max-size'] ||
    lcc['max-file'] !== REQUIRED_LOG_CONFIG.Config['max-file']
  ) {
    fail(
      'hostconfig.logconfig',
      'LogConfig muss max-size 10m und max-file 5 setzen (feste Rotation laut SPEC)',
    )
  }

  // --- SecurityOpt ---------------------------------------------------------
  const so = hostConfig.SecurityOpt
  if (!Array.isArray(so) || so.length !== REQUIRED_SECURITY_OPT.length ||
      !REQUIRED_SECURITY_OPT.every((v, i) => so[i] === v)) {
    fail(
      'hostconfig.securityopt',
      `SecurityOpt muss genau ${JSON.stringify(REQUIRED_SECURITY_OPT)} sein ` +
        `(kein seccomp=unconfined, kein apparmor=unconfined)`,
    )
  }

  // --- Mounts: nur benannte Volumes des Projekts ---------------------------
  if (hostConfig.Mounts !== undefined) {
    const mounts = hostConfig.Mounts
    if (!Array.isArray(mounts)) fail('hostconfig.mounts', 'Mounts muss ein Array sein')
    const volumePrefix = expectedNetwork + '_'
    for (const m of mounts) {
      if (!isPlainObject(m)) fail('hostconfig.mounts', 'Jeder Mount muss ein Objekt sein')
      if (m.Type !== 'volume') {
        fail(
          'hostconfig.mounts.type',
          `Mount-Typ "${String(m.Type)}" ist nicht erlaubt. In M1 sind nur benannte ` +
            `Volumes zulässig; bind-Mounts auf Host-Pfade werden grundsätzlich abgelehnt.`,
        )
      }
      const extra = opts.extraVolumes?.find((v) => v.name === m.Source)
      if (typeof m.Source !== 'string' || (!m.Source.startsWith(volumePrefix) && !extra)) {
        fail(
          'hostconfig.mounts.source',
          `Volume "${String(m.Source)}" gehört nicht zu diesem Projekt (erwartet: ${volumePrefix}*)`,
        )
      }
      if (extra?.readOnly && m.ReadOnly !== true) {
        fail('hostconfig.mounts.readonly', `Volume "${m.Source}" darf nur lesend eingehängt werden`)
      }
      if (typeof m.Target !== 'string' || !m.Target.startsWith('/')) {
        fail('hostconfig.mounts.target', 'Mount-Target muss ein absoluter Pfad sein')
      }
      for (const k of Object.keys(m)) {
        if (!['Type', 'Source', 'Target', 'ReadOnly'].includes(k)) {
          fail('hostconfig.mounts.field', `Unerwartetes Feld "${k}" in Mount`)
        }
      }
    }
  }
}

function assertNetworkingConfigPolicy(nc: unknown, expectedNetwork: string): void {
  if (!isPlainObject(nc)) fail('networkingconfig', 'NetworkingConfig muss ein Objekt sein')
  const keys = Object.keys(nc)
  if (keys.length !== 1 || keys[0] !== 'EndpointsConfig') {
    fail('networkingconfig', 'NetworkingConfig darf nur EndpointsConfig enthalten')
  }
  const ec = nc.EndpointsConfig
  if (!isPlainObject(ec)) fail('networkingconfig', 'EndpointsConfig muss ein Objekt sein')
  for (const name of Object.keys(ec)) {
    if (name !== expectedNetwork) {
      fail('networkingconfig', `Netzwerk "${name}" ist hier nicht erlaubt, nur "${expectedNetwork}"`)
    }
  }
}
