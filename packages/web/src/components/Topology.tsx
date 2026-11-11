import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ProjectDto, TopologyAccessDto, TopologyDto, TopologyEdgeDto, TopologyHostDto, TopologyServiceDto, TopologyVolumeDto, TopologyWay } from '@airlock/shared'
import { TOPOLOGY_WAY_LABEL } from '@airlock/shared'
import { api } from '../api.js'
import { FALLBACK_MS } from '../lib/live.js'
import { gb, shortVersion } from '../lib/format.js'
import { isPublic } from '../lib/projects.js'
import { useInternalReach } from './Reachability.js'
import { Switch } from './Switch.js'
import { InlineConfirm } from './Confirm.js'
import { ErrorState, Loading, Sk, SkLines } from './States.js'
import { IconExternal, IconGlobe, IconPause } from './Icons.js'

/**
 * Reiter «Aufbau»: eine Fläche mit vier festen Spalten – Zugang, Eingang,
 * Dienste, Daten –, die Knoten je Spalte gleichmässig verteilt, die Linien
 * als SVG aus den gemessenen Positionen. Rechts die Seitenkarte zum
 * gewählten Knoten (Standard: der Dienst mit der Hauptroute). Unter 1100 px
 * steht die Seitenkarte unter der Fläche, unter 700 px ersetzt eine Liste
 * nach Spalten die Fläche. Zustände stehen immer als Wort neben dem Punkt.
 */

export interface TopologyProps {
  p: ProjectDto
  /** «Alle Logs»: Reiter Logs, gefiltert auf den Dienst (Compose) */
  onLogs: (service: string | null) => void
  /** «Veröffentlichen →»: Einstellungen › Veröffentlichung mit offenem Ablauf */
  onPublish: () => void
  /** «Ja, neu starten» (dieselbe Aktion wie im Kopfmenü) */
  onRestart: () => void
  restartBusy: boolean
  /** «Header verwalten»: Security › Header über Caddy */
  onManageHeaders: () => void
}

/* --- Zeichen (16 px, Strich 1.6 wie Icons.tsx) ------------------------------------- */

const ic = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
const IconTailnet = () => <svg {...ic}><circle cx="4" cy="4" r="1.5" /><circle cx="12" cy="4" r="1.5" /><circle cx="8" cy="12" r="1.5" /><path d="M5.3 4.8 7.2 10.8M10.7 4.8 8.8 10.8M5.5 4h5" /></svg>
const IconHome = () => <svg {...ic}><path d="M2.5 7.5 8 3l5.5 4.5M4 6.5v6.5h8V6.5" /><path d="M6.5 13v-3h3v3" /></svg>
const IconRoute = () => <svg {...ic}><path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13" /></svg>
const IconWindow = () => <svg {...ic}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 6h11" /></svg>
const IconCog = () => <svg {...ic}><circle cx="8" cy="8" r="2" /><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" /></svg>
const IconDb = () => <svg {...ic}><ellipse cx="8" cy="3.8" rx="5" ry="1.8" /><path d="M3 3.8v8.4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.8M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" /></svg>
const IconDisk = () => <svg {...ic}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 9.5h11M5 11.3h.01" /></svg>
const IconFiles = () => <svg {...ic}><path d="M4 2.5h5l3 3v8H4Z" /><path d="M9 2.5v3h3" /></svg>

const WAY_ICON: Record<TopologyWay, () => ReactNode> = { public: () => <IconGlobe />, tailnet: IconTailnet, lan: IconHome }
/** Wege in der Oberfläche: «Heimnetz (LAN)» wie die Schalter in den Einstellungen */
const WAY_LONG: Record<TopologyWay, string> = { public: 'Internet', tailnet: 'Tailnet', lan: 'Heimnetz (LAN)' }

/* --- Zustände: Punkt UND Wort ------------------------------------------------------- */

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral'

function serviceState(s: TopologyServiceDto): { word: string; tone: Tone } {
  switch (s.state) {
    case 'running':
      if (s.health === 'unhealthy') return { word: 'Healthcheck scheitert', tone: 'bad' }
      if (s.health === 'starting') return { word: 'startet', tone: 'info' }
      return { word: s.health === 'healthy' ? 'gesund' : 'läuft', tone: 'ok' }
    case 'restarting': return { word: 'startet neu', tone: 'warn' }
    case 'exited':
      // Einmal-Dienst (Migration): mit Code 0 fertig, nicht kaputt
      if (s.oneShot && s.exitCode === 0) return { word: 'fertig', tone: 'neutral' }
      return { word: s.exitCode !== null ? `beendet (Code ${s.exitCode})` : 'beendet', tone: 'bad' }
    case 'stopped': return { word: 'gestoppt', tone: 'neutral' }
    case 'missing': return { word: 'Container fehlt', tone: 'bad' }
    case 'static': return { word: 'liefert aus', tone: 'ok' }
  }
}

