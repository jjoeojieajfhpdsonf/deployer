import { z } from 'zod'
import { headerKeys, headerModes, needsConfirmation, HEADER_LABEL } from '@deployer/shared'
import { findProject } from '../domain/projects.js'
import { setHeaderRule, removeHeaderRule, listHeaderRules, describeRule } from '../security/header-service.js'
import type { ToolResult } from './server.js'

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
  ok: (data: unknown) => ToolResult
  fail: (msg: string) => ToolResult
}

const project = z.string().min(1).max(64).describe('Slug oder ID des Projekts')

export function registerFixTools({ tool, confirm, actor, ok, fail }: FixToolsContext): void {
  tool(
    'set_security_header',
    'Fehlenden Security-Header über Caddy ergänzen (ohne Redeploy; setzt die App den Header selbst, gewinnt ihr Wert). ' +
      'header: x-content-type-options, referrer-policy, frame-ancestors, content-security-policy, strict-transport-security. ' +
      'CSP zuerst mit mode "report-only" (Browser melden Verstösse an deployer), dann "enforce". ' +
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
      const p = await findProject(a.project)
      if (a.remove) {
        const r = await removeHeaderRule(p.id, a.header, actor)
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
      const r = await setHeaderRule(p.id, a.header, { value: a.value, mode, confirm: confirmed }, actor)
      const all = await listHeaderRules(p.id)
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
}
