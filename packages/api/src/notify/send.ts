import { join } from 'node:path'
import nodemailer from 'nodemailer'
import { getSetting, setSetting, db, schema } from '../db/index.js'
import { config } from '../config.js'
import { loadOrCreateKey, encrypt, decrypt } from '../lib/crypto.js'
import { log } from '../lib/log.js'
import { badRequest } from '../lib/errors.js'
import { audit } from '../domain/audit.js'
import { eq } from 'drizzle-orm'
import { renderMessage, redact, mergeMatrix, type NotifyEvent, type Matrix, type Channel } from './render.js'

/**
 * Versand per ntfy (Push) und SMTP (E-Mail). Einstellungen liegen in der
 * Datenbank; Token und Passwort verschlüsselt mit dem Schlüssel der Secrets.
 * Fehler beim Versand werden geloggt, nie an den Aufrufer weitergegeben:
 * eine kaputte Benachrichtigung darf keinen Deploy oder Scan umwerfen.
 */

interface Stored {
  ntfy?: { url: string; topic: string; tokenEnc?: string }
  email?: { host: string; port: number; secure: boolean; user?: string; passwordEnc?: string; from: string; to: string }
  matrix?: Matrix
}

export interface NotifySettingsDto {
  ntfy: { url: string; topic: string; hasToken: boolean } | null
  email: { host: string; port: number; secure: boolean; user: string | null; hasPassword: boolean; from: string; to: string } | null
  matrix: Matrix
}

export interface NotifySettingsInput {
  ntfy?: { url: string; topic: string; token?: string | null } | null
  email?: { host: string; port: number; secure: boolean; user?: string | null; password?: string | null; from: string; to: string } | null
  matrix?: Matrix
}

const KEY = 'notifications'
const key = () => loadOrCreateKey(join(config.DATA_DIR, 'keys', 'secrets.key'))
const enc = (s: string) => encrypt(s, key()).toString('base64')
const dec = (s: string) => decrypt(Buffer.from(s, 'base64'), key())

async function load(): Promise<Stored> {
  const raw = await getSetting(KEY)
  try {
    return raw ? (JSON.parse(raw) as Stored) : {}
  } catch {
    return {}
  }
}

export async function getNotifySettings(): Promise<NotifySettingsDto> {
  const s = await load()
  return {
    ntfy: s.ntfy ? { url: s.ntfy.url, topic: s.ntfy.topic, hasToken: !!s.ntfy.tokenEnc } : null,
    email: s.email
      ? { host: s.email.host, port: s.email.port, secure: s.email.secure, user: s.email.user ?? null, hasPassword: !!s.email.passwordEnc, from: s.email.from, to: s.email.to }
      : null,
    matrix: mergeMatrix(s.matrix),
  }
}

/** Token/Passwort: undefined = unverändert, null oder "" = entfernen, Text = neu. */
export async function putNotifySettings(input: NotifySettingsInput, actor: string): Promise<NotifySettingsDto> {
  const s = await load()
  if (input.ntfy === null) delete s.ntfy
  else if (input.ntfy) {
    if (!/^https?:\/\/\S+$/i.test(input.ntfy.url)) throw badRequest('ntfy-URL muss mit http:// oder https:// beginnen')
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.ntfy.topic)) throw badRequest('ntfy-Topic: nur Buchstaben, Ziffern, _ und -')
    const tokenEnc = input.ntfy.token === undefined ? s.ntfy?.tokenEnc : input.ntfy.token ? enc(input.ntfy.token) : undefined
    s.ntfy = { url: input.ntfy.url.replace(/\/+$/, ''), topic: input.ntfy.topic, ...(tokenEnc ? { tokenEnc } : {}) }
  }
  if (input.email === null) delete s.email
  else if (input.email) {
    const e = input.email
    if (!e.host || !e.from || !e.to) throw badRequest('Für E-Mail braucht es Server, Absender und Empfänger')
    const passwordEnc = e.password === undefined ? s.email?.passwordEnc : e.password ? enc(e.password) : undefined
    s.email = { host: e.host, port: e.port, secure: e.secure, ...(e.user ? { user: e.user } : {}), ...(passwordEnc ? { passwordEnc } : {}), from: e.from, to: e.to }
  }
  if (input.matrix) s.matrix = mergeMatrix(input.matrix)
  await setSetting(KEY, JSON.stringify(s))
  await audit({ actor, action: 'notifications.update', params: { ntfy: !!s.ntfy, email: !!s.email }, result: 'ok' })
  return getNotifySettings()
}