function State({ word, tone }: { word: string; tone: Tone }) {
  return <span className={`topo-state topo-tone-${tone}`}><span className="topo-dot" aria-hidden="true" />{word}</span>
}

const fmtCpu = (v: number) => v.toLocaleString('de-CH', { maximumFractionDigits: 2 })
const fmtMb = (v: number) => Math.round(v).toLocaleString('de-CH')
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Image kurz: letzter Pfadteil («ghcr.io/x/worker:1.4» → «worker:1.4»); selbst gebaut: «eigenes Image» */
function imageShort(image: string | null): string | null {
  if (!image) return null
  if (image.startsWith('airlock/') || image.startsWith('deployer/')) return 'eigenes Image'
  return image.split('@')[0]!.split('/').at(-1) ?? image
}

/* --- Knoten und Spalten ------------------------------------------------------------- */

type Col = 0 | 1 | 2 | 3

interface NodeDesc {
  id: string
  col: Col
  icon: ReactNode
  title: string
  sub: string | null
  meta?: { left?: ReactNode; right?: ReactNode }
  /** Umriss statt Karte: Weg aus, Route pausiert */
  off?: boolean
  /** Eigene Aktion statt Auswahl (Internet aus: «Veröffentlichen →») */
  action?: ReactNode
}

type Picked =
  | { kind: 'access'; a: TopologyAccessDto }
  | { kind: 'host'; h: TopologyHostDto }
  | { kind: 'service'; s: TopologyServiceDto }
  | { kind: 'volume'; v: TopologyVolumeDto }

/** Wege kurz für die Knoten («Tailnet · LAN», «LAN-Ausweich»); die Seitenkarte nennt sie ausgeschrieben */
const WAY_SHORT: Record<TopologyWay, string> = { public: 'Internet', tailnet: 'Tailnet', lan: 'LAN' }

function hostWays(h: TopologyHostDto): string {
  if (h.fallback) return `${WAY_SHORT[h.ways[0] ?? 'lan']}-Ausweich`
  if (h.ways.includes('public')) return h.accessProtected ? 'Internet · Access' : 'Internet'
  return h.ways.map((w) => WAY_SHORT[w]).join(' · ')
}

function hostTls(h: TopologyHostDto): { word: string; tone: Tone } {
  if (h.paused) return { word: 'pausiert', tone: 'warn' }
  // TLS macht Cloudflare (ausgeschrieben in der Seitenkarte)
  if (h.tls === 'cloudflare') return { word: 'TLS ok', tone: 'ok' }
  if (h.tls === 'https') return h.tlsProblem ? { word: 'TLS-Problem', tone: 'bad' } : { word: 'TLS ok', tone: 'ok' }
  return { word: 'ohne TLS', tone: 'neutral' }
}

/** Spalten: Zugang · Eingang · Dienste · Daten (Datenbank, darunter ihre Volumes, dann die übrigen) */
function columns(t: TopologyDto): { access: TopologyAccessDto[]; hosts: TopologyHostDto[]; apps: TopologyServiceDto[]; data: Picked[] } {
  const apps = t.services.filter((s) => !s.database)
  const dbs = t.services.filter((s) => s.database)
  const data: Picked[] = []
  const placed = new Set<string>()
  for (const d of dbs) {
    data.push({ kind: 'service', s: d })
    for (const v of t.volumes) if (v.usedBy.includes(d.id) && !placed.has(v.id)) { placed.add(v.id); data.push({ kind: 'volume', v }) }
  }
  for (const a of apps) for (const v of t.volumes) if (v.usedBy.includes(a.id) && !placed.has(v.id)) { placed.add(v.id); data.push({ kind: 'volume', v }) }
  for (const v of t.volumes) if (!placed.has(v.id)) data.push({ kind: 'volume', v })
  return { access: t.access, hosts: t.hosts, apps, data }
}

