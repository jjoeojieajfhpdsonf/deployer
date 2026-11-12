import { parse, stringify } from 'yaml'
import { posix } from 'node:path'
import { AppError } from './errors.js'
import { LABEL, IMAGE_PREFIX, LEGACY_LABEL_NS, composeHomebentoLabels } from './names.js'

/**
 * Prüfung und Normalisierung einer compose.yaml.
 *
 * Die Compose-CLI geht an der Erlaubnisliste in drivers/policy.ts vorbei.
 * Diese Datei ist deshalb die Schranke für Compose: eine Erlaubnisliste pro
 * Dienst und auf oberster Ebene. Die CLI bekommt nie die Datei des Nutzers,
 * sondern nur das, was normalizeCompose() aus geprüften Werten neu schreibt.
 *
 * Reines Modul ohne Import von config.ts, damit es ohne Umgebung testbar ist.
 */

export interface ComposeContext {
  slug: string
  /** Kurzform der Deployment-ID, für eindeutige Image-Tags. */
  deploymentShort: string
  deploymentId: string
  webService: string
  /** Projekt-Netz air_<slug>; wird zum Standardnetz aller Dienste. */
  network: string
  memoryLimitMb: number
  cpuLimit: number
  /** Projekt-Env und Secrets, nur für den Web-Dienst. */
  projectEnv: Record<string, string>
  /**
   * Abgrenzung HomeBento: Projektname und Hauptadresse für die homebento.*-Labels
   * (Web-Dienst mit Adresse, übrige Dienste «Projekt · Dienst»). Fehlt es, bleiben
   * die Dienste ohne homebento.*-Labels (z. B. Prüfung beim Bearbeiten).
   */
  homebento?: { projectName: string; href: string | null }
  /** Mit Repo: Pfade auflösen (im Repo, ohne Symlinks). Ohne Repo: null. */
  repo: null | {
    resolvePath: (rel: string) => Promise<string>
    readFile: (rel: string) => Promise<string>
  }
}

export interface NormalizedCompose {
  /** Die Datei für die CLI. */
  yaml: string
  projectName: string
  webContainer: string
  services: string[]
  builtImages: string[]
  /** Etappe 4: Dienste mit eigener interner Adresse (x-airlock-internal), z. B. Adminer */
  internal: { service: string; port: number }[]
}

/**
 * Etappe 4 «Dienst hinzufügen»: zwei eigene Erweiterungen je Dienst.
 *
 *   x-airlock-env:      { POSTGRES_PASSWORD: DB_PASSWORD }
 *     Variable im Container ← Umgebungsvariable des Projekts (Name). Der Wert
 *     kommt erst beim Start dazu (materialize), nie in die Datei oder das
 *     Artefakt – so bekommen auch andere Dienste als der Web-Dienst geheime
 *     Werte, ohne dass ein Passwort in compose.yaml (oder im Git-Repo) steht.
 *   x-airlock-internal: 8080
 *     Der Dienst bekommt eine eigene Adresse <dienst>--<projekt>.<int-basis>,
 *     nur aus LAN und Tailnet (Adminer, Mailpit). Nie öffentlich.
 */
export const X_ENV = 'x-airlock-env'
export const X_INTERNAL = 'x-airlock-internal'

const fail = (field: string, msg: string): never => {
  throw new AppError('compose_rejected', `compose.yaml, ${field}: ${msg}`, 400, { field })
}

const SERVICE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/
const VOLUME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:]*(@sha256:[a-f0-9]{64})?$/
const MAX_SERVICES = 20

