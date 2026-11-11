import { z } from 'zod'

/**
 * Etappe 4 «Dienst hinzufügen»: Vorlagen für den Reiter «Aufbau» und die
 * Formen der Anfragen. Die compose.yaml selbst erzeugt die API
 * (packages/api/src/lib/compose-edit.ts) – hier steht nur, was die
 * Oberfläche zum Fragen braucht.
 *
 * Versionen: nur Tags, die es bei den Images sicher gibt; das Feld ist frei
 * (Vorschläge), eine andere Version tippt man selbst ein.
 */

export const SERVICE_TEMPLATE_IDS = ['postgres', 'mariadb', 'redis', 'mongo', 'minio', 'mailpit', 'adminer', 'custom'] as const
export type ServiceTemplateId = (typeof SERVICE_TEMPLATE_IDS)[number]

export interface ServiceTemplate {
  id: ServiceTemplateId
  label: string
  /** Ein Satz, wofür */
  about: string
  /** Image ohne Tag; null beim eigenen Container */
  image: string | null
  /** Vorschläge für die Version, der erste ist Standard */
  versions: string[]
  /** Vorschlag für den Dienstnamen */
  name: string
  /** Kann Daten in einem Volume ablegen */
  volume: boolean
  /** Volume standardmässig an */
  volumeDefault: boolean
  /** Eigene interne Adresse (Port der Oberfläche) – nur LAN und Tailnet */
  internalUi: number | null
  /** Variablen, die die gewählten Dienste bekommen (der erste lässt sich umbenennen) */
  connection: { key: string; secret: boolean }[]
  /** Bekommt ein Passwort (geheime Variable, erzeugt) */
  password: boolean
  /** Erscheint im Aufbau unter «Daten» */
  database: boolean
}

export const SERVICE_TEMPLATES: ServiceTemplate[] = [
  {
    id: 'postgres', label: 'PostgreSQL', about: 'Relationale Datenbank.', image: 'postgres', versions: ['17', '18', '16', '15'],
    name: 'db', volume: true, volumeDefault: true, internalUi: null, connection: [{ key: 'DATABASE_URL', secret: true }], password: true, database: true,
  },
  {
    id: 'mariadb', label: 'MariaDB', about: 'MySQL-kompatible Datenbank.', image: 'mariadb', versions: ['11.4', '11.8', '10.11'],
    name: 'db', volume: true, volumeDefault: true, internalUi: null, connection: [{ key: 'DATABASE_URL', secret: true }], password: true, database: true,
  },
  {
    id: 'redis', label: 'Redis', about: 'Schlüssel-Wert-Speicher, z. B. für Cache und Warteschlangen.', image: 'redis', versions: ['7.4', '8.0'],
    name: 'cache', volume: true, volumeDefault: false, internalUi: null, connection: [{ key: 'REDIS_URL', secret: true }], password: true, database: true,
  },
  {
    id: 'mongo', label: 'MongoDB', about: 'Dokument-Datenbank.', image: 'mongo', versions: ['8.0', '7.0'],
    name: 'mongo', volume: true, volumeDefault: true, internalUi: null, connection: [{ key: 'MONGODB_URI', secret: true }], password: true, database: true,
  },
  {
    id: 'minio', label: 'MinIO', about: 'S3-kompatibler Dateispeicher; Konsole unter eigener interner Adresse.', image: 'minio/minio', versions: ['latest'],
    name: 'minio', volume: true, volumeDefault: true, internalUi: 9001,
    connection: [{ key: 'S3_ENDPOINT', secret: false }, { key: 'S3_ACCESS_KEY', secret: false }, { key: 'S3_SECRET_KEY', secret: true }], password: true, database: false,
  },
  {
    id: 'mailpit', label: 'Mailpit', about: 'Fängt E-Mails ab (SMTP) und zeigt sie unter eigener interner Adresse.', image: 'axllent/mailpit', versions: ['latest'],
    name: 'mailpit', volume: true, volumeDefault: false, internalUi: 8025, connection: [{ key: 'SMTP_URL', secret: false }], password: false, database: false,
  },
  {
    id: 'adminer', label: 'Adminer', about: 'Datenbank-Oberfläche – nur intern (LAN und Tailnet), nie öffentlich.', image: 'adminer', versions: ['latest', '4'],
    name: 'adminer', volume: false, volumeDefault: false, internalUi: 8080, connection: [], password: false, database: false,
  },
  {
    id: 'custom', label: 'Eigener Container', about: 'Ein Image aus einer Registry, mit Port.', image: null, versions: [],
    name: 'worker', volume: true, volumeDefault: false, internalUi: null, connection: [], password: false, database: false,
  },
]

