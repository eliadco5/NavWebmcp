// @vitest-environment node
// MCP text-block format (NavWebMcp 2.3.0): "pretty" stays the default; "compact"
// is chosen per connection (X-NavWebMcp-Format header or ?format= on the URL) or
// per call (_meta["navwebmcp/format"]). Only whitespace differs.
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server'
import { Client } from '@modelcontextprotocol/client'

const TOKEN = 'tok_fmt'

// The adapter's first import loads the whole registry and the MCP SDK; on a busy
// machine that alone can pass the default 5 s test timeout. Pay it once, here.
beforeAll(async () => { await import('@/lib/adapters/mcp') }, 60_000)
let client: Client

async function connect(req: Request) {
  await import('@/lib/operations/index')
  const { registerMcpTools, withMcpAuthRole } = await import('@/lib/adapters/mcp')
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  await withMcpAuthRole(async () => { registerMcpTools(server); return new Response() }, () => 'customer', () => TOKEN)(req)
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const send = clientT.send.bind(clientT)
  clientT.send = (msg, opts) =>
    send(msg, { ...opts, authInfo: { token: TOKEN, clientId: 'u_alice', scopes: [], extra: { userId: 'u_alice', role: 'customer' } } })
  await server.connect(serverT)
  client = new Client({ name: 'fmt-client', version: '0.0.0' })
  await client.connect(clientT)
}

afterEach(async () => { await client?.close() })

const text = (r: any) => r.content[0].text as string
const call = (args: Record<string, unknown> = {}, _meta?: Record<string, unknown>) =>
  client.callTool({ name: 'invoke', arguments: { name: 'searchAvailability', args: { date: '2026-07-07', partySize: 2, ...args } }, ...(_meta && { _meta }) })

describe('formatFromRequest', () => {
  it('header beats URL beats default; unknown values are ignored', async () => {
    const { formatFromRequest } = await import('@/lib/adapters/mcp')
    expect(formatFromRequest(new Request('http://x/api/mcp'))).toBe('pretty')
    expect(formatFromRequest(new Request('http://x/api/mcp?format=compact'))).toBe('compact')
    expect(formatFromRequest(new Request('http://x/api/mcp?format=COMPACT'))).toBe('compact')
    expect(formatFromRequest(new Request('http://x/api/mcp?format=yaml'))).toBe('pretty')
    expect(formatFromRequest(new Request('http://x/api/mcp?format=compact', { headers: { 'x-navwebmcp-format': 'pretty' } }))).toBe('pretty')
    expect(formatFromRequest(new Request('http://x/api/mcp', { headers: { 'x-navwebmcp-format': 'compact' } }))).toBe('compact')
    expect(formatFromRequest(new Request('http://x/api/mcp', { headers: { 'x-navwebmcp-format': 'nope' } }))).toBe('pretty')
  })
})

describe('text blocks', () => {
  it('default connection: pretty, exactly as before', async () => {
    await connect(new Request('http://localhost/api/mcp'))
    const r = await call()
    expect(text(r)).toBe(JSON.stringify(r.structuredContent, null, 2))
  })

  it('compact connection: same data, no whitespace, fewer characters; structuredContent unchanged', async () => {
    await connect(new Request('http://localhost/api/mcp?format=compact'))
    const r = await call()
    expect(text(r)).toBe(JSON.stringify(r.structuredContent))
    expect(JSON.parse(text(r))).toEqual(r.structuredContent)
    expect(text(r).length).toBeLessThan(JSON.stringify(r.structuredContent, null, 2).length)
  })

  it('errors follow the format too', async () => {
    await connect(new Request('http://localhost/api/mcp', { headers: { 'x-navwebmcp-format': 'compact' } }))
    const r = await call({ date: 'bad' })
    expect(r.isError).toBe(true)
    expect(text(r)).not.toMatch(/\n/)
    expect(JSON.parse(text(r)).code).toBe('INVALID_INPUT')
  })

  it('per call, _meta["navwebmcp/format"] overrides the connection, both ways', async () => {
    await connect(new Request('http://localhost/api/mcp'))
    const compact = await call({}, { 'navwebmcp/format': 'compact' })
    expect(text(compact)).not.toMatch(/\n/)
    await client.close()
    await connect(new Request('http://localhost/api/mcp?format=compact'))
    const pretty = await call({}, { 'navwebmcp/format': 'pretty' })
    expect(text(pretty)).toMatch(/\n {2}"/)
  })

  it('the plain-text notes ([idempotency]) are unchanged in compact mode', async () => {
    await connect(new Request('http://localhost/api/mcp?format=compact'))
    const slots = (await call()).structuredContent as { slots: { id: string }[] }
    const args = { slotId: slots.slots[0].id, name: 'Fmt Idem', partySize: 2, idempotencyKey: 'fmt-k' }
    await client.callTool({ name: 'invoke', arguments: { name: 'createReservation', args } })
    const replay = await client.callTool({ name: 'invoke', arguments: { name: 'createReservation', args } }) as any
    expect(text(replay)).not.toMatch(/\n/)
    expect(replay.content[1].text).toMatch(/^\[idempotency\] Replayed/)
  })
})