/** Begründung für die häufigsten abgelehnten Felder; unbekannte gelten trotzdem als abgelehnt. */
const WHY: Record<string, string> = {
  ports: 'veröffentlicht Host-Ports (auch "80" allein ergibt einen zufälligen Host-Port); der Verkehr läuft über Caddy',
  privileged: 'gibt dem Container Root-Rechte auf dem Host',
  cap_add: 'gibt dem Container zusätzliche Kernel-Rechte',
  devices: 'reicht Geräte des Hosts durch',
  network_mode: 'würde das Projekt-Netz verlassen (z.B. host)',
  networks: 'das Netz setzt Airlock selbst (air_<slug>)',
  pid: 'teilt Prozesse mit dem Host',
  ipc: 'teilt Speicher mit dem Host',
  uts: 'teilt den Hostnamen-Namensraum',
  userns_mode: 'schaltet die Benutzer-Isolation ab',
  security_opt: 'die Sicherheitsoptionen setzt Airlock selbst',
  sysctls: 'ändert Kernel-Parameter',
  cgroup_parent: 'verlässt die Ressourcen-Grenzen',
  cgroup: 'verlässt die Ressourcen-Grenzen',
  volumes_from: 'hängt fremde Volumes ein',
  extra_hosts: 'nicht nötig und umgeht DNS',
  configs: 'arbeitet mit Dateien des Hosts',
  secrets: 'arbeitet mit Dateien des Hosts; geheime Werte kommen aus den Umgebungsvariablen des Projekts',
  deploy: 'Grenzen kommen aus dem Projekt',
  mem_limit: 'Grenzen kommen aus dem Projekt',
  memswap_limit: 'Grenzen kommen aus dem Projekt',
  cpus: 'Grenzen kommen aus dem Projekt',
  cpu_shares: 'Grenzen kommen aus dem Projekt',
  logging: 'die Log-Rotation ist fest eingestellt',
  container_name: 'Namen vergibt Compose, sonst kollidieren Projekte',
  links: 'veraltet; Dienste finden sich über ihren Namen',
  external_links: 'würde Container ausserhalb des Projekts verbinden',
  extends: 'liest weitere Dateien oder Dienste',
  runtime: 'eine andere Container-Laufzeit ist nicht vorgesehen',
  group_add: 'fügt Gruppen hinzu',
  oom_kill_disable: 'schaltet den Speicherschutz ab',
  oom_score_adj: 'ändert den Speicherschutz',
  ulimits: 'ändert Prozessgrenzen',
  profiles: 'nicht unterstützt: jeder Dienst läuft',
  scale: 'nicht unterstützt',
  isolation: 'nicht unterstützt',
}

const SERVICE_KEYS = new Set([
  'image', 'build', 'command', 'entrypoint', 'working_dir', 'user', 'init',
  'stop_grace_period', 'stop_signal', 'labels', 'expose', 'healthcheck',
  'depends_on', 'environment', 'env_file', 'volumes', 'restart', 'hostname',
  'platform', 'pull_policy', 'read_only', 'shm_size', 'tmpfs', 'cap_drop',
])

const TOP_KEYS = new Set(['services', 'volumes', 'name', 'version'])

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Compose-Interpolation abschalten: "$" wird "$$" und bleibt wörtlich. */
function escapeDollars<T>(v: T): T {
  if (typeof v === 'string') return v.replace(/\$/g, '$$$$') as T
  if (Array.isArray(v)) return v.map(escapeDollars) as T
  if (isObj(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) out[k] = escapeDollars(val)
    return out as T
  }
  return v
}

function scalarToString(field: string, v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return fail(field, 'muss ein einfacher Wert sein')
}

function stringOrStringArray(field: string, v: unknown): string | string[] {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) return v.map(String)
  return fail(field, 'muss ein Text oder eine Liste von Texten sein')
}

/** Einfacher .env-Parser: KEY=VALUE, Kommentare, Anführungszeichen. */
export function parseDotenv(text: string, field: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) fail(field, `Zeile "${line.slice(0, 40)}" ist keine Zuweisung KEY=VALUE`)
    let value = m![2]!
    const q = value[0]
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, '')
    out[m![1]!] = value
  }
  return out
}

/**
 * environment in Mapping oder Liste. Einträge OHNE Wert lehnt die Prüfung ab:
 * Compose würde den Wert sonst aus der eigenen Umgebung nehmen – das ist die
 * Umgebung von Airlock mit Datenbank-URL und Passwörtern.
 */
function normalizeEnvironment(field: string, v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  const set = (k: string, val: string) => {
    if (!ENV_KEY_RE.test(k)) fail(field, `Name der Umgebungsvariable "${k}" ist ungültig`)
    out[k] = val
  }
  if (Array.isArray(v)) {
    for (const entry of v) {
      if (typeof entry !== 'string') fail(field, 'Listeneinträge müssen KEY=VALUE sein')
      const i = (entry as string).indexOf('=')
      if (i === -1) {
        fail(field, `"${entry}" hat keinen Wert; Compose nähme ihn aus der Umgebung von Airlock`)
      }
      set((entry as string).slice(0, i), (entry as string).slice(i + 1))
    }
  } else if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (val === null || val === undefined) {
        fail(field, `"${k}" hat keinen Wert; Compose nähme ihn aus der Umgebung von Airlock`)
      }
      set(k, scalarToString(`${field}.${k}`, val))
    }
  } else {
    fail(field, 'muss eine Zuordnung oder eine Liste sein')
  }
  return out
}

