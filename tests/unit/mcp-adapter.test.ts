// @vitest-environment node
// lib/adapters/mcp.ts end-to-end through the real MCP SDK (in-memory transport):
// what tools/list publishes and what tools/call returns.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Role } from '@/lib/auth'

const TOKEN = 'tok_test'
let client: Client
let server: McpServer

async function connect(role: Role, userId: string, loaded: string[] = []) {
  await import('@/lib/operations/index')
  const { registerMcpTools, withMcpAuthRole } = await import('@/lib/adapters/mcp')
  const { addLoaded } = await import('@/lib/loadedTools')
  if (loaded.length) addLoaded(TOKEN, loaded)

  server = new McpServer({ name: 'test', version: '0.0.0' })
  // registerMcpTools reads the caller's role/token from the request context.
  await withMcpAuthRole(async () => { registerMcpTools(server); return new Response() }, () => role, () => TOKEN)(
    new Request('http://localhost/api/mcp')
  )

  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  // In production, withMcpAuth attaches this AuthInfo; inject the same shape here.
  const send = clientT.send.bind(clientT)
  clientT.send = (msg, opts) =>
    send(msg, { ...opts, authInfo: { token: TOKEN, clientId: userId, scopes: [], extra: { userId, role } } })

  await server.connect(serverT)
  client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(clientT)
}

afterEach(async () => {
  await client?.close()
})

describe('tools/list', () => {
  beforeEach(async () => { await connect('admin', 'u_bob', ['getGuest', 'cancelReservation']) })

  it('publishes an object outputSchema for every tool', async () => {
    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThan(0)
    for (const t of tools) {
      expect(t.outputSchema?.type, t.name).toBe('object')
    }
  })

  it('publishes annotations derived from the operation', async () => {
    const { tools } = await client.listTools()
    const getGuest = tools.find((t) => t.name === 'getGuest')!
    const cancel = tools.find((t) => t.name === 'cancelReservation')!
    expect(getGuest.annotations).toMatchObject({ title: 'Get Guest', readOnlyHint: true, destructiveHint: false })
    expect(cancel.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
  })

  it('invoke is never advertised as read-only: it can dispatch destructive ops', async () => {
    const { tools } = await client.listTools()
    expect(tools.find((t) => t.name === 'invoke')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
  })

  it('input schemas reject unknown keys and contain no $ref', async () => {
    const { tools } = await client.listTools()
    // A JSON-Schema $ref key, not the word in a description (invoke documents
    // NavWebMcp's own batch $ref in its descriptions since 2.2.0).
    const schemaRef = /"\$ref":/
    for (const t of tools) {
      expect(t.inputSchema.additionalProperties, t.name).toBe(false)
      expect(JSON.stringify(t.inputSchema), t.name).not.toMatch(schemaRef)
      expect(JSON.stringify(t.outputSchema), t.name).not.toMatch(schemaRef)
    }
  })
})

describe('tools/call', () => {
  beforeEach(async () => { await connect('admin', 'u_bob', ['getGuest']) })

  it('returns structuredContent plus the same data as a JSON text block', async () => {
    const res = await client.callTool({ name: 'getGuest', arguments: { guestId: 'g_001' } })
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toMatchObject({ guest: { guestId: 'g_001' } })
    const text = (res.content as { type: string; text: string }[])[0].text
    expect(JSON.parse(text)).toEqual(res.structuredContent)
  })

  it('handler failures are isError with a ProtocolError text block and no structuredContent', async () => {
    const res = await client.callTool({ name: 'getGuest', arguments: { guestId: 'nope' } })
    expect(res.isError).toBe(true)
    expect(res.structuredContent).toBeUndefined()
    const err = JSON.parse((res.content as { text: string }[])[0].text)
    expect(err).toEqual({
      code: 'NOT_FOUND', message: expect.any(String), retryable: false,
      hint: expect.any(String), requestId: expect.any(String), callId: expect.any(String),
    })
  })

  it('rejects unknown input keys instead of silently dropping them', async () => {
    const res = await client.callTool({ name: 'getGuest', arguments: { guestId: 'g_001', guestID: 'typo' } })
    expect(res.isError).toBe(true)
    expect((res.content as { text: string }[])[0].text).toMatch(/unrecognized/i)
  })

  it("invoke returns the op's data flat, and a failed op is isError with that op's error", async () => {
    const okRes = await client.callTool({ name: 'invoke', arguments: { name: 'getGuest', args: { guestId: 'g_001' } } })
    expect(okRes.isError).toBeFalsy()
    expect(okRes.structuredContent).toMatchObject({ guest: { guestId: 'g_001' } })
    expect(okRes.structuredContent).not.toHaveProperty('success')

    const badRes = await client.callTool({ name: 'invoke', arguments: { name: 'getGuest', args: { guestId: 'nope' } } })
    expect(badRes.isError).toBe(true)
    expect(JSON.parse((badRes.content as { text: string }[])[0].text)).toMatchObject({ code: 'NOT_FOUND', retryable: false })
  })

  it('invoke relaying an op whose own data has `results` passes the SDK output validation', async () => {
    const res = await client.callTool({ name: 'invoke', arguments: { name: 'load_tools', args: { names: ['getOccupancy'] } } })
    expect(res.isError).toBeFalsy()
    expect((res.structuredContent as { results: { status: string }[] }).results[0].status).toBe('LOADED')
  })

  it('always-on meta ops return structuredContent too', async () => {
    const res = await client.callTool({ name: 'describe_tool', arguments: { name: 'getGuest' } })
    expect(res.isError).toBeFalsy()
    const sc = res.structuredContent as { inputSchema: object; outputSchema: { type: string } }
    expect(sc.inputSchema).toBeDefined()
    expect(sc.outputSchema.type).toBe('object')
  })
})

describe('role gate', () => {
  it('a customer does not see support-only tools even when loaded', async () => {
    await connect('customer', 'u_alice', ['getGuest'])
    const { tools } = await client.listTools()
    expect(tools.find((t) => t.name === 'getGuest')).toBeUndefined()
  })
})
