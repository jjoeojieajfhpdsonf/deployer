import { EGRESS_BLOCKED_V4, EGRESS_BLOCKED_V6 } from '@airlock/shared'

/**
 * Nacht 3, Etappe 4: Regeln für den Ausgang der Projekt-Netze – reine
 * Funktion, geprüft mit Golden-Files (rules.test.ts, golden/*.nft).
 *
 * Ergebnis ist ein nft-Skript für EINE eigene Tabelle (`inet airlock`). Der
 * Firewall-Dienst (firewall/airlock-fw) prüft jede Zeile gegen eine feste
 * Grammatik und ersetzt die Tabelle dann in einem Zug (atomar). Andere
 * Tabellen – Docker, ufw, die Tailscale-Regel in mangle POSTROUTING – fasst
 * er nie an.
 *
 * Warum eine eigene nftables-Tabelle statt einer Kette in DOCKER-USER
 * (SPEC lässt beides zu, «bzw. eigener Tabelle inet airlock»): siehe
 * docs/FRAGEN-NACHT-3.md, Etappe 4. Kurz: Regeln, die ein neueres iptables im
 * Container in die iptables-Tabelle schreibt, kann ein älteres iptables auf
 * dem Host teils nicht mehr lesen (NFLOG mit iptables 1.8.7: «table filter is
 * incompatible»). Eine eigene Tabelle berührt Dockers Regeln gar nicht,
 * braucht keine Erkennung nft/legacy und wirkt auch, wenn Docker iptables-legacy
 * oder sein nftables-Backend benutzt. Sperren wirkt in nftables endgültig,
 * egal in welcher Tabelle; «return/accept» hier lässt die übrigen Regeln
 * (Docker) unverändert weiterlaufen.
 *
 * Aufbau:
 *   chain egress       (hook forward)  – je Projekt-Bridge ein Sprung nach p_<id>
 *   chain egress_host  (hook input)    – je Projekt-Bridge ein Sprung nach h_<id>
 *   chain p_<id>  Verkehr aus dem Projekt-Netz nach draussen/ins LAN/zu anderen Netzen
 *   chain h_<id>  Verkehr aus dem Projekt-Netz an den Server selbst (alle seine Adressen)
 *
 * Reihenfolge in p_<id>: Antworten (established, related) → eigenes Netz
 * (gleiche Bridge, z. B. Caddy ↔ Projekt, Airlock-Healthcheck) → Ausnahmen →
 * DNS (nur «internet») → protokollieren (begrenzt) → sperren (nur
 * «durchsetzen»). Beobachten heisst: dieselben Treffer, nur ohne die
 * Sperr-Zeilen.
 */

export interface EgressAllowRule {
  /** IP oder Netz (CIDR), schon normalisiert */
  address: string
  family: 4 | 6
  port: number | null
  protocol: 'tcp' | 'udp'
}

export interface EgressNetworkRules {
  /** Name des Docker-Netzes (nur für den Kommentar), z. B. air_shop */
  network: string
  /** Bridge des Netzes: br-<12 hex> */
  bridge: string
  mode: 'internet' | 'abgeschottet'
  /** false = nur protokollieren */
  enforce: boolean
  allow: EgressAllowRule[]
}

export interface EgressRenderOptions {
  /** Tabelle in der Familie inet */
  table: string
  /** NFLOG-Gruppe für «hätte gesperrt» (beobachten) */
  observeGroup: number
  /** NFLOG-Gruppe für «gesperrt» (durchsetzen) */
  blockGroup: number
}

export const EGRESS_RENDER_DEFAULTS: EgressRenderOptions = { table: 'airlock', observeGroup: 7801, blockGroup: 7802 }

/** Rate der Protokollzeilen je Projekt-Netz (je Regel) */
export const EGRESS_LOG_LIMIT = 'limit rate 20/minute burst 20 packets'
const REJECT = 'reject with icmpx admin-prohibited'