function describe(x: Picked, t: TopologyDto, onPublish: () => void): NodeDesc {
  if (x.kind === 'access') {
    const a = x.a
    const Icon = WAY_ICON[a.way]
    if (a.way === 'public' && !a.on && !a.paused) {
      return {
        id: a.id, col: 0, icon: <Icon />, title: 'Internet', sub: 'aus', off: true,
        action: <button type="button" className="topo-link" onClick={onPublish}>Veröffentlichen <span aria-hidden="true">→</span></button>,
      }
    }
    // Internet kurz («mit Access», «Cloudflare»); ausgeschrieben steht es in der Seitenkarte
    const detail = a.way === 'public' ? (a.detail === 'Cloudflare Access' ? 'mit Access' : 'Cloudflare') : a.detail
    return { id: a.id, col: 0, icon: a.paused ? <IconPause /> : <Icon />, title: TOPOLOGY_WAY_LABEL[a.way], sub: a.paused ? 'pausiert' : a.on ? detail : 'aus', off: !a.on }
  }
  if (x.kind === 'host') {
    const h = x.h
    const tls = hostTls(h)
    return {
      id: h.id, col: 1, icon: <IconRoute />, title: h.hostname, sub: hostWays(h), off: h.paused,
      meta: h.fallback ? undefined : { left: plural(h.headers, 'Header', 'Header'), right: <State {...tls} /> },
    }
  }
  if (x.kind === 'service') {
    const s = x.s
    const st = serviceState(s)
    const col: Col = s.database ? 3 : 2
    if (t.kind === 'static') return { id: s.id, col, icon: <IconFiles />, title: s.name, sub: 'Statische Seite', meta: { left: <State {...st} /> } }
    if (s.database) {
      return { id: s.id, col, icon: <IconDb />, title: s.name, sub: [s.database, s.version].filter(Boolean).join(' '), meta: { left: <State {...st} />, right: 'intern' } }
    }
    // Port zuerst: er passt immer, das Image wird bei Platzmangel gekürzt
    const sub = [s.port ? `:${s.port}` : null, imageShort(s.image)].filter(Boolean).join(' · ') || null
    const right = s.web ? (s.version ? <span className="topo-mono">{shortVersion(s.version)}</span> : undefined)
      : s.usage ? `CPU ${Math.round((s.usage.cpu / (t.limits.cpu || 1)) * 100)} %` : s.version ? <span className="topo-mono">{shortVersion(s.version)}</span> : undefined
    return { id: s.id, col, icon: s.web ? <IconWindow /> : <IconCog />, title: s.name, sub, meta: { left: <State {...st} />, right } }
  }
  const v = x.v
  const users = v.usedBy.map((id) => t.services.find((s) => s.id === id)?.name).filter(Boolean).join(', ')
  return {
    id: v.id, col: 3, icon: <IconDisk />, title: v.name,
    // Grösse nur, wenn bekannt (sonst wer es einhängt) – nichts erfinden
    sub: v.sizeBytes !== null ? `Volume · ${gb(v.sizeBytes)} GB` : users ? `Volume · ${users}` : 'Volume',
    meta: v.usedBy.length === 0 ? { left: <State word="nicht eingehängt" tone="neutral" /> } : undefined,
  }
}

function NodeView({ d, selected, onSelect, nodeRef }: { d: NodeDesc; selected: boolean; onSelect: (id: string) => void; nodeRef?: (el: HTMLElement | null) => void }) {
  const body = (
    <>
      <span className="topo-node-top">
        <span className="topo-icon">{d.icon}</span>
        <span className="topo-node-text">
          <span className="topo-node-title" title={d.title}>{d.title}</span>
          {d.sub && <span className="topo-node-sub" title={d.sub}>{d.sub}</span>}
        </span>
      </span>
      {d.meta && (d.meta.left || d.meta.right) && (
        <span className="topo-node-meta"><span>{d.meta.left}</span><span>{d.meta.right}</span></span>
      )}
    </>
  )
  const cls = `topo-node${d.off ? ' topo-node-off' : ''}${selected ? ' topo-node-selected' : ''}`
  // Mit eigener Aktion kein Knopf um den Knopf: ein Feld, der Link darin ist das Ziel
  if (d.action) {
    return <div ref={nodeRef} className={cls} data-node={d.id}>{body}<span className="topo-node-action">{d.action}</span></div>
  }
  return (
    <button ref={nodeRef} type="button" className={cls} data-node={d.id} aria-pressed={selected} onClick={() => onSelect(d.id)}>
      {body}
    </button>
  )
}

