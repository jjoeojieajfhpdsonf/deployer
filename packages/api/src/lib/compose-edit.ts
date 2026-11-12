import { createHash, randomBytes } from 'node:crypto'
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap } from 'yaml'
import { GARAGE_BUCKET, serviceTemplate, type AddServiceInput, type RemoveServiceInput, type ServiceTemplateId } from '@airlock/shared'
import { badRequest } from './errors.js'
import { X_ENV, X_INTERNAL, normalizeCompose } from './compose.js'

/**
 * Etappe 4 «Dienst hinzufügen/entfernen»: ändert die compose.yaml des
 * Nutzers (nicht die normalisierte Datei). Rein: kein config.ts, keine
 * Datenbank – Passwörter und bestehende Variablen kommen von aussen.
 *
 * Bearbeitet wird das YAML-Dokument (Kommentare, Reihenfolge und Schreibweise
 * des Nutzers bleiben). Passwörter stehen nie in der Datei: der Dienst
 * bekommt sie über x-airlock-env aus einer geheimen Variable des Projekts.
 * Danach geht die ganze Datei durch dieselbe Prüfung wie jeder Deploy
 * (normalizeCompose) – was dort scheitern würde, kommt gar nicht erst in
 * eine Vorschau.
 */

export interface PlannedVariable {
  key: string
  secret: boolean
  /** Klartext – verlässt den Server nie (die Vorschau zeigt nur Namen) */
  value: string
  state: 'new' | 'reuse'
  purpose: string
}

export interface EditContext {
  /** Dienst mit den Routen (bekommt alle Variablen des Projekts) */
  webService: string
  /** Bestehende Umgebungsvariablen des Projekts (entschlüsselt, nur serverseitig) */
  env: Record<string, string>
  /** Erzeugt ein Passwort (Tests: fest) */
  password?: () => string
  /** Kurzname des Projekts (für den Hinweis auf die interne Adresse) */
  slug?: string
}

export interface AddResult {
  text: string
  variables: PlannedVariable[]
  notes: string[]
  volume: string | null
  /** Bekommt eine eigene interne Adresse */
  internal: boolean
}

export interface RemoveResult {
  text: string
  /** Dienste, deren depends_on angepasst wurde */
  dependents: string[]
  /** Volumes, die nur dieser Dienst nutzte */
  volumes: string[]
  /** Davon aus der Datei entfernt (dropVolume) */
  dropped: string[]
  notes: string[]
}

/** 32 Zeichen aus A–Z, a–z, 0–9, - und _: passt ohne Maskieren in jede Verbindungs-URL */
export const newPassword = (): string => randomBytes(24).toString('base64url')

/** Stand einer Datei für «Übernehmen nur auf der Vorschau» */
export const composeBase = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32)

/** «db» → «DB», «cache-2» → «CACHE_2» (Präfix der Variablen) */
export const varPrefix = (name: string): string => name.toUpperCase().replace(/[^A-Z0-9]/g, '_')

const fieldError = (path: string, message: string) => badRequest(message, [{ path, message }])

function load(text: string): Document {
  // Alias-Bomben fängt die Prüfung danach ab (normalizeCompose, maxAliasCount)
  const doc = parseDocument(text, { merge: true, prettyErrors: false })
  if (doc.errors.length) throw badRequest(`compose.yaml ist kein gültiges YAML: ${doc.errors[0]!.message}`)
  if (!isMap(doc.contents) || !isMap(doc.get('services'))) throw badRequest('compose.yaml hat keine Dienste (services)')
  return doc
}

/** Ohne Umbruch langer Zeilen und ohne Leerzeichen in [a, b] – sonst änderte sich die Schreibweise des Nutzers */
const dump = (doc: Document): string => doc.toString({ lineWidth: 0, flowCollectionPadding: false })

const servicesOf = (doc: Document): YAMLMap => doc.get('services') as YAMLMap

const keysOf = (m: unknown): string[] => (isMap(m) ? m.items.map((p) => String(isScalar(p.key) ? p.key.value : p.key)) : [])

/** Benannte Volumes eines Dienstes (Kurz- und Langform) */
function volumesOfService(svc: unknown): string[] {
  if (!isMap(svc)) return []
  const list = svc.get('volumes')
  if (!isSeq(list)) return []
  const out: string[] = []
  for (const item of list.items) {
    if (isScalar(item) && typeof item.value === 'string') {
      const [source, target] = item.value.split(':')
      if (source && target && !source.startsWith('/') && !source.startsWith('.')) out.push(source)
    } else if (isMap(item)) {
      const s = item.get('source')
      if (typeof s === 'string') out.push(s)
    }
  }
  return out
}

