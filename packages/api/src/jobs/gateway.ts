import { config } from '../config.js'
import * as docker from '../drivers/docker.js'
import { getSetting, setSetting } from '../db/index.js'
import { notify } from '../notify/send.js'
import { assessClientIps, parseAccessLog, type ClientIpReport } from '../lib/client-ips.js'
import { log } from '../lib/log.js'
import { shouldWarn } from './gateway-rule.js'

/**
 * Antwort 11: Gateway-Warnung als Ereignis. Dieselbe Auswertung wie die
 * Systemseite (Zugriffs-Log von Caddy, 30 Minuten): Kommen fremde Anfragen
 * auf Airlock von einer Docker-Gateway-Adresse, sieht Caddy nicht das Gerät –
 * der IP-Filter greift dann nicht. Höchstens eine Meldung pro Tag.
 */

const WINDOW = 30 * 60_000

export async function checkGateway(now = Date.now()): Promise<ClientIpReport | null> {
  const since = now - WINDOW
  const [logs, gateways] = await Promise.all([
    docker.getLogs(config.CADDY_CONTAINER, { tail: 2000, since: Math.floor(since / 1000) }),
    docker.bridgeGateways(),
  ])
  const report = assessClientIps(parseAccessLog(logs, since), gateways, since)
  if (shouldWarn(report, await getSetting('gateway_warning_notified_at'), now)) {
    await notify('gateway_warning', { fromGateway: report.fromGateway, total: report.total, ips: report.gatewayIps.join(', ') })
    await setSetting('gateway_warning_notified_at', new Date(now).toISOString())
  }
  return report
}

export function startGatewayJob(): NodeJS.Timeout {
  const tick = () => checkGateway().catch((err) => log.warn('Gateway-Prüfung fehlgeschlagen', { err: String(err) }))
  setTimeout(tick, 5 * 60_000).unref()
  const t = setInterval(tick, WINDOW)
  t.unref()
  return t
}
