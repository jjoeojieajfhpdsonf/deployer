import { RESERVED_PUBLIC_LABELS, normalizePublicLabel, type PublicNameCheckDto } from '@airlock/shared'

/**
 * Rein: Prüfung eines öffentlichen Namens aus dem, was Datenbank und
 * Cloudflare liefern (der Aufrufer holt Zonen, Belegung und DNS-Einträge).
 * Gleich für die Karte «Veröffentlichung», «Neues Projekt» und MCP.
 */
export interface PublicNameFacts {
  /** Zonen der Umgebung */
  zones: string[]
  /** Hauptzone der Umgebung (Standard, wenn keine Zone angegeben ist) */
  mainZone: string | null
  /** Interne Basis (z. B. int.example.ch): darunter kein öffentlicher Name */
  baseDomain: string | null
}

/** Name, Zone und Host bestimmen; Form, reserviert, Zone und interne Basis prüfen. */
export function shapePublicName(input: { label: string; zone?: string; apex?: boolean }, f: PublicNameFacts): PublicNameCheckDto {
  const zones = f.zones
  const zoneName = input.zone ?? (f.mainZone && zones.includes(f.mainZone) ? f.mainZone : zones[0] ?? null)
  const label = input.apex ? '' : normalizePublicLabel(input.label)
  const out: PublicNameCheckDto = { host: null, label, zone: zoneName, apex: Boolean(input.apex), zones, problems: [], existing: null }
  if (!zoneName || !zones.includes(zoneName)) {
    out.problems.push({ kind: 'zone', message: zoneName ? `${zoneName} gehört nicht zu dieser Umgebung` : 'Diese Umgebung hat noch keine Zone bei Cloudflare' })
    return out
  }
  if (!input.apex && !label) {
    out.problems.push({ kind: 'format', message: 'Gib einen Namen an, z.B. solar' })
    return out
  }
  const host = input.apex ? zoneName : `${label}.${zoneName}`
  out.host = host
  if (!input.apex && (RESERVED_PUBLIC_LABELS as readonly string[]).includes(label)) out.problems.push({ kind: 'reserved', message: `«${label}» ist reserviert` })
  if (f.baseDomain && (host === f.baseDomain || host.endsWith(`.${f.baseDomain}`))) out.problems.push({ kind: 'internal', message: `${host} liegt unter der internen Basis` })
  return out
}

/** In Airlock vergeben (öffentliche Route eines anderen Projekts). */
export function markTaken(out: PublicNameCheckDto, takenByOther: boolean): void {
  if (takenByOther && out.host) out.problems.push({ kind: 'taken', message: `${out.host} ist in Airlock schon vergeben` })
}

/**
 * Vorhandener DNS-Eintrag bei Cloudflare, der nicht von Airlock stammt.
 * Worker-Routen und Custom Domains stehen als Platzhalter (AAAA 100:: bzw.
 * A 192.0.2.1) in der Zone – die lassen sich nicht ersetzen, nur in
 * Cloudflare entfernen.
 */
export function markForeignRecord(out: PublicNameCheckDto, records: { type: string; content: string; managed: boolean }[]): void {
  if (!out.host) return
  const foreign = records.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type)).find((r) => !r.managed)
  if (!foreign) return
  const worker = (foreign.type === 'AAAA' && foreign.content === '100::') || (foreign.type === 'A' && foreign.content === '192.0.2.1')
  out.existing = { type: foreign.type, content: foreign.content, worker }
  out.problems.push({ kind: 'dns', message: worker
    ? `Für ${out.host} gibt es bei Cloudflare schon einen Worker bzw. eine Custom Domain`
    : `Für ${out.host} gibt es bei Cloudflare schon einen Eintrag (${foreign.type} → ${foreign.content}), der nicht von Airlock stammt` })
}

/**
 * Was das Speichern verhindert: alles ausser einem fremden DNS-Eintrag,
 * dessen Ersetzen ausdrücklich bestätigt ist (nie bei Worker/Custom Domain).
 */
export function blockingProblems(c: PublicNameCheckDto, takeOver: boolean): PublicNameCheckDto['problems'] {
  return c.problems.filter((x) => !(x.kind === 'dns' && takeOver && c.existing && !c.existing.worker))
}
