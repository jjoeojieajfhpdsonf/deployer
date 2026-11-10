import { z } from 'zod'
import { headerKeys, headerModes, needsConfirmation, HEADER_LABEL, fileInputSchema } from '@airlock/shared'
import { getFixContext, proposeFix, applyFix, listFixRequests } from '../security/fix-service.js'
import { findProject } from '../domain/projects.js'
import { setHeaderRule, removeHeaderRule, listHeaderRules, describeRule } from '../security/header-service.js'
import type { ToolResult } from './server.js'
import type { Scope } from '../lib/scope.js'

/**
 * M8: MCP-Werkzeuge des Fix-Assistenten. Eigene Datei, damit parallele
 * Änderungen an mcp/server.ts nicht kollidieren; Audit und Fehlerbehandlung
 * kommen über `tool` aus server.ts.
 */

type ToolFn = <S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolResult>,
) => void

type ConfirmFn = (
  toolName: string,
  params: Record<string, unknown>,
  summary: string,
) => Promise<{ go: true } | { go: false; result: ToolResult }>

export interface FixToolsContext {
  tool: ToolFn
  confirm: ConfirmFn
  actor: string
  /** M9: Umgebung des Tokens */
  scope: Scope
  ok: (data: unknown) => ToolResult
  fail: (msg: string) => ToolResult
}

const project = z.string().min(1).max(64).describe('Slug oder ID des Projekts')

export function registerFixTools({ tool, confirm, actor, scope, ok, fail }: FixToolsContext): void {
  tool(
    'set_security_header',
    'Fehlenden Security-Header über Caddy ergänzen (ohne Redeploy; setzt die App den Header selbst, gewinnt ihr Wert). ' +
      'header: x-content-type-options, referrer-policy, frame-ancestors, content-security-policy, strict-transport-security. ' +
      'CSP zuerst mit mode "report-only" (Browser melden Verstösse an Airlock), dann "enforce". ' +
      'enforce für CSP und HSTS verlangt eine Bestätigung; HSTS nur bei HTTPS mit stabilem Zertifikat. ' +
      'remove: true entfernt die Regel. Danach läuft automatisch ein Nachscan der Header.',
    {
      project,
      header: z.enum(headerKeys),
      value: z.string().max(4000).optional().describe('Ohne Angabe: bisheriger Wert bzw. sicherer Standard (z.B. nosniff, max-age=300)'),
      mode: z.enum(headerModes).default('enforce'),
      remove: z.boolean().default(false),
      confirmation_token: z.string().optional(),
    },
    async (a) => {
      const p = await findProject(scope, a.project)
      if (a.remove) {
        const r = await removeHeaderRule(scope, p.id, a.header, actor)
        return ok({ removed: a.header, recheck: r.recheck })
      }
      const mode = a.header === 'content-security-policy' ? a.mode : 'enforce'
      if (a.header !== 'content-security-policy' && a.mode === 'report-only') {
        return fail(`${HEADER_LABEL[a.header]} kennt keinen Report-Only-Modus; ohne mode aufrufen.`)
      }
      let confirmed = false
      if (needsConfirmation(a.header, mode)) {
        const c = await confirm(
          'set_security_header',
          { project: p.id, header: a.header, value: a.value ?? null, mode, confirmation_token: a.confirmation_token },
          a.header === 'strict-transport-security'
            ? `HSTS für "${p.name}" setzen (${a.value ?? 'max-age=300'})? Browser erzwingen danach HTTPS für diesen Namen.`
            : `Content-Security-Policy für "${p.name}" scharf schalten? Sie kann Teile der Seite blockieren.`,
        )
        if (!c.go) return c.result
        confirmed = true
      }
      const r = await setHeaderRule(scope, p.id, a.header, { value: a.value, mode, confirm: confirmed }, actor)
      const all = await listHeaderRules(scope, p.id)
      return ok({
        rule: describeRule(r.rule),
        recheck: r.recheck,
        rules: all.rules.map(describeRule),
        ...(a.header === 'content-security-policy' && mode === 'report-only'
          ? { next: 'Seite im Browser benutzen; Verstösse erscheinen im Security-Reiter. Danach set_security_header mit mode "enforce" und dem vorgeschlagenen Wert.' }
          : {}),
        ...(a.header === 'content-security-policy' && all.csp.suggestion ? { csp_suggestion: all.csp.suggestion, csp_notes: all.csp.notes } : {}),
      })
    },
  )

  /* --- Etappe 2: Mit Claude lösen --------------------------------------------- */

  tool(
    'get_fix_context',
    'Alles, um einen Befund zu beheben: Befund, Erklärung, empfohlener Weg (header, files, github, repo, image, none) und die betroffenen Dateien. ' +
      'Werte aus der Projekt-Env und Zeilen mit Secrets sind ersetzt, Env-Dateien fehlen. Danach je nach Weg set_security_header oder propose_fix.',
    { project, finding: z.string().uuid() },
    async (a) => ok(await getFixContext(scope, a.project, a.finding)),
  )

  tool(
    'propose_fix',
    'Änderung zu einem Befund vorschlagen. files: geänderte Dateien vollständig [{path, content}], delete: Pfade. ' +
      'Chat-Projekte: Airlock zeigt den Vorschlag als Diff; übernommen wird er erst nach Zustimmung (Oberfläche oder apply_fix). ' +
      'Mit GitHub App: Airlock öffnet einen Pull Request auf einem eigenen Branch.',
    {
      project,
      finding: z.string().uuid(),
      files: z.array(fileInputSchema).max(50).optional(),
      delete: z.array(z.string()).max(50).optional(),
      explanation: z.string().min(10).max(4000).describe('Was die Änderung behebt und was sie sonst beeinflusst'),
    },
    async (a) => {
      const fix = await proposeFix(scope, a.project, a.finding, { files: a.files, delete: a.delete, explanation: a.explanation }, actor)
      return ok({
        fix: fix.id, status: fix.status, ...(fix.prUrl ? { pull_request: fix.prUrl, branch: fix.branch } : { diff: fix.diff }),
        next: fix.way === 'github'
          ? 'Pull Request prüfen und mergen; Airlock deployt danach automatisch und scannt nach.'
          : 'Joël prüft den Diff im Security-Reiter und übernimmt ihn dort – oder apply_fix (verlangt Bestätigung).',
      })
    },
  )

  tool(
    'apply_fix',
    'Einen Vorschlag übernehmen: neue Version im lokalen Repo, Deploy, Nachscan (verlangt Bestätigung).',
    { project, fix: z.string().uuid(), confirmation_token: z.string().optional() },
    async (a) => {
      const p = await findProject(scope, a.project)
      const fixes = await listFixRequests(scope, p.id, 100)
      const f = fixes.find((x) => x.id === a.fix)
      if (!f) return fail(`Vorschlag ${a.fix} gehört nicht zu "${p.name}"`)
      const c = await confirm('apply_fix', { project: p.id, fix: a.fix, confirmation_token: a.confirmation_token }, `Vorschlag für «${f.findingTitle}» in "${p.name}" übernehmen, neu deployen und nachscannen?`)
      if (!c.go) return c.result
      const r = await applyFix(scope, a.fix, actor, { projectId: p.id })
      return ok({ fix: r.id, status: r.status, commit: r.commit, note: r.note, next: 'get_scan_report in einigen Minuten zeigt, ob der Befund weg ist.' })
    },
  )
}
