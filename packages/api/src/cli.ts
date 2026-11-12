import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AuthService } from './auth/service.js'

/**
 * Notausgang auf dem Server (Nacht 3, Etappe 1). Läuft IM Airlock-Container,
 * dort gibt es node:
 *
 *   docker compose exec airlock node dist/cli.js reset-2fa admin
 *   docker exec airlock-app node dist/cli.js reset-2fa admin
 *
 * (`dist/` im Arbeitsverzeichnis /app ist ein Verweis auf packages/api/dist,
 * siehe Dockerfile.) reset-2fa entfernt alle Passkeys, die Authenticator-App
 * und die Wiederherstellungscodes, setzt «Zweiter Faktor erforderlich» auf
 * den Standard zurück, meldet alle Sitzungen ab und schreibt ins Audit-Log.
 * Danach geht die Anmeldung wieder mit dem Passwort allein. Passwort
 * vergessen: ADMIN_PASSWORD in .env ändern und Airlock neu starten.
 */

export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
}

const USAGE = [
  'Airlock – Befehle im Container',
  '',
  '  node dist/cli.js reset-2fa <benutzer>   Passkeys, Authenticator-App und Wiederherstellungscodes',
  '                                          entfernen, alle Sitzungen abmelden (Notausgang)',
  '  node dist/cli.js cleanup                 Vorschau: was das Aufräumen freigeben würde (löscht nichts)',
  '  node dist/cli.js cleanup --apply         aufräumen wie «Jetzt aufräumen» (Server › Speicher)',
  '        --only-label <schlüssel>=<wert>    nur Docker-Objekte mit diesem Label (Test); ohne Build-Cache und Dateien',
  '        --min-age-minutes <n>              Mindestalter für Images und Container (Standard 60)',
  '  node dist/cli.js release-isolation <projekt>',
  '                                          Isolation eines Projekts aufheben (Notausgang, wie «Isolation',
  '                                          aufheben» in Projekt › Security; der Ausgang bleibt abgeschottet)',
  '  node dist/cli.js intrusion-check         eine Runde der Einbruchserkennung (Prozesse, Dateien, Neustarts)',
  '        --only-label <schlüssel>=<wert>    nur Container mit diesem Label (Test); ohne Anmeldung, ohne Meldungen',
  '        --learn-minutes <n>                Lernzeit neuer Container (Standard 10)',
  '  node dist/cli.js help                   diese Hilfe',
  '',
  'Airlock kennt ein Konto. Als <benutzer> gehen «admin» oder der Anzeigename aus ADMIN_NAME.',
]

/** Nacht 3, Etappe 3: Aufräumen auf der Kommandozeile (Vorschau oder --apply) */
export interface CleanupCli {
  apply: boolean
  scope: { key: string; value: string } | null
  minAgeMs: number | undefined
}

export interface CleanupCliResult {
  plan: { items: { kind: string; name: string; project: string | null; reason: string; bytes: number | null }[]; total: number; bytes: number; buildCache: { count: number; bytes: number } | null }
  orphanVolumes: { name: string; project: string | null; bytes: number | null; inUse: boolean }[]
  problems: string[]
  /** Nur mit --apply */
  run?: { freedBytes: number; removed: number; failed: number }
  errors?: string[]
}

/** Rein: Schalter von «cleanup» lesen; null bei Fehlern (Meldung in err) */
export function parseCleanupArgs(args: string[], err: (l: string) => void): CleanupCli | null {
  const o: CleanupCli = { apply: false, scope: null, minAgeMs: undefined }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--apply') o.apply = true
    else if (a === '--only-label') {
      const m = /^([a-z0-9][a-z0-9._-]*)=(.+)$/i.exec(args[++i] ?? '')
      if (!m) { err('--only-label braucht <schlüssel>=<wert>'); return null }
      o.scope = { key: m[1]!, value: m[2]! }
    } else if (a === '--min-age-minutes') {
      const n = Number(args[++i])
      if (!Number.isInteger(n) || n < 0) { err('--min-age-minutes braucht eine ganze Zahl ab 0'); return null }
      o.minAgeMs = n * 60_000
    } else {
      err(`Unbekannter Schalter «${a}».`)
      return null
    }
  }
  // Ohne Label nie jünger als eine Stunde: ein Deploy könnte gerade bauen
  if (o.minAgeMs !== undefined && o.minAgeMs < 60 * 60_000 && !o.scope) {
    err('--min-age-minutes unter 60 geht nur zusammen mit --only-label (Test).')
    return null
  }
  return o
}

