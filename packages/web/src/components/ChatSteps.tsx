import { Link } from 'react-router-dom'

/**
 * Anleitung «Per Chat»: Projekte über den MCP-Server von Airlock anlegen.
 * Gemeinsam für den Dialog der Projektliste und die fünfte Quelle unter
 * «Neues Projekt» (UI-Qualität 5).
 */
export function ChatSteps() {
  const mcpUrl = `${window.location.origin}/mcp`
  return (
    <ol className="dialog-steps">
      <li>Auf der Seite <Link to="/tokens">Tokens</Link> ein Token für den Client anlegen, z.B. «Claude Desktop».</li>
      <li>In Claude den MCP-Server <code>{mcpUrl}</code> mit diesem Token eintragen. Für Claude Code steht dort der fertige Befehl.</li>
      <li>Im Chat sagen, was auf den Server soll, z.B. «Stell diese Seite als hallo-welt online». Das Projekt erscheint danach in der Projektliste.</li>
    </ol>
  )
}