/* --- Fläche mit Linien -------------------------------------------------------------- */

const COLS: { title: string; sub: (t: TopologyDto) => string; empty: string }[] = [
  { title: 'Zugang', sub: () => 'wer hereinkommt', empty: 'Kein Weg eingerichtet' },
  { title: 'Eingang', sub: () => 'Caddy · Header', empty: 'Keine Route – nirgends erreichbar' },
  { title: 'Dienste', sub: (t) => (t.kind === 'compose' ? 'aus compose.yaml' : t.kind === 'static' ? 'statische Seite' : 'ein Container'), empty: 'Kein Dienst' },
  { title: 'Daten', sub: () => 'Datenbank · Volumes', empty: 'Keine Datenbank, keine Volumes' },
]

interface Box { x: number; y: number; w: number; h: number; col: Col }

function edgePath(a: Box, b: Box): string {
  if (a.col === b.col) {
    // Gleiche Spalte (Datenbank → ihr Volume): Bogen rechts aussen, nie durch einen Knoten
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x + b.w, y2 = b.y + b.h / 2
    return `M${x1} ${y1} C${x1 + 18} ${y1}, ${x2 + 18} ${y2}, ${x2} ${y2}`
  }
  const [l, r] = a.col < b.col ? [a, b] : [b, a]
  const x1 = l.x + l.w, y1 = l.y + l.h / 2, x2 = r.x, y2 = r.y + r.h / 2
  const mx = (x1 + x2) / 2
  return `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
}

function Canvas({ t, cols, nodes, selected, onSelect }: {
  t: TopologyDto; cols: NodeDesc[][]; nodes: Map<string, NodeDesc>; selected: string | null; onSelect: (id: string) => void
}) {
  const body = useRef<HTMLDivElement>(null)
  const els = useRef(new Map<string, HTMLElement>())
  const [boxes, setBoxes] = useState<{ w: number; h: number; at: Map<string, Box> }>({ w: 0, h: 0, at: new Map() })

  useLayoutEffect(() => {
    const root = body.current
    if (!root) return
    const measure = () => {
      const base = root.getBoundingClientRect()
      const at = new Map<string, Box>()
      for (const [id, el] of els.current) {
        const r = el.getBoundingClientRect()
        const d = nodes.get(id)
        if (d) at.set(id, { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height, col: d.col })
      }
      setBoxes({ w: base.width, h: base.height, at })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    for (const el of els.current.values()) ro.observe(el)
    return () => ro.disconnect()
  }, [t, nodes])

  const edges = t.edges.filter((e) => boxes.at.has(e.from) && boxes.at.has(e.to))
  // Gestrichelte zuerst, damit durchgezogene darüber liegen
  const ordered = [...edges.filter((e) => !e.on), ...edges.filter((e) => e.on)]
  const rows = Math.max(1, ...cols.map((c) => c.length))

  return (
    <div className="topo-canvas">
      <div className="topo-cols-head">
        {COLS.map((c) => (
          <div key={c.title} className="topo-col-head">
            <h3>{c.title}</h3>
            <span>{c.sub(t)}</span>
          </div>
        ))}
      </div>
      <div ref={body} className="topo-body" style={{ ['--topo-rows' as string]: rows }}>
        <svg className="topo-edges" width={boxes.w} height={boxes.h} viewBox={`0 0 ${boxes.w || 1} ${boxes.h || 1}`} aria-hidden="true">
          {ordered.map((e) => <EdgeView key={`${e.from}>${e.to}`} e={e} a={boxes.at.get(e.from)!} b={boxes.at.get(e.to)!} />)}
        </svg>
        {cols.map((list, i) => (
          <div key={i} className="topo-col" aria-label={COLS[i]!.title} role="group">
            {list.length === 0 && <p className="topo-col-empty">{COLS[i]!.empty}</p>}
            {list.map((d) => (
              <NodeView key={d.id} d={d} selected={selected === d.id} onSelect={onSelect}
                nodeRef={(el) => { if (el) els.current.set(d.id, el); else els.current.delete(d.id) }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function EdgeView({ e, a, b }: { e: TopologyEdgeDto; a: Box; b: Box }) {
  const d = edgePath(a, b)
  const end = a.col === b.col ? { x: b.x + b.w, y: b.y + b.h / 2 } : a.col < b.col ? { x: b.x, y: b.y + b.h / 2 } : { x: a.x, y: a.y + a.h / 2 }
  return (
    <g className={e.on ? 'topo-edge' : 'topo-edge topo-edge-off'}>
      <path d={d} />
      {e.on && <circle cx={end.x} cy={end.y} r="3" />}
    </g>
  )
}

/** Unter 700 px: dieselben Knoten als Liste, nach Spalten gruppiert (ohne Linien) */
function List({ t, cols, selected, onSelect }: { t: TopologyDto; cols: NodeDesc[][]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="topo-list">
      {cols.map((list, i) => (
        <section key={i} className="topo-list-group" aria-label={COLS[i]!.title}>
          <div className="topo-col-head">
            <h3>{COLS[i]!.title}</h3>
            <span>{COLS[i]!.sub(t)}</span>
          </div>
          {list.length === 0 && <p className="topo-col-empty">{COLS[i]!.empty}</p>}
          {list.map((d) => <NodeView key={d.id} d={d} selected={selected === d.id} onSelect={onSelect} />)}
        </section>
      ))}
    </div>
  )
}

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setMatch(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return match
}

/* --- Reiter ------------------------------------------------------------------------- */

export function Topology(props: TopologyProps) {
  const { p, onPublish } = props
  const q = useQuery({
    queryKey: ['topology', p.id],
    queryFn: () => api.topology(p.id),
    // CPU/RAM sind Momentaufnahmen: einmal pro Minute; Zustandswechsel kommen über den Ereignisstrom
    refetchInterval: FALLBACK_MS,
  })
  const narrow = useMedia('(max-width: 700px)')
  const [picked, setPicked] = useState<string | null>(null)
  const titleId = useId()
  const t = q.data?.topology

  const layout = useMemo(() => {
    if (!t) return null
    const c = columns(t)
    const items: Picked[][] = [c.access.map((a) => ({ kind: 'access' as const, a })), c.hosts.map((h) => ({ kind: 'host' as const, h })), c.apps.map((s) => ({ kind: 'service' as const, s })), c.data]
    const cols = items.map((list) => list.map((x) => describe(x, t, onPublish)))
    const byId = new Map<string, Picked>()
    for (const list of items) for (const x of list) byId.set(x.kind === 'access' ? x.a.id : x.kind === 'host' ? x.h.id : x.kind === 'service' ? x.s.id : x.v.id, x)
    const nodes = new Map(cols.flat().map((d) => [d.id, d]))
    return { cols, byId, nodes }
  }, [t]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!t && q.isError) return <div className="tab-panel"><ErrorState what="Der Aufbau" error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} /></div>
  if (!t || !layout) {
    return (
      <div className="tab-panel topo">
        <Loading label="Aufbau wird geladen" className="topo-card topo-skeleton"><Sk h={420} r="sm" /></Loading>
        <div className="topo-side topo-card" aria-hidden="true"><SkLines n={6} /></div>
      </div>
    )
  }

  const selected = picked && layout.byId.has(picked) ? picked : (t.main ?? layout.cols.flat().find((d) => !d.action)?.id ?? null)
  const current = selected ? layout.byId.get(selected) ?? null : null
  const counts = [plural(t.services.length, 'Dienst', 'Dienste'), t.volumes.length ? plural(t.volumes.length, 'Volume', 'Volumes') : null].filter(Boolean).join(' · ')

  return (
    <div className="tab-panel topo">
      <section className="topo-card topo-main" aria-labelledby={titleId}>
        <div className="topo-head">
          <h2 id={titleId}>Aufbau</h2>
          <span className="muted num">{counts}</span>
        </div>
        {narrow
          ? <List t={t} cols={layout.cols} selected={selected} onSelect={setPicked} />
          : <Canvas t={t} cols={layout.cols} nodes={layout.nodes} selected={selected} onSelect={setPicked} />}
        <div className="topo-legend">
          {!narrow && <span><i className="topo-legend-line" aria-hidden="true" />verbunden</span>}
          {!narrow && <span><i className="topo-legend-line topo-legend-off" aria-hidden="true" />aus</span>}
          <span>Knoten wählen zeigt Details</span>
        </div>
      </section>
      {current && <Side {...props} t={t} x={current} onSelect={setPicked} />}
    </div>
  )
}

/* --- Seitenkarte -------------------------------------------------------------------- */

function Side(props: TopologyProps & { t: TopologyDto; x: Picked; onSelect: (id: string) => void }) {
  const { x } = props
  return (
    <aside className="topo-card topo-side" aria-label="Details zum gewählten Knoten">
      {x.kind === 'service' && <ServiceSide {...props} s={x.s} />}
      {x.kind === 'host' && <HostSide {...props} h={x.h} />}
      {x.kind === 'access' && <AccessSide {...props} a={x.a} />}
      {x.kind === 'volume' && <VolumeSide {...props} v={x.v} />}
    </aside>
  )
}

function SideHead({ title, badge, sub }: { title: string; badge?: ReactNode; sub?: ReactNode }) {
  return (
    <>
      <div className="topo-side-head">
        <h2 title={title}>{title}</h2>
        {badge}
      </div>
      {sub && <p className="topo-side-sub">{sub}</p>}
    </>
  )
}

function Pill({ word, tone }: { word: string; tone: Tone }) {
  return <span className={`topo-pill topo-tone-${tone}`}><span className="topo-dot" aria-hidden="true" />{word}</span>
}

/** «Erreichbar über»: die bestehenden Schalter (Tailnet, LAN) und Veröffentlichen */
function Reach({ p, t, onPublish }: { p: ProjectDto; t: TopologyDto; onPublish: () => void }) {
  const reach = useInternalReach(p)
  const tailId = useId()
  const lanId = useId()
  const pubRoute = p.routes.find((r) => r.target === 'public')
  const lanNip = t.hosts.find((h) => h.fallback && h.ways.includes('lan'))?.hostname
  const has = (w: TopologyWay) => t.access.some((a) => a.way === w)
  return (
    <div className="topo-side-rows">
      {has('tailnet') && (
        <div className="topo-side-row">
          <div><span id={tailId}>Tailnet</span><small>{reach.want.has('tailnet') ? reach.host ?? 'an' : 'aus'}</small></div>
          <Switch checked={reach.want.has('tailnet')} labelledBy={tailId} busy={reach.pending} onChange={(on) => reach.toggle('tailnet', on)} />
        </div>
      )}
      {has('lan') && (
        <div className="topo-side-row">
          <div><span id={lanId}>Heimnetz (LAN)</span><small>{reach.want.has('lan') ? lanNip ?? reach.host ?? 'an' : 'aus'}</small></div>
          <Switch checked={reach.want.has('lan')} labelledBy={lanId} busy={reach.pending} onChange={(on) => reach.toggle('lan', on)} />
        </div>
      )}
      {has('public') && (
        <div className="topo-side-row">
          <div>Internet<small>{!pubRoute ? 'nicht öffentlich' : pubRoute.pausedAt ? `pausiert · ${pubRoute.hostname}` : pubRoute.hostname}</small></div>
          <button type="button" className="button-small" onClick={onPublish}>{pubRoute ? 'Verwalten' : 'Veröffentlichen'}</button>
        </div>
      )}
      {reach.saved && <p className="topo-side-note" role="status">Erreichbarkeit gespeichert</p>}
    </div>
  )
}

function Bar({ label, now, limit, unit, fmt }: { label: string; now: number; limit: number; unit: string; fmt: (v: number) => string }) {
  const ratio = limit ? Math.min(1, now / limit) : 0
  const tone = ratio >= 0.9 ? 'bad' : ratio >= 0.7 ? 'warn' : 'ok'
  return (
    <div className="topo-bar">
      <div className="topo-bar-head"><span>{label}</span><span><strong className="num">{fmt(now)}</strong> <span className="muted">von {fmt(limit)}{unit ? ` ${unit}` : ''}</span></span></div>
      <div className="topo-bar-track" role="img" aria-label={`${label}: ${fmt(now)} von ${fmt(limit)}${unit ? ` ${unit}` : ''}`}>
        <i className={`topo-bar-fill tone-${tone}`} style={{ width: `${Math.max(2, Math.round(ratio * 100))}%` }} />
      </div>
    </div>
  )
}

function LastLines({ projectId, service }: { projectId: string; service: string | null }) {
  const q = useQuery({
    queryKey: ['log-tail', projectId, service],
    queryFn: () => api.logLines(projectId, '1h', service),
    refetchInterval: FALLBACK_MS,
  })
  if (!q.data && q.isError) return <p className="topo-side-note">Die Logzeilen sind gerade nicht lesbar.</p>
  if (!q.data) return <Loading label="Logzeilen werden geladen"><SkLines n={3} /></Loading>
  const lines = q.data.lines.slice(-3)
  if (q.data.hint || lines.length === 0) return <p className="topo-side-note">{q.data.hint ? 'Kein laufender Container – keine Ausgabe.' : 'Keine Ausgabe in der letzten Stunde.'}</p>
  return (
    <div className="topo-log" role="region" aria-label="Letzte Logzeilen">
      {lines.map((l, i) => (
        <div key={i} className="topo-log-line" title={l.text}>
          {(l.level === 'error' || l.level === 'warn') && <span className={`topo-log-level logv-level-${l.level}`}>{l.level === 'error' ? 'ERROR' : 'WARN'} </span>}
          {l.text.replace(/^(ERROR|WARN)\s+/, '')}
        </div>
      ))}
    </div>
  )
}

function ServiceSide({ p, t, s, onLogs, onPublish, onRestart, restartBusy, onSelect }: TopologyProps & { t: TopologyDto; s: TopologyServiceDto; onSelect: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false)
  const st = serviceState(s)
  const isStatic = t.kind === 'static'
  const restartable = !isStatic && p.desiredState === 'running' && Boolean(p.activeDeployment)
  const sub = isStatic
    ? <>Statische Seite{s.version ? <> · <span className="topo-mono">{shortVersion(s.version)}</span></> : null}</>
    : <>{s.image ?? 'Image unbekannt'}{s.port ? ` · Port ${s.port}` : ''}</>
  const users = t.edges.filter((e) => e.to === s.id && e.via !== 'route').map((e) => t.services.find((x) => x.id === e.from)).filter((x): x is TopologyServiceDto => Boolean(x))
  const mounts = t.volumes.filter((v) => v.usedBy.includes(s.id))
  return (
    <>
      <SideHead title={s.name} badge={<Pill {...st} />} sub={sub} />

      <h3 className="topo-side-label">Erreichbar über</h3>
      {s.web
        ? <Reach p={p} t={t} onPublish={onPublish} />
        : (
          <p className="topo-side-text">
            Keine Route: nur im Projekt-Netz erreichbar
            {users.length > 0 && <> – genutzt von {users.map((u, i) => <span key={u.id}>{i ? ', ' : ''}<button type="button" className="link-button" onClick={() => onSelect(u.id)}>{u.name}</button></span>)}</>}.
          </p>
        )}

      {mounts.length > 0 && (
        <>
          <h3 className="topo-side-label">Volumes</h3>
          <ul className="topo-side-list">
            {mounts.map((v) => <li key={v.id}><button type="button" className="link-button" onClick={() => onSelect(v.id)}>{v.name}</button>{v.paths[s.id] && <span className="muted"> · {v.paths[s.id]}</span>}</li>)}
          </ul>
        </>
      )}

      {!isStatic && (
        <>
          <h3 className="topo-side-label">Ressourcen</h3>
          {s.usage ? (
            <div className="topo-bars">
              <Bar label="CPU" now={s.usage.cpu} limit={t.limits.cpu} unit="" fmt={fmtCpu} />
              <Bar label="RAM" now={s.usage.memMb} limit={t.limits.memoryMb} unit="MB" fmt={fmtMb} />
            </div>
          ) : (
            <p className="topo-side-note">{s.state === 'running' ? 'Gerade keine Messung lesbar.' : 'Keine Messung – der Dienst läuft nicht.'}</p>
          )}
          {t.kind === 'compose' && <p className="topo-side-note">Die Grenzen gelten für jeden Dienst einzeln.</p>}

          <h3 className="topo-side-label">Letzte Logzeilen</h3>
          <LastLines projectId={p.id} service={t.kind === 'compose' ? s.name : null} />
        </>
      )}

      <div className="topo-side-actions">
        {!confirming && <button type="button" className="button-small" onClick={() => onLogs(t.kind === 'compose' ? s.name : null)}>{isStatic ? 'Alle Zugriffe' : 'Alle Logs'}</button>}
        {restartable && !confirming && <button type="button" className="button-small" disabled={restartBusy} onClick={() => setConfirming(true)}>Neu starten</button>}
        {confirming && (
          <InlineConfirm
            label="Neu starten bestätigen"
            small
            as="div"
            className="topo-confirm"
            note={t.kind === 'compose'
              ? <>Alle Dienste des Projekts sind kurz offline, dann läuft dieselbe Fassung wieder.</>
              : <>{isPublic(p) ? 'Öffentlich erreichbar – ' : ''}kurz offline, dann dieselbe Fassung wieder.</>}
            confirmLabel="Ja, neu starten"
            busy={restartBusy}
            onCancel={() => setConfirming(false)}
            onConfirm={() => { setConfirming(false); onRestart() }}
          />
        )}
      </div>
    </>
  )
}

function HostSide({ t, h, onManageHeaders, onSelect }: TopologyProps & { t: TopologyDto; h: TopologyHostDto; onSelect: (id: string) => void }) {
  const tls = hostTls(h)
  const target = t.services.find((s) => s.id === h.service)
  const tlsText = h.tls === 'cloudflare' ? 'macht Cloudflare (Tunnel)'
    : h.tls === 'https' ? (h.tlsProblem ?? 'Zertifikat von Caddy, in Ordnung')
    : h.fallback ? 'ohne Zertifikat (nip.io)' : 'ohne Zertifikat (http)'
  return (
    <>
      <SideHead title={h.hostname} badge={<Pill {...tls} />} sub={h.fallback ? `nip.io-Ausweich · ${hostWays(h)}` : 'Route in Caddy'} />
      <dl className="topo-side-dl">
        <dt>Wege</dt><dd>{h.ways.map((w) => WAY_LONG[w]).join(', ')}</dd>
        <dt>TLS</dt><dd>{tlsText}</dd>
        <dt>Header</dt><dd>{h.headers ? `${h.headers} gesetzt` : 'keine gesetzt'}</dd>
        <dt>Leitet an</dt><dd>{target ? <button type="button" className="link-button" onClick={() => onSelect(target.id)}>{target.name}</button> : '–'}{target?.port ? ` · Port ${target.port}` : ''}</dd>
      </dl>
      <div className="topo-side-actions">
        {!h.paused && <a className="button button-small" href={h.url} target="_blank" rel="noreferrer">Öffnen <IconExternal /></a>}
        <button type="button" className="button-small" onClick={onManageHeaders}>Header verwalten</button>
      </div>
    </>
  )
}

function AccessSide({ p, t, a, onPublish }: TopologyProps & { t: TopologyDto; a: TopologyAccessDto }) {
  const state: { word: string; tone: Tone } = a.paused ? { word: 'pausiert', tone: 'warn' } : a.on ? { word: 'an', tone: 'ok' } : { word: 'aus', tone: 'neutral' }
  const hosts = t.hosts.filter((h) => h.ways.includes(a.way))
  const about = a.way === 'public' ? 'Über Cloudflare Tunnel aus dem Internet.' : a.way === 'tailnet' ? 'Im Heimnetz und unterwegs, über Tailscale.' : 'Nur im Heimnetz, ohne Tailnet; braucht lokalen DNS, sonst nip.io.'
  return (
    <>
      <SideHead title={WAY_LONG[a.way]} badge={<Pill {...state} />} sub={a.detail ?? undefined} />
      <p className="topo-side-text">{about}</p>
      {hosts.length > 0 && (
        <>
          <h3 className="topo-side-label">Namen</h3>
          <ul className="topo-side-list">{hosts.map((h) => <li key={h.id}>{h.hostname}</li>)}</ul>
        </>
      )}
      <h3 className="topo-side-label">Erreichbar über</h3>
      <Reach p={p} t={t} onPublish={onPublish} />
    </>
  )
}

function VolumeSide({ t, v, onSelect }: TopologyProps & { t: TopologyDto; v: TopologyVolumeDto; onSelect: (id: string) => void }) {
  const users = v.usedBy.map((id) => t.services.find((s) => s.id === id)).filter((s): s is TopologyServiceDto => Boolean(s))
  return (
    <>
      <SideHead title={v.name} sub={v.sizeBytes !== null ? `Volume · ${gb(v.sizeBytes)} GB` : 'Benanntes Volume'} />
      <h3 className="topo-side-label">Eingehängt in</h3>
      {users.length
        ? <ul className="topo-side-list">{users.map((s) => <li key={s.id}><button type="button" className="link-button" onClick={() => onSelect(s.id)}>{s.name}</button>{v.paths[s.id] ? <span className="muted"> · {v.paths[s.id]}</span> : null}</li>)}</ul>
        : <p className="topo-side-text">Kein Dienst hängt es gerade ein.</p>}
      <p className="topo-side-note">Bleibt bei Deploys und Neustarts erhalten. Gelöscht wird es nur mit dem Projekt, und nur wenn du das dort ausdrücklich wählst.</p>
    </>
  )
}
