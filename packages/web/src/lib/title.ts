import { PRODUCT_NAME } from '@airlock/shared'

/** Art eines laufenden Vorgangs (wie lib/activities.ts) */
export type RunningKind = 'deploy' | 'scan' | 'cert' | 'tunnel' | 'backup'

const RUNNING: Record<RunningKind, string> = {
  deploy: 'Deploy läuft',
  scan: 'Scan läuft',
  cert: 'Zertifikat wird geholt',
  tunnel: 'Tunnel wird eingerichtet',
  backup: 'Backup läuft',
}

/**
 * UI-Qualität 3: Tab-Titel «<Seite/Projekt> · Airlock», bei laufendem Vorgang
 * mit Präfix: «Deploy läuft · Wetterstation · Airlock» auf der Seite des
 * Projekts, sonst mit Namen («Deploy Rezepte-API läuft · Fotoalbum · Airlock»);
 * bei mehreren «2 Vorgänge laufen · …».
 */
export function titleFor(page: string | null, running: { kind: RunningKind; projectName?: string }[]): string {
  const base = page ? `${page} · ${PRODUCT_NAME}` : PRODUCT_NAME
  if (running.length === 0) return base
  if (running.length > 1) return `${running.length} Vorgänge laufen · ${base}`
  const a = running[0]!
  const prefix = a.projectName && a.projectName !== page ? RUNNING[a.kind].replace(' läuft', ` ${a.projectName} läuft`) : RUNNING[a.kind]
  return `${prefix} · ${base}`
}

/**
 * Bildmarke wie in index.html (hell #242424, dunkel #f2f2f3), optional mit
 * Punkt oben rechts – gescheiterter Deploy oder kritischer Befund. Der Punkt
 * ist nur ein Zusatz; die Seiten sagen es in Worten.
 */
export function faviconSvg(dot: boolean): string {
  const mark = "<path d='M4 28V16a12 12 0 0 1 24 0v12h-4V16a8 8 0 0 0-16 0v12z'/><path d='M12 28V16a4 4 0 0 1 8 0v12z'/>"
  // Punkt mit hellem bzw. dunklem Rand, damit er sich von der Marke abhebt
  const badge = dot ? "<circle class='r' cx='25' cy='7' r='7'/><circle class='d' cx='25' cy='7' r='5'/>" : ''
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><style>.m{fill:#242424}.r{fill:#fff}.d{fill:#c0281a}@media (prefers-color-scheme: dark){.m{fill:#f2f2f3}.r{fill:#1a1a1a}.d{fill:#f47a70}}</style><g class='m'>${mark}</g>${badge}</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