function normalizeLabels(field: string, v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  const set = (k: string, val: string) => {
    // Diese Labels steuern Aufräumen und Löschen bzw. Compose selbst.
    if (/^(airlock\.|deployer\.|com\.docker\.)/i.test(k)) fail(field, `Label "${k}" ist reserviert`)
    out[k] = val
  }
  if (Array.isArray(v)) {
    for (const e of v) {
      if (typeof e !== 'string') fail(field, 'Listeneinträge müssen KEY=VALUE sein')
      const i = (e as string).indexOf('=')
      set(i === -1 ? (e as string) : (e as string).slice(0, i), i === -1 ? '' : (e as string).slice(i + 1))
    }
  } else if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) set(k, val === null ? '' : scalarToString(`${field}.${k}`, val))
  } else {
    fail(field, 'muss eine Zuordnung oder eine Liste sein')
  }
  return out
}

function normalizeServiceVolumes(field: string, v: unknown, declared: Set<string>): unknown[] {
  if (!Array.isArray(v)) return fail(field, 'muss eine Liste sein')
  const out: unknown[] = []
  for (const entry of v) {
    if (typeof entry === 'string') {
      const parts = entry.split(':')
      if (parts.length === 1) {
        // Anonymes Volume: "/var/lib/data"
        if (!entry.startsWith('/')) fail(field, `"${entry}" ist kein gültiger Container-Pfad`)
        out.push(entry)
        continue
      }
      const [source, target, mode] = parts
      if (!source || /^[./~]/.test(source) || source.includes('/')) {
        fail(field, `"${entry}" ist ein Bind-Mount. Nur benannte Volumes sind erlaubt; Dateien gehören ins Image`)
      }
      if (!VOLUME_RE.test(source!)) fail(field, `Volume-Name "${source}" ist ungültig`)
      if (!declared.has(source!)) fail(field, `Volume "${source}" ist oben unter volumes nicht deklariert`)
      if (!target || !target.startsWith('/')) fail(field, `"${entry}" braucht einen absoluten Container-Pfad`)
      if (mode !== undefined && mode !== 'ro' && mode !== 'rw') fail(field, `Modus "${mode}" ist nicht erlaubt`)
      if (parts.length > 3) fail(field, `"${entry}" hat zu viele Teile`)
      out.push(entry)
    } else if (isObj(entry)) {
      for (const k of Object.keys(entry)) {
        if (!['type', 'source', 'target', 'read_only'].includes(k)) fail(field, `Feld "${k}" im Volume ist nicht erlaubt`)
      }
      if (entry.type !== 'volume') {
        fail(field, `Typ "${String(entry.type)}" ist nicht erlaubt. Nur benannte Volumes (type: volume)`)
      }
      if (typeof entry.source !== 'string' || !VOLUME_RE.test(entry.source) || !declared.has(entry.source)) {
        fail(field, `Volume "${String(entry.source)}" ist ungültig oder nicht deklariert`)
      }
      if (typeof entry.target !== 'string' || !entry.target.startsWith('/')) {
        fail(field, 'target muss ein absoluter Container-Pfad sein')
      }
      out.push({ type: 'volume', source: entry.source, target: entry.target, read_only: entry.read_only === true })
    } else {
      fail(field, 'Einträge müssen Text oder Zuordnung sein')
    }
  }
  return out
}

function normalizeRestart(field: string, v: unknown): string {
  if (v === undefined || v === 'always' || v === 'unless-stopped') return 'unless-stopped'
  if (v === 'no' || v === false) return 'no'
  if (typeof v === 'string' && /^on-failure(:\d{1,3})?$/.test(v)) return v
  return fail(field, 'erlaubt sind no, on-failure, unless-stopped, always')
}

/**
 * Setzt die Projekt-Env in den Web-Dienst einer bereits normalisierten Datei.
 *
 * Getrennt vom Normalisieren, weil die normalisierte Datei als Artefakt für
 * Rollbacks aufbewahrt wird und dort keine Secrets im Klartext liegen sollen.
 * Die Datei mit Env existiert nur für die Dauer von `compose up`.
 */
