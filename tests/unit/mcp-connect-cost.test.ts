// @vitest-environment node
// The connect cost: what tools/list shows an agent before it has asked for
// anything. NavWebMcp 2.5.0 cut it from ~6,600 to ~2,000 tokens by not
// publishing output schemas for the always-on tools and by keeping their
// descriptions short. This pins it, so it can't creep back up unnoticed.
import { describe, it, expect, afterEach } from 'vitest'
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server'
import { Client } from '@modelcontextprotocol/client'

/** The repo's token model everywhere (bench, docs): characters ÷ 4. */
const tokens = (v: unknown) => Math.ceil(JSON.stringify(v).length / 4)

/** Budget for the 12 always-on tools in tools/list. Raise it deliberately, in a reviewed change. */
const CONNECT_BUDGET = 2_200

let client: Client

async function connect(loaded: string[] = []) {
  await import('@/lib/operations/index')
  const { registerMcpTools, withMcpAuthRole } = await import('@/lib/adapters/mcp')
  const { addLoaded } = await import('@/lib/loadedTools')
  if (loaded.length) addLoaded('tok_cost', loaded)
  const server = new McpServer({ name: 't', version: '0' })
  await withMcpAuthRole(async () => { registerMcpTools(server); return new Response() }, () => 'admin', () => 'tok_cost')(new Request('http://x/api/mcp'))
  const [a, b] = InMemoryTransport.createLinkedPair()
  const send = a.send.bind(a)
  a.send = (msg, opts) => send(msg, { ...opts, authInfo: { token: 'tok_cost', clientId: 'u_bob', scopes: [], extra: { userId: 'u_bob', role: 'admin' } } })
  await server.connect(b)
  client = new Client({ name: 'c', version: '0' })
  await client.connect(a)
}

afterEach(async () => { await client?.close() })

describe('connect cost', () => {
  it(`the 12 always-on tools fit in ${CONNECT_BUDGET} tokens`, async () => {
    await connect()
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(12)
    const cost = tokens(tools)
    console.log(`[connect cost] tools/list = ${cost} tokens for ${tools.length} tools`)
    expect(cost).toBeLessThanOrEqual(CONNECT_BUDGET)
  })

  it('always-on tools publish no outputSchema; loaded business operations still do', async () => {
    await connect(['getGuest'])
    const { tools } = await client.listTools()
    for (const t of tools) {
      if (t.name === 'getGuest') expect(t.outputSchema?.type).toBe('object')
      else expect(t.outputSchema, t.name).toBeUndefined()
    }
  })

  it('their results still carry structuredContent, and describe_tool still returns their output schema', async () => {
    await connect()
    const ctx = await client.callTool({ name: 'getContext', arguments: {} })
    expect(ctx.structuredContent).toMatchObject({ role: 'admin', timezone: 'UTC' })
    const d = await client.callTool({ name: 'describe_tool', arguments: { name: 'explore' } })
    expect((d.structuredContent as { outputSchema: { type: string } }).outputSchema.type).toBe('object')
  })
})
