import type { FindingInput, Severity } from './score.js'
import { ZAP_COVERED_BY_HEADERS } from './headers.js'

/**
 * Parser für die Berichte der Scanner. Getestet gegen gekürzte echte
 * Ausgaben (Trivy 0.58, ZAP 2.16, Nuclei 3.3, testssl.sh 3.2).
 *
 * Wichtig: Nichts aus den Berichten, das ein gefundenes Secret enthalten
 * könnte (Trivy "Match", Nuclei "extracted-results"/"response"), wird
 * übernommen.
 */

const sev = (s: string | undefined): Severity | null => {
  switch ((s ?? '').toUpperCase()) {
    case 'CRITICAL': return 'critical'
    case 'HIGH': return 'high'
    case 'MEDIUM': return 'medium'
    case 'LOW': return 'low'
    default: return null
  }
}

const stripHtml = (s: string | undefined) =>
  (s ?? '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()

/* --- Trivy ---------------------------------------------------------------- */

interface TrivyVuln { VulnerabilityID: string; PkgName: string; InstalledVersion?: string; FixedVersion?: string; Severity?: string; Title?: string }
interface TrivySecret { RuleID?: string; Title?: string; Severity?: string; StartLine?: number }
interface TrivyMisconf { ID?: string; Title?: string; Severity?: string; Status?: string; Resolution?: string; Description?: string }
interface TrivyResult { Target?: string; Class?: string; Type?: string; Vulnerabilities?: TrivyVuln[] | null; Secrets?: TrivySecret[] | null; Misconfigurations?: TrivyMisconf[] | null }

/** Trivy-Typen aus Lockfiles im Quellcode (nicht: installierte Pakete im Image). */
const LOCKFILE_TYPES = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pipenv', 'poetry', 'uv', 'gomod', 'cargo', 'composer', 'bundler', 'nuget', 'pub', 'mix', 'swift', 'cocoapods'])

/**
 * CVEs werden je Paket zusammengefasst (höchster Schweregrad, Liste der IDs,
 * eine Behebung: auf die höchste Fix-Version aktualisieren). Ein altes Image
 * hätte sonst 100 Einzelbefunde und sofort den Score 0.
 */
export function parseTrivy(json: unknown): FindingInput[] {
  const doc = json as { Results?: TrivyResult[] }
  const out: FindingInput[] = []
  for (const r of doc.Results ?? []) {
    const target = r.Target ?? ''

    const byPkg = new Map<string, { sev: Severity; ids: string[]; installed: string; fixed: Set<string>; title?: string }>()
    for (const v of r.Vulnerabilities ?? []) {
      const s = sev(v.Severity)
      if (!s || !v.FixedVersion) continue
      const key = v.PkgName
      const e = byPkg.get(key) ?? { sev: s, ids: [], installed: v.InstalledVersion ?? '?', fixed: new Set<string>(), title: v.Title }
      if (['critical', 'high', 'medium', 'low'].indexOf(s) < ['critical', 'high', 'medium', 'low'].indexOf(e.sev)) {
        e.sev = s
        e.title = v.Title
      }
      e.ids.push(v.VulnerabilityID)
      for (const f of v.FixedVersion.split(',')) e.fixed.add(f.trim())
      byPkg.set(key, e)
    }
    for (const [pkg, e] of byPkg) {
      const ids = [...new Set(e.ids)]
      out.push({
        tool: 'trivy',
        severity: e.sev,
        title: `${pkg}: ${ids.length} bekannte Schwachstelle${ids.length === 1 ? '' : 'n'} mit verfügbarem Fix`,
        location: `${target} · ${pkg} ${e.installed}`,
        // Nicht das Target: bei gebauten Images steckt darin der Tag (neu pro Deploy).
        // Mit Schweregrad: wird ein akzeptiertes Paket kritischer, ist es ein neuer Befund.
        key: `vuln:${r.Class ?? ''}:${r.Type ?? ''}:${r.Class === 'os-pkgs' ? '' : target}:${pkg}:${e.sev}`,
        description: `${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ` und ${ids.length - 8} weitere` : ''}${e.title ? `. Schwerste: ${e.title}` : ''}`,
        fix: LOCKFILE_TYPES.has(r.Type ?? '')
          ? `${pkg} auf ${[...e.fixed].join(' bzw. ')} oder neuer aktualisieren und ${target.split('/').pop()} neu erzeugen.`
          : `${pkg} auf ${[...e.fixed].join(' bzw. ')} oder neuer aktualisieren (meist: Basis-Image aktualisieren und neu bauen).`,
      })
    }

    for (const s of r.Secrets ?? []) {
      // Bewusst ohne "Match": darin steckt (wenn auch maskiert) das Secret.
      out.push({
        tool: 'trivy',
        severity: sev(s.Severity) ?? 'high',
        title: `Secret im Code: ${s.Title ?? s.RuleID ?? 'unbekannt'}`,
        location: `${target}${s.StartLine ? `:${s.StartLine}` : ''}`,
        // Ohne Zeile: die verschiebt sich mit jeder Änderung darüber.
        key: `secret:${s.RuleID ?? s.Title ?? ''}:${target}`,
        description: 'Im Code oder im Image steht ein Zugangsschlüssel. Wer das Image oder die Seite bekommt, bekommt ihn mit.',
        fix: 'Schlüssel sofort beim Anbieter widerrufen, aus dem Code entfernen und als geheime Umgebungsvariable des Projekts setzen.',
      })
    }

    for (const m of r.Misconfigurations ?? []) {
      if (m.Status && m.Status !== 'FAIL') continue
      const s = sev(m.Severity)
      if (!s) continue
      out.push({
        tool: 'trivy',
        severity: s,
        title: m.Title ?? m.ID ?? 'Fehlkonfiguration',
        location: `${target}${m.ID ? ` (${m.ID})` : ''}`,
        key: `misconf:${m.ID ?? m.Title ?? ''}:${target}`,
        description: m.Description ?? '',
        fix: m.Resolution ?? '',
      })
    }
  }
  return out
}

/* --- ZAP ---------------------------------------------------------------------- */

interface ZapAlert { pluginid?: string; name?: string; riskcode?: string; desc?: string; solution?: string; instances?: { uri?: string }[] }

export function parseZap(json: unknown, targetPrefix?: string): FindingInput[] {
  const doc = json as { site?: { '@name'?: string; alerts?: ZapAlert[] }[] }
  const out: FindingInput[] = []
  for (const site of doc.site ?? []) {
    for (const a of site.alerts ?? []) {
      if (a.pluginid && ZAP_COVERED_BY_HEADERS.has(a.pluginid)) continue
      const risk = Number(a.riskcode)
      const s: Severity | null = risk >= 3 ? 'high' : risk === 2 ? 'medium' : risk === 1 ? 'low' : null
      if (!s) continue
      const uri = a.instances?.[0]?.uri ?? site['@name'] ?? targetPrefix ?? ''
      out.push({
        tool: 'zap',
        severity: s,
        title: a.name ?? `ZAP ${a.pluginid}`,
        location: uri,
        // Die erste Fundstelle wechselt je nach Reihenfolge des Spiders.
        key: `zap:${a.pluginid ?? a.name ?? ''}`,
        description: stripHtml(a.desc).slice(0, 600),
        fix: stripHtml(a.solution).slice(0, 600),
      })
    }
  }
  return out
}

/* --- Nuclei -------------------------------------------------------------------- */

/**
 * JSONL, eine Zeile pro Treffer. Mehrere Vorlagen für dieselbe Stelle (z.B.
 * zwei .env-Vorlagen) werden zu einem Befund zusammengefasst. Info-Treffer
 * zählen nicht. "extracted-results" und Antworten werden nicht übernommen.
 */
export function parseNuclei(jsonl: string): FindingInput[] {
  const byLocation = new Map<string, FindingInput & { names: string[] }>()
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let d: { 'template-id'?: string; 'matched-at'?: string; host?: string; info?: { name?: string; severity?: string; description?: string; remediation?: string } }
    try { d = JSON.parse(line) } catch { continue }
    const s = sev(d.info?.severity)
    if (!s) continue
    const loc = d['matched-at'] ?? d.host ?? ''
    const name = d.info?.name ?? d['template-id'] ?? 'Nuclei-Treffer'
    const prev = byLocation.get(loc)
    if (prev) {
      prev.names.push(name)
      if (['critical', 'high', 'medium', 'low'].indexOf(s) < ['critical', 'high', 'medium', 'low'].indexOf(prev.severity)) prev.severity = s
      continue
    }
    byLocation.set(loc, {
      tool: 'nuclei',
      severity: s,
      title: name,
      location: loc,
      // Pro Stelle; der Titel trägt "(+N ähnliche)" und schwankt mit den Vorlagen.
      key: `nuclei:${loc}`,
      description: (d.info?.description ?? '').trim().slice(0, 600) || 'Offen erreichbare Datei oder Oberfläche, die nicht öffentlich sein sollte.',
      fix: (d.info?.remediation ?? '').trim().slice(0, 600) || 'Die Datei aus dem ausgelieferten Inhalt entfernen oder den Zugriff sperren.',
      names: [name],
    })
  }
  return [...byLocation.values()].map(({ names, ...f }) => ({
    ...f,
    title: names.length > 1 ? `${f.title} (+${names.length - 1} ähnliche)` : f.title,
  }))
}

/* --- testssl.sh ------------------------------------------------------------------- */

interface TestsslItem { id?: string; severity?: string; finding?: string; ip?: string; port?: string }

export function parseTestssl(json: unknown, host: string): FindingInput[] {
  const items = (Array.isArray(json) ? json : (json as { scanResult?: unknown[] }).scanResult ?? []) as TestsslItem[]
  const out: FindingInput[] = []
  for (const i of items) {
    const s = sev(i.severity === 'WARN' ? 'LOW' : i.severity)
    if (!s) continue
    out.push({
      tool: 'testssl',
      severity: s,
      title: `TLS: ${i.id ?? 'Befund'}`,
      location: `${host}${i.port ? `:${i.port}` : ''}`,
      key: `testssl:${i.id ?? ''}`,
      description: (i.finding ?? '').slice(0, 600),
      fix: 'TLS-Konfiguration anpassen (veraltete Protokolle und Verfahren abschalten, Zertifikat prüfen).',
    })
  }
  return out
}