export function withServiceEnv(normalizedYaml: string, service: string, env: Record<string, string>): string {
  const doc = parse(normalizedYaml) as { services?: Record<string, { environment?: Record<string, string> }> }
  const svc = doc.services?.[service]
  if (!svc) throw new AppError('compose_rejected', `Dienst "${service}" fehlt in der normalisierten Datei`, 500)
  for (const k of Object.keys(env)) {
    if (!ENV_KEY_RE.test(k)) throw new AppError('compose_rejected', `Name der Umgebungsvariable "${k}" ist ungültig`, 400)
  }
  svc.environment = { ...(svc.environment ?? {}), ...escapeDollars(env) }
  return `${HEADER}${stringify(doc)}`
}

const HEADER = '# Erzeugt von Airlock aus geprüften Werten. Nicht von Hand ändern.\n'

/**
 * Übergang (docs/RENAME.md): Eine aufbewahrte normalisierte Datei aus der
 * deployer-Zeit trägt noch `name: dep_<slug>`, das Netz dep_<slug> und
 * `deployer.*`-Labels. Für Rollback und Rückfall auf das aktuelle Projekt-Netz
 * und die neuen Labels umschreiben. Dateien, die schon stimmen, bleiben gleich.
 * Nur eigene Felder (name, networks, Labels) – der Rest war schon geprüft.
 */
export function retargetCompose(normalizedYaml: string, network: string): string {
  const doc = parse(normalizedYaml) as {
    name?: string
    services?: Record<string, { labels?: Record<string, string> }>
    networks?: Record<string, unknown>
  }
  doc.name = network
  doc.networks = { default: { name: network, external: true } }
  const prefix = `${LEGACY_LABEL_NS}.`
  for (const svc of Object.values(doc.services ?? {})) {
    if (!svc.labels) continue
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(svc.labels)) {
      out[k.startsWith(prefix) ? `airlock.${k.slice(prefix.length)}` : k] = v
    }
    svc.labels = out
  }
  return `${HEADER}${stringify(doc)}`
}

/** Name des Web-Containers, den Compose für ein Projekt vergibt. */
export const composeWebContainer = (projectName: string, webService: string): string => `${projectName}-${webService}-1`

export function imageTagFor(slug: string, service: string, short: string): string {
  const svc = service.toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  return `${IMAGE_PREFIX}${slug}-${svc}:${short}`
}

