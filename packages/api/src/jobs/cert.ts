import { cf, config } from '../config.js'
import { probeCert, certProblem, type CertInfo } from '../lib/cert.js'
import { getSetting, setSetting } from '../db/index.js'
import { notify } from '../notify/send.js'
import { log } from '../lib/log.js'

/**
 * M4: Zertifikat im Blick behalten. deployer fragt Caddy per TLS (SNI
 * deployer.<basis>) nach dem ausgelieferten Zertifikat. Problem: höchstens
 * eine Benachrichtigung pro Tag (infra_problem).
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

let cached: { at: number; info: CertInfo } | null = null
const CACHE_MS = 5 * 60_000

/**
 * Zuletzt gelesenes Zertifikat, höchstens fünf Minuten alt. Die Systemseite
 * fragt alle 15 Sekunden; jedes Mal ein TLS-Handshake (und bei hängendem
 * Caddy 5 s Wartezeit) wäre unnötig (Review M4).
 */
export async function currentCert(fresh = false): Promise<CertInfo | null> {
  if (!cf.tls() || !cf.baseDomain()) return null
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.info
  const info = await probeCert(config.CADDY_CONTAINER, 443, `deployer.${cf.baseDomain()}`)
  cached = { at: Date.now(), info }
  return info
}

export const certProblemNow = (c: CertInfo, now = new Date()) => certProblem(c, now, { staging: cf.acmeCa() === 'staging' })

export async function checkCertificate(now = new Date()): Promise<string | null> {
  const c = await currentCert(true)
  if (!c) return null
  const problem = certProblemNow(c, now)
  if (!problem) return null
  const last = await getSetting('cert_problem_notified_at')
  if (!last || now.getTime() - new Date(last).getTime() >= DAY) {
    await notify('infra_problem', { what: 'Zertifikat', detail: problem })
    await setSetting('cert_problem_notified_at', now.toISOString())
  }
  log.warn('Zertifikat mit Problem', { problem })
  return problem
}

export function startCertJob(): NodeJS.Timeout | null {
  // Läuft immer; ohne TLS kehrt currentCert sofort zurück (TLS kann über die Oberfläche dazukommen)
  const tick = () => checkCertificate().catch((err) => log.error('Zertifikatsprüfung fehlgeschlagen', { err: String(err) }))
  // Erste Prüfung nach 10 Minuten: Caddy braucht für die DNS-Challenge etwas.
  setTimeout(tick, 10 * 60_000).unref()
  const t = setInterval(tick, HOUR)
  t.unref()
  return t
}