export const BRIDGE_RE = /^br-[0-9a-f]{12}$/
export const TABLE_RE = /^[a-z][a-z0-9_]{0,31}$/
const NETWORK_COMMENT_RE = /^[a-z0-9_.-]{1,64}$/

/* --- Adressen normalisieren ------------------------------------------------------ */

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => n * 256 + Number(o), 0)
}
function intToV4(n: number): string {
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.')
}

/** IPv6 in 8 Gruppen à 16 Bit (ohne Prüfung; vorher isIpv6) */
function v6Groups(ip: string): number[] {
  const [head, tail] = ip.includes('::') ? ip.split('::') as [string, string] : [ip, null]
  const h = head ? head.split(':') : []
  const t = tail === null ? [] : tail ? tail.split(':') : []
  const fill = tail === null ? [] : Array(8 - h.length - t.length).fill('0')
  return [...h, ...fill, ...t].map((g) => parseInt(g, 16))
}

/** Adresse bzw. Netz mit gelöschten Host-Bits; IPv6 ausgeschrieben, klein */
export function normalizeCidr(addr: string, family: 4 | 6): string {
  const [ip, bitsRaw] = addr.trim().toLowerCase().split('/') as [string, string | undefined]
  if (family === 4) {
    if (bitsRaw === undefined || bitsRaw === '32') return intToV4(v4ToInt(ip))
    const bits = Number(bitsRaw)
    const net = v4ToInt(ip) - (v4ToInt(ip) % 2 ** (32 - bits))
    return `${intToV4(net)}/${bits}`
  }
  const g = v6Groups(ip)
  const bits = bitsRaw === undefined ? 128 : Number(bitsRaw)
  const out = g.map((x, i) => {
    const keep = Math.max(0, Math.min(16, bits - i * 16))
    return keep === 16 ? x : keep === 0 ? 0 : x - (x % 2 ** (16 - keep))
  })
  const text = out.map((x) => x.toString(16)).join(':')
  return bits === 128 ? text : `${text}/${bits}`
}

/* --- Erzeugen ---------------------------------------------------------------- */

const idOf = (bridge: string) => bridge.slice(3)

function allowLines(a: EgressAllowRule): string {
  const fam = a.family === 4 ? 'ip' : 'ip6'
  return a.port === null ? `${fam} daddr ${a.address} return` : `${fam} daddr ${a.address} ${a.protocol} dport ${a.port} return`
}

/** Prüft die Eingabe; wirft bei allem, was nicht in die Grammatik des Dienstes passt */
function assertInput(n: EgressNetworkRules): void {
  if (!BRIDGE_RE.test(n.bridge)) throw new Error(`Bridge «${n.bridge}» passt nicht zu br-<12 hex>`)
  if (!NETWORK_COMMENT_RE.test(n.network)) throw new Error(`Netzname «${n.network}» ungültig`)
  for (const a of n.allow) {
    if (a.port !== null && (!Number.isInteger(a.port) || a.port < 1 || a.port > 65535)) throw new Error(`Port ${a.port} ungültig`)
    if (a.family === 4 && !/^[0-9.]+(\/\d{1,2})?$/.test(a.address)) throw new Error(`Adresse ${a.address} ungültig`)
    if (a.family === 6 && !/^[0-9a-f:]+(\/\d{1,3})?$/.test(a.address)) throw new Error(`Adresse ${a.address} ungültig`)
  }
}

/** Schlüssel einer Ausnahme (doppelte weglassen) */
const allowKey = (a: EgressAllowRule) => `${a.family}|${a.address}|${a.port ?? ''}|${a.port === null ? '' : a.protocol}`

/**
 * Das nft-Skript (ohne «delete table»; das setzt der Dienst davor, damit der
 * Austausch ein einziger Vorgang ist). Netze nach Bridge sortiert, Ausnahmen
 * in Eingabereihenfolge ohne Doppelte – gleiche Eingabe, gleicher Text.
 */