export async function normalizeCompose(text: string, ctx: ComposeContext): Promise<NormalizedCompose> {
  let doc: unknown
  try {
    doc = parse(text, { maxAliasCount: 50, merge: true, prettyErrors: false })
  } catch (err) {
    throw new AppError('compose_rejected', `compose.yaml ist kein gültiges YAML: ${(err as Error).message}`, 400)
  }
  if (!isObj(doc)) fail('Datei', 'muss eine Zuordnung mit services sein')

  for (const k of Object.keys(doc as Record<string, unknown>)) {
    if (k.startsWith('x-')) continue
    if (!TOP_KEYS.has(k)) {
      fail(k, k === 'include'
        ? 'liest weitere Dateien und ist nicht erlaubt'
        : k === 'networks' ? 'das Netz setzt Airlock selbst' : 'ist auf oberster Ebene nicht erlaubt (Erlaubnisliste)')
    }
  }
  const root = doc as Record<string, unknown>

  /* --- Volumes ------------------------------------------------------------ */
  const declared = new Set<string>()
  const topVolumes: Record<string, unknown> = {}
  if (root.volumes !== undefined && root.volumes !== null) {
    if (!isObj(root.volumes)) fail('volumes', 'muss eine Zuordnung sein')
    for (const [name, def] of Object.entries(root.volumes as Record<string, unknown>)) {
      if (!VOLUME_RE.test(name)) fail(`volumes.${name}`, 'Name ist ungültig')
      if (def !== null && def !== undefined) {
        if (!isObj(def)) fail(`volumes.${name}`, 'muss leer oder eine Zuordnung sein')
        for (const k of Object.keys(def as Record<string, unknown>)) {
          // driver_opts {type: none, o: bind, device: /} wäre ein Bind-Mount
          // durch die Hintertür; name/external zeigten auf fremde Volumes.
          if (k !== 'labels') {
            fail(`volumes.${name}.${k}`, k === 'name' || k === 'external'
              ? 'würde auf ein Volume ausserhalb des Projekts zeigen'
              : 'ist nicht erlaubt; Volumes sind immer lokal und gehören dem Projekt')
          }
        }
      }
      declared.add(name)
      topVolumes[name] = {}
    }
  }

  /* --- Dienste -------------------------------------------------------------- */
  if (!isObj(root.services) || Object.keys(root.services).length === 0) {
    fail('services', 'fehlt oder ist leer')
  }
  const servicesIn = root.services as Record<string, unknown>
  const names = Object.keys(servicesIn)
  if (names.length > MAX_SERVICES) fail('services', `höchstens ${MAX_SERVICES} Dienste`)
  for (const n of names) if (!SERVICE_RE.test(n)) fail(`services.${n}`, 'Dienstname ist ungültig')
  if (!names.includes(ctx.webService)) {
    fail('services', `der Web-Dienst "${ctx.webService}" fehlt (vorhanden: ${names.join(', ')})`)
  }

  const servicesOut: Record<string, unknown> = {}
  const builtImages: string[] = []
  const internal: { service: string; port: number }[] = []

  for (const name of names) {
    const f = `services.${name}`
    const svc = servicesIn[name]
    if (!isObj(svc)) fail(f, 'muss eine Zuordnung sein')
    const s = svc as Record<string, unknown>

    for (const k of Object.keys(s)) {
      if (k.startsWith('x-')) continue
      if (!SERVICE_KEYS.has(k)) {
        fail(`${f}.${k}`, WHY[k] ? `nicht erlaubt: ${WHY[k]}` : 'nicht erlaubt (Erlaubnisliste)')
      }
    }

    const out: Record<string, unknown> = {}

    // image / build
    if (s.build !== undefined) {
      if (!ctx.repo) fail(`${f}.build`, 'geht nur mit einem Repo, nicht mit einer hochgeladenen compose.yaml')
      const b = typeof s.build === 'string' ? { context: s.build } : s.build
      if (!isObj(b)) fail(`${f}.build`, 'muss ein Pfad oder eine Zuordnung sein')
      for (const k of Object.keys(b as Record<string, unknown>)) {
        if (!['context', 'dockerfile', 'args', 'target'].includes(k)) {
          fail(`${f}.build.${k}`, 'nicht erlaubt (nur context, dockerfile, args, target)')
        }
      }
      const bb = b as Record<string, unknown>
      const contextRel = typeof bb.context === 'string' ? bb.context : '.'
      const context = await ctx.repo!.resolvePath(contextRel)
      const build: Record<string, unknown> = { context }
      if (bb.dockerfile !== undefined) {
        const df = bb.dockerfile
        // Nur relative Pfade. Ein absoluter Pfad wie /proc/1/environ würde
        // sonst – an den Kontext gehängt – die Repo-Prüfung bestehen und
        // danach unverändert an Compose gehen, das ihn aus dem Airlock-
        // Container liest.
        if (typeof df !== 'string' || df === '' || /^[/\\~]/.test(df) || df.includes('\0') || df.includes('\\')) {
          fail(`${f}.build.dockerfile`, 'muss ein relativer Pfad im Build-Kontext sein')
        }
        const joined = contextRel === '.' ? (df as string) : `${contextRel}/${df as string}`
        const resolved = await ctx.repo!.resolvePath(joined)
        // In die Ausgabe kommt nur, was geprüft wurde: der Pfad, neu
        // berechnet aus den beiden aufgelösten absoluten Pfaden.
        const rel = posix.relative(context, resolved)
        if (rel === '' || rel.startsWith('..') || posix.isAbsolute(rel)) {
          fail(`${f}.build.dockerfile`, 'muss innerhalb des Build-Kontexts liegen')
        }
        build.dockerfile = rel
      }
      if (bb.args !== undefined) build.args = normalizeEnvironment(`${f}.build.args`, bb.args)
      if (bb.target !== undefined) build.target = scalarToString(`${f}.build.target`, bb.target)
      // Nacht 3, Etappe 3: gebaute Images tragen das Airlock-Label (Aufräumen fasst nur Images mit
      // Label an). Nur Labels, die die Container ohnehin haben – kein airlock.deployment.
      build.labels = { [LABEL.managed]: 'true', [LABEL.project]: ctx.slug }
      out.build = build
      const tag = imageTagFor(ctx.slug, name, ctx.deploymentShort)
      out.image = tag
      builtImages.push(tag)
    } else {
      if (typeof s.image !== 'string' || !IMAGE_RE.test(s.image)) {
        fail(`${f}.image`, 'fehlt oder ist keine gültige Image-Referenz')
      }
      out.image = s.image
    }

    for (const k of ['command', 'entrypoint'] as const) {
      if (s[k] !== undefined) out[k] = stringOrStringArray(`${f}.${k}`, s[k])
    }
    for (const k of ['working_dir', 'user', 'hostname', 'stop_grace_period', 'stop_signal', 'platform', 'pull_policy', 'shm_size'] as const) {
      if (s[k] !== undefined) out[k] = scalarToString(`${f}.${k}`, s[k])
    }
    if (s.working_dir !== undefined && !String(s.working_dir).startsWith('/')) {
      fail(`${f}.working_dir`, 'muss ein absoluter Pfad sein')
    }
    if (s.init !== undefined) out.init = s.init === true
    if (s.read_only !== undefined) out.read_only = s.read_only === true
    if (s.tmpfs !== undefined) out.tmpfs = stringOrStringArray(`${f}.tmpfs`, s.tmpfs)
    if (s.cap_drop !== undefined) out.cap_drop = stringOrStringArray(`${f}.cap_drop`, s.cap_drop)
    if (s.expose !== undefined) {
      if (!Array.isArray(s.expose)) fail(`${f}.expose`, 'muss eine Liste sein')
      out.expose = (s.expose as unknown[]).map((e) => scalarToString(`${f}.expose`, e))
    }
    if (s.healthcheck !== undefined) {
      if (!isObj(s.healthcheck)) fail(`${f}.healthcheck`, 'muss eine Zuordnung sein')
      const hc = s.healthcheck as Record<string, unknown>
      for (const k of Object.keys(hc)) {
        if (!['test', 'interval', 'timeout', 'retries', 'start_period', 'start_interval', 'disable'].includes(k)) {
          fail(`${f}.healthcheck.${k}`, 'nicht erlaubt')
        }
      }
      out.healthcheck = hc
    }
    if (s.depends_on !== undefined) {
      const deps = Array.isArray(s.depends_on) ? s.depends_on : isObj(s.depends_on) ? Object.keys(s.depends_on) : null
      if (!deps) fail(`${f}.depends_on`, 'muss eine Liste oder Zuordnung sein')
      for (const d of deps as unknown[]) {
        if (typeof d !== 'string' || !names.includes(d)) fail(`${f}.depends_on`, `Dienst "${String(d)}" gibt es nicht`)
      }
      out.depends_on = s.depends_on
    }

    // Umgebung: env_file (nur aus dem Repo, Inhalt wird übernommen), dann environment.
    let env: Record<string, string> = {}
    if (s.env_file !== undefined) {
      if (!ctx.repo) fail(`${f}.env_file`, 'geht nur mit einem Repo')
      const list = Array.isArray(s.env_file) ? s.env_file : [s.env_file]
      for (const item of list) {
        const p = typeof item === 'string' ? item : isObj(item) && typeof item.path === 'string' ? item.path : null
        if (p === null) fail(`${f}.env_file`, 'Einträge müssen Pfade sein')
        env = { ...env, ...parseDotenv(await ctx.repo!.readFile(p!), `${f}.env_file`) }
      }
    }
    if (s.environment !== undefined) env = { ...env, ...normalizeEnvironment(`${f}.environment`, s.environment) }
    if (name === ctx.webService) env = { ...env, ...ctx.projectEnv }
    if (Object.keys(env).length) out.environment = env

    if (s.volumes !== undefined) out.volumes = normalizeServiceVolumes(`${f}.volumes`, s.volumes, declared)

    const userLabels = s.labels !== undefined ? normalizeLabels(`${f}.labels`, s.labels) : {}

    // Etappe 4: eigene Erweiterungen (nur Namen und eine Portnummer, keine Werte)
    const ext: Record<string, unknown> = {}
    if (s[X_ENV] !== undefined) ext[X_ENV] = normalizeEnvMap(`${f}.${X_ENV}`, s[X_ENV])
    if (s[X_INTERNAL] !== undefined) {
      if (name === ctx.webService) fail(`${f}.${X_INTERNAL}`, 'der Web-Dienst hat schon die Adressen des Projekts')
      const port = Number(s[X_INTERNAL])
      if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`${f}.${X_INTERNAL}`, 'muss eine Portnummer sein (1–65535)')
      ext[X_INTERNAL] = port
      internal.push({ service: name, port })
    }

    // Ab hier nur noch eigene Werte: "$" maskieren, bevor sie dazukommen.
    const escaped = escapeDollars(out)
    const restart = normalizeRestart(`${f}.restart`, s.restart)
    servicesOut[name] = {
      ...escaped,
      ...ext,
      labels: {
        // HomeBento: Vorschlag von Airlock; eigene homebento.*-Labels in der Datei gewinnen.
        // Ändert sich Name oder Adresse, erzeugt Compose den Dienst beim nächsten Deploy neu (Volumes bleiben).
        ...(ctx.homebento ? escapeDollars(composeHomebentoLabels({
          projectName: ctx.homebento.projectName,
          service: name,
          webService: ctx.webService,
          href: ctx.homebento.href,
          image: typeof s.image === 'string' ? s.image : null,
        })) : {}),
        ...escapeDollars(userLabels),
        [LABEL.managed]: 'true',
        [LABEL.project]: ctx.slug,
        // Bewusst KEIN airlock.deployment: ein geändertes Label lässt Compose
        // den Container neu erzeugen – bei jedem Deploy auch die Datenbank.
        [LABEL.composeService]: name,
        // Start und Abgleich starten nur Dienste, die dauerhaft laufen sollen;
        // ein Einmal-Dienst (Migration, Seed) mit "no" bleibt beendet.
        [LABEL.composeRestart]: restart,
      },
      restart,
      logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '5' } },
      mem_limit: `${ctx.memoryLimitMb}m`,
      cpus: ctx.cpuLimit,
      security_opt: ['no-new-privileges:true'],
    }
  }

  const projectName = ctx.network // air_<slug>
  const normalized = {
    name: projectName,
    services: servicesOut,
    ...(Object.keys(topVolumes).length ? { volumes: topVolumes } : {}),
    // Standardnetz aller Dienste ist das Projekt-Netz, das Airlock anlegt.
    networks: { default: { name: ctx.network, external: true } },
  }

  return {
    yaml: `${HEADER}${stringify(normalized)}`,
    projectName,
    webContainer: composeWebContainer(projectName, ctx.webService),
    services: names,
    builtImages,
    internal,
  }
}

