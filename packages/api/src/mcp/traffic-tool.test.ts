import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

// server.ts zieht config.ts nach; für den Import genügt eine Dummy-Umgebung (ohne Datenbank).
process.env.DATABASE_URL ??= 'postgres://x@127.0.0.1:1/x'
process.env.ADMIN_PASSWORD ??= 'x'
const { createMcpServer } = await import('./server.js')

/**
 * Etappe 3: MCP-Werkzeug get_traffic(project, range) ist registriert, nur
 * lesend beschrieben und prüft den Zeitraum. Die Zahlen selbst prüft
 * traffic/summary.test.ts (mcpTraffic).
 */
describe('MCP get_traffic', () => {
  test('registriert, mit project, range (heute bis 12 Monate; Standard 7d) und access (Standard alle)', async () => {
    const server = createMcpServer({ id: 't1', name: 'test', environmentId: '00000000-0000-0000-0000-000000000000' } as never)
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '1.0.0' })
    await Promise.all([server.connect(a), client.connect(b)])
    const { tools } = await client.listTools()
    const t = tools.find((x) => x.name === 'get_traffic')
    assert.ok(t, 'get_traffic fehlt')
    assert.match(t!.description ?? '', /nur lesen/)
    const schema = t!.inputSchema as { properties: Record<string, { enum?: string[]; default?: string }>; required?: string[] }
    assert.deepEqual(Object.keys(schema.properties).sort(), ['access', 'project', 'range'])
    assert.deepEqual(schema.properties.range!.enum, ['today', '24h', '7d', '30d', '12m'])
    assert.equal(schema.properties.range!.default, '7d')
    assert.deepEqual(schema.properties.access!.enum, ['all', 'public', 'tailnet', 'lan'])
    assert.equal(schema.properties.access!.default, 'all')
    assert.deepEqual(schema.required, ['project'])
    // Ungültiger Zeitraum: abgelehnt, bevor irgendetwas gelesen wird
    const r = await client.callTool({ name: 'get_traffic', arguments: { project: 'foto', range: '1y' } }).catch((err: Error) => ({ isError: true, content: [{ type: 'text', text: err.message }] }))
    assert.equal(r.isError, true)
    await client.close()
    await server.close()
  })
})
