import { Link } from 'react-router-dom'
import { useEnvPath } from '../lib/env.js'

/**
 * Anleitung «Per Chat»: Projekte über den MCP-Server von Airlock anlegen.
 * Gemeinsam für den Dialog der Projektliste und die fünfte Quelle unter
 * «Neues Projekt» (UI-Qualität 5).
 */
export function ChatSteps() {
  const mcpUrl = `${window.location.origin}/mcp`
  const ep = useEnvPath()
  return (
    <ol className="dialog-steps">
      <li>Unter <Link to={ep('/einstellungen/tokens')}>Einstellungen › Tokens</Link> ein Token für den Client anlegen, z.B. «Claude Desktop». Es gilt nur für diese Umgebung.</li>
      <li>In Claude den MCP-Server <code>{mcpUrl}</code> mit diesem Token eintragen. Für Claude Code steht dort der fertige Befehl.</li>
      <li>Im Chat sagen, was auf den Server soll, z.B. «Stell diese Seite als hallo-welt online». Das Projekt erscheint danach in der Projektliste.</li>
    </ol>
  )
}