export const serviceTemplate = (id: ServiceTemplateId): ServiceTemplate => SERVICE_TEMPLATES.find((t) => t.id === id)!

/** Dienstname für neue Dienste: klein, mit Bindestrich – er steht auch in der internen Adresse */
export const NEW_SERVICE_RE = /^[a-z][a-z0-9-]{0,29}$/
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/:]*(@sha256:[a-f0-9]{64})?$/
const PATH_RE = /^\/[A-Za-z0-9._\-/]*$/

export const addServiceSchema = z.object({
  action: z.literal('add'),
  template: z.enum(SERVICE_TEMPLATE_IDS),
  name: z.string().trim().regex(NEW_SERVICE_RE, 'Kleinbuchstaben, Ziffern und Bindestrich, mit einem Buchstaben am Anfang, z. B. db'),
  version: z.string().trim().regex(TAG_RE, 'Ein Tag des Images, z. B. 17').optional(),
  volume: z.boolean().default(false),
  /** Bestehende Dienste, die eine Verbindung bekommen */
  connect: z.array(z.string().max(63)).max(20).default([]),
  /** Name der Verbindungs-Variable (erste der Vorlage), z. B. DATABASE_URL */
  connectionVar: z.string().trim().max(128).regex(VAR_RE, 'Nur Buchstaben, Ziffern und _, z. B. DATABASE_URL').optional(),
  /** Eigener Container */
  image: z.string().trim().max(255).regex(IMAGE_RE, 'Ein Image mit Tag, z. B. ghcr.io/me/worker:1.4').optional(),
  port: z.number().int().min(1).max(65535).optional(),
  volumePath: z.string().trim().max(200).regex(PATH_RE, 'Ein absoluter Pfad im Container, z. B. /data').optional(),
})
export type AddServiceInput = z.infer<typeof addServiceSchema>

export const removeServiceSchema = z.object({
  action: z.literal('remove'),
  name: z.string().max(63),
  /** Volumes, die nur dieser Dienst nutzt, mitlöschen (Standard: behalten) */
  dropVolume: z.boolean().default(false),
})
export type RemoveServiceInput = z.infer<typeof removeServiceSchema>

export const serviceChangeSchema = z.discriminatedUnion('action', [addServiceSchema, removeServiceSchema])
export type ServiceChangeInput = z.infer<typeof serviceChangeSchema>

/** Übernehmen: dieselbe Anfrage wie die Vorschau plus der Stand, auf dem die Vorschau beruht */
export const applyServiceChangeSchema = z.object({ change: serviceChangeSchema, base: z.string().min(1).max(128) })

/** Wie die Änderung ins Projekt kommt */
export type ServiceEditWay = 'deploy' | 'pull_request'

export interface ServiceVariableDto {
  key: string
  secret: boolean
  /** new: wird angelegt; reuse: gibt es schon mit passendem Wert, bleibt */
  state: 'new' | 'reuse'
  /** Wofür, z. B. «Passwort von db» oder «Verbindung für web, worker» */
  purpose: string
}

/** Vorschau (POST /projects/:id/services/plan) */
export interface ServicePlanDto {
  way: ServiceEditWay
  /** Datei im Projekt bzw. Repo */
  composePath: string
  diff: string
  /** Stand der Datei, auf dem die Vorschau beruht (Übernehmen prüft ihn) */
  base: string
  variables: ServiceVariableDto[]
  /** Hinweise in ganzen Sätzen (z. B. «Volume db-data bleibt erhalten») */
  notes: string[]
  /** Pull Request: Ziel-Branch */
  branch: string | null
  /** Entfernen: Volumes, die nur dieser Dienst nutzt */
  volumes: string[]
}

export type ServiceChangeStatus = 'deploying' | 'pr_open' | 'merged' | 'done' | 'failed' | 'closed'

/** Laufende bzw. kürzlich gescheiterte Änderung (im Aufbau als gestrichelter Knoten) */
export interface ServiceChangeDto {
  id: string
  kind: 'add' | 'remove'
  service: string
  template: ServiceTemplateId | null
  status: ServiceChangeStatus
  deploymentId: string | null
  prUrl: string | null
  prNumber: number | null
  note: string | null
  createdAt: string
}

/** Ergebnis von POST /projects/:id/services */
export interface ServiceApplyDto {
  change: ServiceChangeDto
}