/** Dienstnamen und welche Volumes wer nutzt (für Dialog und Prüfungen) */
export function readCompose(text: string): { services: string[]; volumes: string[]; mounts: Record<string, string[]> } {
  const doc = load(text)
  const svcs = servicesOf(doc)
  const services = keysOf(svcs)
  return { services, volumes: keysOf(doc.get('volumes')), mounts: Object.fromEntries(services.map((n) => [n, volumesOfService(svcs.get(n))])) }
}

/** depends_on um einen Dienst ergänzen (Liste oder Zuordnung, wie im Dienst schon geschrieben) */
function addDependsOn(doc: Document, service: string, on: string): void {
  const svc = servicesOf(doc).get(service)
  if (!isMap(svc)) return
  const dep = svc.get('depends_on')
  if (isSeq(dep)) {
    if (!dep.items.some((i) => isScalar(i) && i.value === on)) dep.add(doc.createNode(on))
  } else if (isMap(dep)) {
    if (!dep.has(on)) dep.set(on, doc.createNode({ condition: 'service_started' }))
  } else {
    svc.set('depends_on', doc.createNode([on]))
  }
}

/** x-airlock-env eines bestehenden Dienstes ergänzen */
function addEnvMap(doc: Document, service: string, entries: Record<string, string>): void {
  const svc = servicesOf(doc).get(service)
  if (!isMap(svc)) return
  const m = svc.get(X_ENV)
  if (isMap(m)) for (const [k, v] of Object.entries(entries)) m.set(k, v)
  else svc.set(X_ENV, doc.createNode(entries))
}

interface Built {
  service: Record<string, unknown>
  /** Hilfs-Dienste (Name → Inhalt), hängen dasselbe Volume ein und gehen mit dem Dienst (Garage: <name>-init) */
  helpers?: Record<string, Record<string, unknown>>
  /** Pfad des Volumes im Container (null: keins) */
  mountPath: string | null
  /** Projekt-Variablen mit Passwort: Name → Zweck; gen für ein festes Format (sonst newPassword) */
  passwords: { key: string; purpose: string; gen?: () => string }[]
  /** Verbindung, sobald die Passwörter feststehen */
  connection: (pw: Record<string, string>) => { key: string; secret: boolean; value: string }[]
}

/* --- Garage: Konfiguration ohne Geheimnisse, ein Knoten ------------------------------- */

const GARAGE_DIR = '/var/lib/garage'
const GARAGE_INIT_IMAGE = 'busybox:1.37'
/** Einmal-Dienst, der die garage.toml schreibt */
export const garageInitName = (service: string): string => `${service}-init`
const GARAGE_TOML = [
  `metadata_dir = "${GARAGE_DIR}/meta"`,
  `data_dir = "${GARAGE_DIR}/data"`,
  'db_engine = "sqlite"',
  'replication_factor = 1',
  'rpc_bind_addr = "[::]:3901"',
  'rpc_public_addr = "127.0.0.1:3901"',
  '',
  '[s3_api]',
  's3_region = "garage"',
  'api_bind_addr = "[::]:3900"',
  '',
  '[admin]',
  'api_bind_addr = "[::]:3903"',
  '',
].join('\n')