/** Alle Secrets aller Projekte – zum Herausfiltern aus jeder Nachricht. */
async function allSecretValues(): Promise<string[]> {
  const rows = await db.select().from(schema.projectEnv).where(eq(schema.projectEnv.isSecret, true))
  const out: string[] = []
  for (const r of rows) {
    if (!r.valueEncrypted) continue
    try {
      out.push(decrypt(r.valueEncrypted, key()))
    } catch {
      /* unlesbar: ignorieren */
    }
  }
  return out
}

async function sendPush(s: NonNullable<Stored['ntfy']>, title: string, body: string, priority: number): Promise<void> {
  // JSON statt Header: Header vertragen keine Umlaute im Titel.
  const res = await fetch(s.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(s.tokenEnc ? { authorization: `Bearer ${dec(s.tokenEnc)}` } : {}) },
    body: JSON.stringify({ topic: s.topic, title, message: body, priority, tags: ['airlock'] }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`ntfy antwortete ${res.status}`)
}

async function sendEmail(s: NonNullable<Stored['email']>, title: string, body: string): Promise<void> {
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    ...(s.user ? { auth: { user: s.user, pass: s.passwordEnc ? dec(s.passwordEnc) : '' } } : {}),
    connectionTimeout: 10_000,
  })
  await transport.sendMail({ from: s.from, to: s.to, subject: title, text: body })
}

export async function notify(event: NotifyEvent, data: Record<string, unknown>, projectId?: string): Promise<{ push: boolean; email: boolean }> {
  const sent = { push: false, email: false }
  // Antwort 11: jedes benachrichtigungswürdige Ereignis steht im Audit-Log («notify.<art>») – auch ohne
  // eingerichteten Kanal. Daraus liest die Glocke; die Wochenübersicht ist kein Ereignis.
  if (event !== 'weekly_summary') {
    const m = renderMessage(event, data)
    await audit({
      actor: 'system', action: `notify.${event}`,
      targetType: projectId ? 'project' : 'system', targetId: projectId ?? 'notify',
      params: { title: m.title, body: m.body.slice(0, 400) }, result: 'ok',
    })
  }
  try {
    const s = await load()
    const matrix = mergeMatrix(s.matrix)
    const want = matrix[event]
    if ((!want.push || !s.ntfy) && (!want.email || !s.email)) return sent
    const msg = renderMessage(event, data)
    const secrets = await allSecretValues()
    const title = redact(msg.title, secrets)
    const body = redact(msg.body, secrets)
    if (want.push && s.ntfy) {
      await sendPush(s.ntfy, title, body, msg.priority).then(() => (sent.push = true), (e) => log.warn('Push fehlgeschlagen', { event, err: String(e) }))
    }
    if (want.email && s.email) {
      await sendEmail(s.email, title, body).then(() => (sent.email = true), (e) => log.warn('E-Mail fehlgeschlagen', { event, err: String(e) }))
    }
  } catch (err) {
    log.warn('Benachrichtigung fehlgeschlagen', { event, err: String(err) })
  }
  return sent
}

/** Testnachricht über einen Kanal, unabhängig von der Matrix. Wirft bei Fehlern. */
export async function sendTest(channel: Channel, actor: string): Promise<void> {
  const s = await load()
  const title = 'Airlock: Testnachricht'
  const body = 'Wenn das ankommt, funktionieren die Benachrichtigungen.'
  if (channel === 'push') {
    if (!s.ntfy) throw badRequest('Push (ntfy) ist nicht eingerichtet')
    await sendPush(s.ntfy, title, body, 3)
  } else {
    if (!s.email) throw badRequest('E-Mail ist nicht eingerichtet')
    await sendEmail(s.email, title, body)
  }
  await audit({ actor, action: 'notifications.test', params: { channel }, result: 'ok' })
}