/** Nacht 3, Etappe 5: eine Runde der Einbruchserkennung auf der Kommandozeile */
export interface IntrusionCli {
  scope: { key: string; value: string } | null
  learnMinutes: number | undefined
}

export interface IntrusionCliResult {
  containers: number
  learning: number
  signals: { severity: string; kind: string; project: string | null; title: string; count: number; samples: string[] }[]
  created: number
  updated: number
  errors: string[]
  /** Aktive Vorfälle danach (bei --only-label nur die der betroffenen Projekte) */
  active: { severity: string; kind: string; project: string | null; title: string; count: number; status: string }[]
}

/** Rein: Schalter von «intrusion-check» lesen; null bei Fehlern */
export function parseIntrusionArgs(args: string[], err: (l: string) => void): IntrusionCli | null {
  const o: IntrusionCli = { scope: null, learnMinutes: undefined }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--only-label') {
      const m = /^([a-z0-9][a-z0-9._-]*)=(.+)$/i.exec(args[++i] ?? '')
      if (!m) { err('--only-label braucht <schlüssel>=<wert>'); return null }
      o.scope = { key: m[1]!, value: m[2]! }
    } else if (a === '--learn-minutes') {
      const n = Number(args[++i])
      if (!Number.isInteger(n) || n < 0 || n > 1440) { err('--learn-minutes braucht eine ganze Zahl von 0 bis 1440'); return null }
      o.learnMinutes = n
    } else {
      err(`Unbekannter Schalter «${a}».`)
      return null
    }
  }
  return o
}