export function renderEgressRules(networks: EgressNetworkRules[], o: EgressRenderOptions = EGRESS_RENDER_DEFAULTS): string {
  if (!TABLE_RE.test(o.table)) throw new Error(`Tabellenname «${o.table}» ungültig`)
  for (const g of [o.observeGroup, o.blockGroup]) if (!Number.isInteger(g) || g < 1 || g > 65535) throw new Error(`NFLOG-Gruppe ${g} ungültig`)
  const nets = [...networks].sort((a, b) => a.bridge.localeCompare(b.bridge))
  const seen = new Set<string>()
  for (const n of nets) {
    assertInput(n)
    if (seen.has(n.bridge)) throw new Error(`Bridge ${n.bridge} doppelt`)
    seen.add(n.bridge)
  }

  const L: string[] = []
  L.push('# Airlock: Ausgang der Projekt-Netze. Erzeugt von Airlock (egress/rules.ts), nicht von Hand aendern.')
  L.push(`table inet ${o.table} {`)
  L.push('  chain egress {')
  L.push('    type filter hook forward priority -1; policy accept;')
  for (const n of nets) L.push(`    iifname "${n.bridge}" jump p_${idOf(n.bridge)}`)
  L.push('  }')
  L.push('  chain egress_host {')
  L.push('    type filter hook input priority -1; policy accept;')
  for (const n of nets) L.push(`    iifname "${n.bridge}" jump h_${idOf(n.bridge)}`)
  L.push('  }')

  for (const n of nets) {
    const id = idOf(n.bridge)
    const group = n.enforce ? o.blockGroup : o.observeGroup
    const log = `${EGRESS_LOG_LIMIT} log group ${group}`
    const allow: EgressAllowRule[] = []
    const keys = new Set<string>()
    for (const a of n.allow) if (!keys.has(allowKey(a))) { keys.add(allowKey(a)); allow.push(a) }

    L.push(`  # ${n.network} ${n.mode} ${n.enforce ? 'durchsetzen' : 'beobachten'}`)
    // Ins LAN, Tailnet, zu anderen Docker-Netzen und ins Internet
    L.push(`  chain p_${id} {`)
    L.push('    ct state established,related return')
    L.push(`    oifname "${n.bridge}" return`)
    for (const a of allow) L.push(`    ${allowLines(a)}`)
    if (n.mode === 'internet') {
      // Docker leitet DNS-Anfragen aus dem Netz des Containers an den Resolver des Hosts weiter
      // (oft der Router oder 100.100.100.100) – ohne diese Zeile ginge im Durchsetzen kein Name mehr.
      L.push('    meta l4proto { tcp, udp } th dport 53 return')
      L.push(`    ip daddr { ${EGRESS_BLOCKED_V4.join(', ')} } ${log}`)
      if (n.enforce) L.push(`    ip daddr { ${EGRESS_BLOCKED_V4.join(', ')} } ${REJECT}`)
      L.push(`    ip6 daddr { ${EGRESS_BLOCKED_V6.join(', ')} } ${log}`)
      if (n.enforce) L.push(`    ip6 daddr { ${EGRESS_BLOCKED_V6.join(', ')} } ${REJECT}`)
    } else {
      L.push(`    ${log}`)
      if (n.enforce) L.push(`    ${REJECT}`)
    }
    L.push('  }')
    // An den Server selbst (LAN-, Tailscale-, Gateway-Adresse …): immer gesperrt bis auf Ausnahmen
    L.push(`  chain h_${id} {`)
    L.push('    ct state established,related return')
    // IPv6-Nachbarsuche (NDP) an die Bridge; ohne sie ginge IPv6 im Netz nicht
    L.push('    meta l4proto ipv6-icmp return')
    for (const a of allow) L.push(`    ${allowLines(a)}`)
    if (n.mode === 'internet') L.push('    meta l4proto { tcp, udp } th dport 53 return')
    L.push(`    ${log}`)
    if (n.enforce) L.push(`    ${REJECT}`)
    L.push('  }')
  }
  L.push('}')
  return `${L.join('\n')}\n`
}