/** x-airlock-env: Zuordnung Variable im Container → Umgebungsvariable des Projekts (beides gültige Namen) */
function normalizeEnvMap(field: string, v: unknown): Record<string, string> {
  if (!isObj(v)) return fail(field, 'muss eine Zuordnung VARIABLE: PROJEKT_VARIABLE sein')
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (!ENV_KEY_RE.test(k)) fail(field, `Name der Umgebungsvariable "${k}" ist ungültig`)
    if (typeof val !== 'string' || !ENV_KEY_RE.test(val)) fail(`${field}.${k}`, 'muss der Name einer Umgebungsvariable des Projekts sein')
    out[k] = val as string
  }
  return out
}

/**
 * Etappe 4: Werte für x-airlock-env einsetzen (alle Dienste) und die eigenen
 * Erweiterungen aus der Datei für `compose up` entfernen. Fehlt eine
 * Variable im Projekt, scheitert der Start mit einer klaren Meldung statt
 * mit einem leeren Passwort.
 */
export function withMappedEnv(normalizedYaml: string, env: Record<string, string>): string {
  const doc = parse(normalizedYaml) as { services?: Record<string, Record<string, unknown>> }
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    const map = svc[X_ENV]
    if (isObj(map)) {
      const add: Record<string, string> = {}
      for (const [inner, projectVar] of Object.entries(map)) {
        if (typeof projectVar !== 'string' || !(projectVar in env)) {
          throw new AppError('compose_env_missing', `Dienst "${name}" braucht die Umgebungsvariable ${String(projectVar)}; sie fehlt im Projekt (Einstellungen › Umgebungsvariablen)`, 400)
        }
        add[inner] = env[projectVar]!
      }
      svc.environment = { ...((svc.environment as Record<string, string> | undefined) ?? {}), ...escapeDollars(add) }
    }
    delete svc[X_ENV]
    delete svc[X_INTERNAL]
  }
  return `${HEADER}${stringify(doc)}`
}