const mb = (n: number | null) => (n === null ? '–' : n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`)

/** Vergleichbar machen: klein, ohne Akzente («Joël» = «joel») */
const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase()

/** Namen, unter denen das (einzige) Konto auf der Kommandozeile gemeint ist */
export function accountNames(adminName: string): string[] {
  return [...new Set(['admin', 'joel', ...(adminName.trim() ? [fold(adminName)] : [])])]
}

export async function runCli(argv: string[], io: CliIo, deps: {
  service: () => Promise<AuthService>
  adminName: string
  cleanup?: (o: CleanupCli) => Promise<CleanupCliResult>
  intrusion?: (o: IntrusionCli) => Promise<IntrusionCliResult>
  releaseIsolation?: (project: string) => Promise<{ name: string; released: boolean; restored: number; failed: string[] }>
}): Promise<number> {
  const [cmd, user, ...rest] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    USAGE.forEach((l) => io.out(l))
    return cmd ? 0 : 2
  }
  if (cmd === 'intrusion-check') {
    const o = parseIntrusionArgs(argv.slice(1), io.err)
    if (!o) return 2
    if (!deps.intrusion) { io.err('Die Einbruchserkennung ist hier nicht verfügbar.'); return 1 }
    const r = await deps.intrusion(o)
    if (o.scope) io.out(`Nur Container mit Label ${o.scope.key}=${o.scope.value}`)
    io.out(`Container geprüft: ${r.containers} (davon lernen noch: ${r.learning})`)
    io.out(`Hinweise: ${r.signals.length}`)
    for (const s of r.signals) {
      io.out(`  ${s.severity.padEnd(9)} ${s.kind.padEnd(20)} ${s.project ? `[${s.project}] ` : ''}${s.title} (+${s.count})`)
      for (const x of s.samples.slice(0, 3)) io.out(`             ${x}`)
    }
    io.out(`Vorfälle: ${r.created} neu, ${r.updated} gebündelt (Zähler erhöht)`)
    io.out(`Aktive Vorfälle: ${r.active.length}`)
    for (const a of r.active) io.out(`  ${a.severity.padEnd(9)} ${a.status.padEnd(8)} ${a.kind.padEnd(20)} ${a.project ? `[${a.project}] ` : ''}${a.title} (${a.count}×)`)
    r.errors.forEach((e) => io.err(`Hinweis: ${e}`))
    return 0
  }
  if (cmd === 'release-isolation') {
    if (!user || rest.length) { io.err('Aufruf: node dist/cli.js release-isolation <projekt>'); return 2 }
    if (!deps.releaseIsolation) { io.err('Hier nicht verfügbar.'); return 1 }
    const r = await deps.releaseIsolation(user)
    if (!r.released) { io.out(`«${r.name}» ist nicht isoliert – nichts zu tun.`); return 0 }
    io.out(`Isolation von «${r.name}» aufgehoben:`)
    io.out(`  Restart-Policy zurückgestellt: ${r.restored} Container${r.failed.length ? ` (nicht: ${r.failed.join(', ')})` : ''}`)
    io.out('  Start, Neustart und Deploy gehen wieder. Der Ausgang bleibt «abgeschottet» –')
    io.out('  öffnen unter Projekt › Einstellungen › Ausgehende Verbindungen. Eintrag im Audit-Log: project.isolate.release.')
    return r.failed.length ? 1 : 0
  }
  if (cmd === 'cleanup') {
    const o = parseCleanupArgs(argv.slice(1), io.err)
    if (!o) return 2
    if (!deps.cleanup) { io.err('Aufräumen ist hier nicht verfügbar.'); return 1 }
    const r = await deps.cleanup(o)
    r.problems.forEach((p) => io.err(`Hinweis: ${p}`))
    io.out(o.apply ? 'Aufgeräumt:' : 'Vorschau (es wird nichts gelöscht; mit --apply aufräumen):')
    if (o.scope) io.out(`  nur Objekte mit Label ${o.scope.key}=${o.scope.value}`)
    for (const i of r.plan.items) io.out(`  ${i.kind.padEnd(12)} ${i.name}${i.project ? ` [${i.project}]` : ''} – ${i.reason} (${mb(i.bytes)})`)
    if (r.plan.total > r.plan.items.length) io.out(`  … und ${r.plan.total - r.plan.items.length} weitere`)
    if (r.plan.buildCache) io.out(`  build-cache  ${r.plan.buildCache.count} Einträge älter als 7 Tage (${mb(r.plan.buildCache.bytes)})`)
    io.out(`Posten: ${r.plan.total}`)
    io.out(`${o.apply ? 'Geplant waren' : 'Würde freigeben'}: etwa ${mb(r.plan.bytes)}`)
    if (r.run) {
      io.out(`Freigegeben: etwa ${mb(r.run.freedBytes)} · entfernt ${r.run.removed} · nicht entfernt ${r.run.failed}`)
      ;(r.errors ?? []).forEach((e) => io.err(`  nicht entfernt: ${e}`))
      io.out('Eintrag im Audit-Log: storage.cleanup.')
    }
    io.out(`Verwaiste Volumes (nie automatisch, nur in der Oberfläche löschbar): ${r.orphanVolumes.length}`)
    for (const v of r.orphanVolumes) io.out(`  volume       ${v.name}${v.project ? ` [${v.project}]` : ''}${v.inUse ? ' (eingehängt)' : ''} (${mb(v.bytes)})`)
    return r.run && r.run.failed > 0 ? 1 : 0
  }
  if (cmd !== 'reset-2fa') {
    io.err(`Unbekannter Befehl «${cmd}».`)
    USAGE.forEach((l) => io.err(l))
    return 2
  }
  if (!user || rest.length) {
    io.err('Aufruf: node dist/cli.js reset-2fa <benutzer>')
    return 2
  }
  const names = accountNames(deps.adminName)
  if (!names.includes(fold(user))) {
    io.err(`Unbekannter Benutzer «${user}». Airlock kennt ein Konto: ${names.join(', ')}.`)
    return 2
  }
  const service = await deps.service()
  const r = await service.resetTwoFactor(`cli:${fold(user)}`)
  io.out('Zweiter Faktor zurückgesetzt:')
  io.out(`  Passkeys entfernt:              ${r.passkeys}`)
  io.out(`  Authenticator-App entfernt:     ${r.totp ? 'ja' : 'war nicht eingerichtet'}`)
  io.out(`  Wiederherstellungscodes:        ${r.recoveryCodes} entfernt`)
  io.out(`  Sitzungen abgemeldet:           ${r.sessions}`)
  io.out('Anmelden geht jetzt wieder mit dem Passwort allein. Eintrag im Audit-Log: auth.2fa.reset.')
  io.out('Sperren nach Fehlversuchen (im laufenden Airlock) hebt ein Neustart auf: docker restart airlock-app')
  return 0
}

/** Im Betrieb: Dienst mit PostgreSQL, Migrationen falls nötig (z. B. erster Start ist gescheitert) */
async function productionService(): Promise<AuthService> {
  const { pool } = await import('./db/index.js')
  const exists = await pool.query<{ t: string | null }>("SELECT to_regclass('auth_sessions')::text AS t")
  if (!exists.rows[0]?.t) {
    const { runMigrations } = await import('./db/migrate.js')
    await runMigrations((m) => console.log(m))
  }
  const { auth } = await import('./http/auth.js')
  return auth()
}

/** Nacht 3, Etappe 3: Aufräumen im Container (dieselbe Logik wie Server › Speicher) */
async function productionCleanup(o: CleanupCli): Promise<CleanupCliResult> {
  const { pool } = await import('./db/index.js')
  const exists = await pool.query<{ t: string | null }>("SELECT to_regclass('deployments')::text AS t")
  if (!exists.rows[0]?.t) {
    const { runMigrations } = await import('./db/migrate.js')
    await runMigrations((m) => console.log(m))
  }
  const storage = await import('./storage/service.js')
  const opts = { scope: o.scope, minAgeMs: o.minAgeMs }
  const preview = await storage.previewCleanup(opts)
  if (!o.apply) return preview
  const r = await storage.runStorageCleanup('cli', 'cli', opts)
  return { ...preview, plan: r.plan, run: r.run, errors: r.errors }
}

/** Migrationen, falls die Datenbank noch leer ist (Smoke-Test, erster Start gescheitert) */
async function ensureMigrated(table: string): Promise<void> {
  const { pool } = await import('./db/index.js')
  const exists = await pool.query<{ t: string | null }>('SELECT to_regclass($1)::text AS t', [table])
  if (!exists.rows[0]?.t) {
    const { runMigrations } = await import('./db/migrate.js')
    await runMigrations((m) => console.log(m))
  }
}

/** Nacht 3, Etappe 5: eine Runde wie der Job (mit --only-label ohne Anmeldung und ohne Meldungen) */
async function productionIntrusion(o: IntrusionCli): Promise<IntrusionCliResult> {
  await ensureMigrated('incidents')
  const { runIntrusionRound } = await import('./intrusion/jobs.js')
  const { db, schema } = await import('./db/index.js')
  const { inArray, ne, and } = await import('drizzle-orm')
  const r = await runIntrusionRound({
    only: o.scope, learnMs: o.learnMinutes === undefined ? undefined : o.learnMinutes * 60_000,
    logins: !o.scope, notify: !o.scope,
    // Von Hand: Dateien immer prüfen (der Job tut es nach dem Lernen nur alle 5 Minuten)
    forceFiles: true,
  })
  const projects = await db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects)
  const name = new Map(projects.map((p) => [p.id, p.name]))
  const scopeIds = o.scope ? r.projectIds : null
  const active = ne(schema.incidents.status, 'erledigt')
  const rows = scopeIds && !scopeIds.length ? [] : await db.select().from(schema.incidents)
    .where(scopeIds ? and(active, inArray(schema.incidents.projectId, scopeIds)) : active)
  return {
    containers: r.containers,
    learning: r.learning,
    signals: r.signals.map((s) => ({ severity: s.severity, kind: s.kind, project: s.projectId ? name.get(s.projectId) ?? s.projectId : null, title: s.title, count: s.count, samples: s.samples })),
    created: r.recorded.created,
    updated: r.recorded.updated,
    errors: r.errors,
    active: rows.map((a) => ({ severity: a.severity, kind: a.kind, project: a.projectId ? name.get(a.projectId) ?? null : null, title: a.title, count: a.count, status: a.status })),
  }
}

/** Nacht 3, Etappe 5: Notausgang, falls die Oberfläche nicht geht */
async function productionRelease(project: string): Promise<{ name: string; released: boolean; restored: number; failed: string[] }> {
  await ensureMigrated('incidents')
  const { findProjectForServerJob } = await import('./domain/projects.js')
  const { releaseIsolation } = await import('./intrusion/store.js')
  const p = await findProjectForServerJob(project)
  return { name: p.name, ...(await releaseIsolation(p, 'cli')) }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const io: CliIo = { out: (l) => console.log(l), err: (l) => console.error(l) }
  let code = 2
  try {
    code = await runCli(argv, io, {
      service: productionService,
      cleanup: productionCleanup,
      intrusion: productionIntrusion,
      releaseIsolation: productionRelease,
      // config.ts erst laden, wenn ein Befehl die Datenbank braucht (Hilfe geht ohne Umgebung)
      get adminName() { return process.env.ADMIN_NAME ?? '' },
    })
  } catch (err) {
    console.error(`Fehler: ${(err as Error).message}`)
    code = 1
  } finally {
    if (argv[0] === 'reset-2fa' || argv[0] === 'cleanup' || argv[0] === 'intrusion-check' || argv[0] === 'release-isolation') {
      const { pool } = await import('./db/index.js').catch(() => ({ pool: null }))
      await pool?.end().catch(() => {})
    }
  }
  process.exit(code)
}

// Direkt aufgerufen (auch über den Verweis /app/dist → packages/api/dist): ausführen
const self = fileURLToPath(import.meta.url)
const invoked = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]!) } catch { return process.argv[1]! } })() : ''
if (invoked === self) void main()