/** Inhalt des neuen Dienstes je Vorlage */
function build(t: ServiceTemplateId, i: AddServiceInput, o: { databases: string[] }): Built {
  const tpl = serviceTemplate(t)
  const version = i.version || tpl.versions[0] || 'latest'
  const image = tpl.image ? `${tpl.image}:${version}` : i.image!
  const n = i.name
  const P = varPrefix(n)
  const pwKey = `${P}_PASSWORD`
  const conn = (c: { key: string; secret: boolean }, idx: number) => (idx === 0 && i.connectionVar ? i.connectionVar : c.key)
  const named = (values: string[]) => tpl.connection.map((c, idx) => ({ key: conn(c, idx), secret: c.secret, value: values[idx]! }))
  switch (t) {
    case 'postgres': {
      // Ab PostgreSQL 18 liegen die Daten unter /var/lib/postgresql/<version>/docker
      const major = Number.parseInt(version, 10)
      return {
        service: {
          image,
          environment: { POSTGRES_USER: 'app', POSTGRES_DB: 'app' },
          [X_ENV]: { POSTGRES_PASSWORD: pwKey },
          healthcheck: { test: ['CMD-SHELL', 'pg_isready -U app -d app'], interval: '10s', timeout: '5s', retries: 5 },
        },
        mountPath: Number.isFinite(major) && major >= 18 ? '/var/lib/postgresql' : '/var/lib/postgresql/data',
        passwords: [{ key: pwKey, purpose: `Passwort von ${n}` }],
        connection: (pw) => named([`postgres://app:${pw[pwKey]}@${n}:5432/app`]),
      }
    }
    case 'mariadb': {
      const rootKey = `${P}_ROOT_PASSWORD`
      return {
        service: {
          image,
          environment: { MARIADB_USER: 'app', MARIADB_DATABASE: 'app' },
          [X_ENV]: { MARIADB_PASSWORD: pwKey, MARIADB_ROOT_PASSWORD: rootKey },
          healthcheck: { test: ['CMD', 'healthcheck.sh', '--connect', '--innodb_initialized'], interval: '10s', timeout: '5s', retries: 5 },
        },
        mountPath: '/var/lib/mysql',
        passwords: [{ key: pwKey, purpose: `Passwort von ${n}` }, { key: rootKey, purpose: `Root-Passwort von ${n}` }],
        connection: (pw) => named([`mysql://app:${pw[pwKey]}@${n}:3306/app`]),
      }
    }
    case 'redis':
      return {
        service: {
          image,
          // "$" bleibt in Airlock wörtlich (keine Interpolation); die Shell im Container setzt das Passwort ein
          command: ['sh', '-c', 'exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"'],
          [X_ENV]: { REDIS_PASSWORD: pwKey },
          healthcheck: { test: ['CMD-SHELL', 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping | grep -q PONG'], interval: '10s', timeout: '5s', retries: 5 },
        },
        mountPath: '/data',
        passwords: [{ key: pwKey, purpose: `Passwort von ${n}` }],
        connection: (pw) => named([`redis://:${pw[pwKey]}@${n}:6379/0`]),
      }
    case 'mongo':
      return {
        service: {
          image,
          environment: { MONGO_INITDB_ROOT_USERNAME: 'app' },
          [X_ENV]: { MONGO_INITDB_ROOT_PASSWORD: pwKey },
        },
        mountPath: '/data/db',
        passwords: [{ key: pwKey, purpose: `Passwort von ${n}` }],
        connection: (pw) => named([`mongodb://app:${pw[pwKey]}@${n}:27017/?authSource=admin`]),
      }
    case 'garage': {
      // Das Image hat keine Shell und Garage startet nicht ohne garage.toml; configs: lässt Airlock
      // nicht zu. Ein Einmal-Dienst (busybox) schreibt die Datei ins Volume – ohne Geheimnisse,
      // die kommen über x-airlock-env (GARAGE_RPC_SECRET, GARAGE_ADMIN_TOKEN, Standard-Schlüssel).
      const k = { rpc: `${P}_RPC_SECRET`, admin: `${P}_ADMIN_TOKEN`, access: `${P}_ACCESS_KEY`, secret: `${P}_SECRET_KEY` }
      const init = garageInitName(n)
      return {
        service: {
          image,
          command: ['/garage', 'server', '--single-node', '--default-bucket'],
          environment: { GARAGE_CONFIG_FILE: `${GARAGE_DIR}/garage.toml`, GARAGE_DEFAULT_BUCKET: GARAGE_BUCKET },
          [X_ENV]: { GARAGE_RPC_SECRET: k.rpc, GARAGE_ADMIN_TOKEN: k.admin, GARAGE_DEFAULT_ACCESS_KEY: k.access, GARAGE_DEFAULT_SECRET_KEY: k.secret },
          depends_on: { [init]: { condition: 'service_completed_successfully' } },
          [X_INTERNAL]: 3903,
        },
        helpers: {
          [init]: {
            image: GARAGE_INIT_IMAGE,
            // "$" bleibt in Airlock wörtlich; die Shell im Container setzt die Datei aus der Variable ein
            // Ohne \n im Befehl: das würde beim Normalisieren zu einem echten Umbruch (die TOML endet schon mit einem)
            command: ['sh', '-c', `printf '%s' "$GARAGE_TOML" > ${GARAGE_DIR}/garage.toml`],
            environment: { GARAGE_TOML: GARAGE_TOML },
            restart: 'no',
          },
        },
        mountPath: GARAGE_DIR,
        passwords: [
          { key: k.access, purpose: `Zugriffsschlüssel von ${n}`, gen: () => `GK${randomBytes(12).toString('hex')}` },
          { key: k.secret, purpose: `Geheimer Schlüssel von ${n}`, gen: () => randomBytes(32).toString('hex') },
          { key: k.rpc, purpose: `RPC-Geheimnis von ${n}`, gen: () => randomBytes(32).toString('hex') },
          { key: k.admin, purpose: `Token der Admin-API von ${n}` },
        ],
        connection: (pw) => named([`http://${n}:3900`, pw[k.access]!, pw[k.secret]!, 'garage', GARAGE_BUCKET]),
      }
    }
    case 'mailpit':
      return {
        service: {
          image,
          ...(i.volume ? { environment: { MP_DATABASE: '/data/mailpit.db' } } : {}),
          [X_INTERNAL]: 8025,
        },
        mountPath: '/data',
        passwords: [],
        connection: () => named([`smtp://${n}:1025`]),
      }
    case 'adminer':
      return {
        service: {
          image,
          // Anmeldemaske zeigt gleich die erste Datenbank des Projekts
          ...(o.databases[0] ? { environment: { ADMINER_DEFAULT_SERVER: o.databases[0] } } : {}),
          [X_INTERNAL]: 8080,
        },
        mountPath: null,
        passwords: [],
        connection: () => [],
      }
    case 'custom':
      return {
        service: { image, ...(i.port ? { expose: [String(i.port)] } : {}) },
        mountPath: i.volumePath ?? null,
        passwords: [],
        connection: () => [],
      }
  }
}

/** Datenbank-Dienste der Datei (für Adminer) – am Image erkannt */
function databaseServices(doc: Document): string[] {
  const svcs = servicesOf(doc)
  return keysOf(svcs).filter((n) => {
    const img = (svcs.get(n) as YAMLMap | undefined)?.get?.('image')
    return typeof img === 'string' && /(^|\/)(postgres|mysql|mariadb|mongo)[^/]*$/.test(img.split(':')[0]!)
  })
}

/**
 * Neuen Dienst in die compose.yaml eintragen. Prüft Name, Version und
 * Verbindungen gegen die Datei und die Variablen des Projekts; danach die
 * ganze Datei gegen die Compose-Regeln.
 */
export async function addService(text: string, i: AddServiceInput, ctx: EditContext): Promise<AddResult> {
  const doc = load(text)
  const svcs = servicesOf(doc)
  const existing = keysOf(svcs)
  const tpl = serviceTemplate(i.template)
  if (existing.includes(i.name)) throw fieldError('name', `Einen Dienst «${i.name}» gibt es schon`)
  if (existing.length >= 20) throw badRequest('Höchstens 20 Dienste pro Projekt')
  if (i.template === 'custom' && !i.image) throw fieldError('image', 'Gib ein Image an, z. B. ghcr.io/me/worker:1.4')
  if (i.template === 'custom' && i.volume && !i.volumePath) throw fieldError('volumePath', 'Wo liegen die Daten im Container? z. B. /data')
  const connect = [...new Set(i.connect)]
  for (const c of connect) if (!existing.includes(c)) throw fieldError('connect', `Den Dienst «${c}» gibt es nicht`)
  if (connect.length && !tpl.connection.length) throw fieldError('connect', `${tpl.label} bietet keine Verbindung für andere Dienste`)

  const b = build(i.template, i, { databases: databaseServices(doc) })
  for (const h of Object.keys(b.helpers ?? {})) if (existing.includes(h)) throw fieldError('name', `Einen Dienst «${h}» gibt es schon (${tpl.label} braucht ihn als Hilfs-Dienst)`)
  const volume = (i.volume || tpl.volumeRequired) && tpl.volume && b.mountPath ? `${i.name}-data` : null
  if (volume && keysOf(doc.get('volumes')).includes(volume)) throw fieldError('volume', `Ein Volume «${volume}» gibt es schon`)

  // Passwörter: bestehende Variable weiterverwenden (z. B. nach Entfernen mit behaltenem Volume – sonst passte das Passwort nicht mehr zu den Daten)
  const pw = ctx.password ?? newPassword
  const variables: PlannedVariable[] = []
  const values: Record<string, string> = {}
  for (const p of b.passwords) {
    const old = ctx.env[p.key]
    values[p.key] = old ?? (p.gen ?? pw)()
    variables.push({ key: p.key, secret: true, value: values[p.key]!, state: old !== undefined ? 'reuse' : 'new', purpose: p.purpose })
  }
  // Verbindung: nur, wenn jemand sie bekommt; eine bestehende Variable mit anderem Wert nie überschreiben
  const receivers = connect.length ? connect : []
  const conn = receivers.length ? b.connection(values) : []
  for (const c of conn) {
    const old = ctx.env[c.key]
    if (old !== undefined && old !== c.value) {
      throw fieldError('connectionVar', `Die Variable ${c.key} gibt es schon (mit anderem Wert). Wähle einen anderen Namen oder lösche sie zuerst unter Einstellungen › Umgebungsvariablen.`)
    }
    variables.push({ key: c.key, secret: c.secret, value: c.value, state: old !== undefined ? 'reuse' : 'new', purpose: `Verbindung für ${receivers.join(', ')}` })
  }

  // Dienst eintragen (Hilfs-Dienste davor: sie laufen zuerst)
  for (const [h, content] of Object.entries(b.helpers ?? {})) {
    svcs.set(h, doc.createNode(volume ? { ...content, volumes: [`${volume}:${b.mountPath}`] } : content))
  }
  const svc: Record<string, unknown> = { ...b.service }
  if (volume) svc.volumes = [`${volume}:${b.mountPath}`]
  svcs.set(i.name, doc.createNode(svc))
  if (volume) {
    const vols = doc.get('volumes')
    if (isMap(vols)) vols.set(volume, doc.createNode({}))
    else doc.set('volumes', doc.createNode({ [volume]: {} }))
  }
  // Verbindungen: Startreihenfolge, und andere Dienste als der Web-Dienst bekommen die Variablen über x-airlock-env
  for (const c of receivers) {
    addDependsOn(doc, c, i.name)
    if (c !== ctx.webService && conn.length) addEnvMap(doc, c, Object.fromEntries(conn.map((v) => [v.key, v.key])))
  }

  const out = dump(doc)
  await validate(out, ctx.webService)

  const notes: string[] = []
  if (volume) notes.push(`Die Daten liegen im Volume «${volume}»; es bleibt bei Deploys und Neustarts erhalten.`)
  if (b.passwords.length) notes.push('Passwörter stehen nicht in der Datei: Airlock erzeugt sie und speichert sie als geheime Variablen des Projekts.')
  if (receivers.includes(ctx.webService) && conn.length) notes.push(`Der Web-Dienst «${ctx.webService}» bekommt alle Variablen des Projekts, also auch ${conn.map((c) => c.key).join(', ')}.`)
  if (b.service[X_INTERNAL]) {
    const what = i.template === 'garage' ? `Die Admin-API (Token in ${varPrefix(i.name)}_ADMIN_TOKEN)` : 'Die Oberfläche'
    notes.push(`${what} bekommt eine eigene Adresse ${i.name}--${ctx.slug ?? '<projekt>'} – nur über die internen Wege des Projekts (LAN, Tailnet), nie öffentlich.`)
  }
  if (i.template === 'garage') {
    notes.push(`Garage läuft als ein Knoten und legt beim ersten Start den Bucket «${GARAGE_BUCKET}» und den Schlüssel selbst an. Die Konfiguration schreibt der Einmal-Dienst «${garageInitName(i.name)}» ins Volume; er ist danach beendet, das ist normal.`)
  }
  if (variables.some((v) => v.state === 'reuse' && v.secret && b.passwords.some((p) => p.key === v.key))) {
    notes.push('Ein Passwort gibt es schon im Projekt; es wird weiterverwendet (passt zu einem behaltenen Volume).')
  }
  return { text: out, variables, notes, volume, internal: Boolean(b.service[X_INTERNAL]) }
}

/**
 * Hilfs-Dienst eines Dienstes: heisst <name>-init und der Dienst wartet auf
 * dessen erfolgreiches Ende (wie die Vorlage Garage ihn anlegt).
 */
function helperOf(svcs: YAMLMap, name: string): string | null {
  const init = garageInitName(name)
  const svc = svcs.get(name)
  if (!isMap(svc) || !svcs.has(init)) return null
  const dep = svc.get('depends_on')
  const cond = isMap(dep) ? (dep.get(init) as YAMLMap | undefined)?.get?.('condition') : null
  return cond === 'service_completed_successfully' ? init : null
}

/**
 * Dienst aus der compose.yaml nehmen. depends_on anderer Dienste wird
 * angepasst; Volumes, die nur er nutzte, bleiben deklariert (Daten bleiben,
 * im Aufbau als «nicht eingehängt»), ausser dropVolume.
 */
export async function removeService(text: string, i: RemoveServiceInput, ctx: Pick<EditContext, 'webService'>): Promise<RemoveResult> {
  const doc = load(text)
  const svcs = servicesOf(doc)
  const names = keysOf(svcs)
  if (!names.includes(i.name)) throw fieldError('name', `Einen Dienst «${i.name}» gibt es in der compose.yaml nicht`)
  if (i.name === ctx.webService) throw fieldError('name', `«${i.name}» ist der Web-Dienst des Projekts und lässt sich nicht entfernen`)

  // Hilfs-Dienst (Garage: <name>-init) geht mit; allein entfernen ginge nicht – ohne ihn startet der Dienst nicht
  const owner = names.find((n) => n !== i.name && helperOf(svcs, n) === i.name)
  if (owner) throw fieldError('name', `«${i.name}» gehört zu «${owner}» und geht nur mit ihm. Entferne «${owner}».`)
  const helper = helperOf(svcs, i.name)
  const own = [...volumesOfService(svcs.get(i.name)), ...(helper ? volumesOfService(svcs.get(helper)) : [])]
  svcs.delete(i.name)
  if (helper) svcs.delete(helper)
  const dependents: string[] = []
  for (const n of keysOf(svcs)) {
    const svc = svcs.get(n)
    if (!isMap(svc)) continue
    const dep = svc.get('depends_on')
    let touched = false
    if (isSeq(dep)) {
      const idx = dep.items.findIndex((x) => isScalar(x) && x.value === i.name)
      if (idx >= 0) { dep.delete(idx); touched = true }
      if (touched && dep.items.length === 0) svc.delete('depends_on')
    } else if (isMap(dep) && dep.has(i.name)) {
      dep.delete(i.name)
      touched = true
      if (dep.items.length === 0) svc.delete('depends_on')
    }
    if (touched) dependents.push(n)
  }
  const stillUsed = new Set(keysOf(svcs).flatMap((n) => volumesOfService(svcs.get(n))))
  const volumes = [...new Set(own)].filter((v) => !stillUsed.has(v))
  const dropped: string[] = []
  if (i.dropVolume) {
    const vols = doc.get('volumes')
    for (const v of volumes) if (isMap(vols) && vols.has(v)) { vols.delete(v); dropped.push(v) }
    if (isMap(vols) && vols.items.length === 0) doc.delete('volumes')
  }

  const out = dump(doc)
  await validate(out, ctx.webService)
  const notes: string[] = []
  if (helper) notes.push(`Der Einmal-Dienst «${helper}» gehört zu «${i.name}» und geht mit.`)
  if (dependents.length) notes.push(`depends_on von ${dependents.join(', ')} verweist nicht mehr auf «${i.name}».`)
  if (volumes.length && !i.dropVolume) notes.push(`Volume ${volumes.map((v) => `«${v}»`).join(', ')} bleibt mit allen Daten erhalten (im Aufbau als «nicht eingehängt»).`)
  if (dropped.length) notes.push(`Volume ${dropped.map((v) => `«${v}»`).join(', ')} wird nach dem Deploy gelöscht – die Daten sind dann weg.`)
  notes.push('Umgebungsvariablen des Dienstes (Passwörter, Verbindung) bleiben im Projekt; löschen unter Einstellungen › Umgebungsvariablen.')
  return { text: out, dependents, volumes, dropped, notes }
}

/** Dieselbe Prüfung wie beim Deploy; Dateien des Repos (build, env_file) gelten hier als vorhanden */
async function validate(text: string, webService: string): Promise<void> {
  await normalizeCompose(text, {
    slug: 'vorschau',
    deploymentShort: 'vorschau',
    deploymentId: 'vorschau',
    webService,
    network: 'air_vorschau',
    memoryLimitMb: 256,
    cpuLimit: 1,
    projectEnv: {},
    repo: { resolvePath: async (p) => `/repo/${p}`, readFile: async () => '' },
  })
}
