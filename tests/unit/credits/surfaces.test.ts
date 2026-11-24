// @vitest-environment node
// How each surface carries credits (docs/credits.md): the hint wording, MCP
// _meta + the [credits] text block, the request-size cap and the sign-in throttle.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { hintFor, needsHint } from '@/lib/credits/hint'

describe('hint wording', () => {
  const base = { balance: 12, window: 16, charged: 2, refillPerSec: 2 }

  it('steady state: no hint', () => {
    expect(needsHint(base)).toBe(false)
    expect(hintFor(base)).toBeUndefined()
  })

  it('low balance, debt, shrink, hold and refusal each produce one actionable sentence', () => {
    expect(hintFor({ ...base, balance: 3 })).toMatch(/^Credits low \(3 of 16\)\..*wait ~\d+ s/)
    expect(hintFor({ ...base, balance: -4, charged: 7, timeCost: 4, durationMs: 4000 })).toMatch(/cost 7 credits because it ran 4 s; your balance is now -4/)
    expect(hintFor({ ...base, window: 8, shrunk: true, timeCost: 3, durationMs: 3200 })).toMatch(/hold at most 8 credits/)
    expect(hintFor({ ...base, heldMs: 900 })).toMatch(/waited 1 s for credits/)
    expect(hintFor({ ...base, balance: 0, refused: { reason: 'insufficient', retryAfterMs: 2500 } })).toMatch(/^Refused: out of credits.*Retry in 3 s.*invoke/)
    expect(hintFor({ ...base, refused: { reason: 'frozen', retryAfterMs: 0 } })).toMatch(/Don't retry/)
  })
})

describe('MCP surface', () => {
  let client: Client | undefined
  // Pay the cold module transform once, outside any one test's 5 s budget.
  beforeAll(async () => {
    await import('@/lib/operations/index')
    await import('@/lib/adapters/mcp')
  }, 60_000)
  // Keep run time out of the exact-cost assertions on a loaded test runner.
  beforeEach(() => { process.env.CREDITS_AGENT_TIME_UNIT_MS = '60000' })
  afterEach(async () => {
    delete process.env.CREDITS_AGENT_TIME_UNIT_MS
    await client?.close()
    client = undefined
  })

  async function connect(clientId: string) {
    await import('@/lib/operations/index')
    const { registerMcpTools, withMcpAuthRole } = await import('@/lib/adapters/mcp')
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    await withMcpAuthRole(async () => { registerMcpTools(server); return new Response() }, () => 'customer', () => 'tok')(new Request('http://localhost/api/mcp'))
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const send = clientT.send.bind(clientT)
    clientT.send = (msg, opts) => send(msg, { ...opts, authInfo: { token: 'tok', clientId, scopes: [], extra: { userId: 'u_alice', role: 'customer' } } })
    await server.connect(serverT)
    client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(clientT)
    return client
  }

  it('every metered result carries _meta["navwebmcp/credits"]; no text block in steady state', async () => {
    const c = await connect('c_mcp')
    const res = await c.callTool({ name: 'explore', arguments: {} })
    expect(res.isError).toBeFalsy()
    expect((res._meta as Record<string, unknown>)?.['navwebmcp/credits']).toMatchObject({ charged: 2, granted: 2 })
    expect((res.content as { text: string }[]).some((b) => b.text.startsWith('[credits]'))).toBe(false)
  })

  it('a low balance adds a [credits] text block and leaves structuredContent alone', async () => {
    const { updateLedger, freshLedger } = await import('@/lib/credits/ledger')
    const { profile } = await import('@/lib/credits/policy')
    await updateLedger('a:c_low', () => ({ next: { ...freshLedger(profile('agent'), Date.now()), balance: 2 }, value: null }))
    const c = await connect('c_low')
    const res = await c.callTool({ name: 'explore', arguments: {} })
    const blocks = res.content as { text: string }[]
    expect(blocks.at(-1)?.text).toMatch(/^\[credits\] Credits low/)
    expect(JSON.parse(blocks[0].text)).toEqual(res.structuredContent)
  })

  it('a refusal is an error whose message is the hint', async () => {
    const { setCreditPolicy } = await import('@/lib/credits')
    await setCreditPolicy('a:c_frozen', { frozen: true }, 'u_bob')
    const c = await connect('c_frozen')
    const res = await c.callTool({ name: 'explore', arguments: {} })
    expect(res.isError).toBe(true)
    const err = JSON.parse((res.content as { text: string }[])[0].text)
    expect(err).toMatchObject({ code: 'INSUFFICIENT_CREDITS', message: expect.stringMatching(/administrator has paused/) })
    expect((res._meta as Record<string, unknown>)?.['navwebmcp/credits']).toBeTruthy()
  })

  it('the client may send a CreditRequest in _meta', async () => {
    const c = await connect('c_req')
    const res = await c.callTool({ name: 'explore', arguments: {}, _meta: { 'navwebmcp/credits': { request: 100 } } })
    const meta = (res._meta as Record<string, { granted: number; balance: number; window: number }>)['navwebmcp/credits']
    // Asked for more than the call cost: the grant fills the (grown) window.
    expect(meta.granted).toBeGreaterThan(2)
    expect(meta.balance).toBe(meta.window)
  })
})

describe('request-size cap', () => {
  it('rejects a body over the cap with 413 and reads a normal one', async () => {
    const { readJsonCapped } = await import('@/lib/http-limits')
    const big = new Request('http://x', { method: 'POST', body: JSON.stringify({ s: 'x'.repeat(100) }) })
    const tooBig = await readJsonCapped(big, 50)
    expect(tooBig instanceof Response && tooBig.status).toBe(413)
    const okReq = new Request('http://x', { method: 'POST', body: '{"a":1}' })
    expect(await readJsonCapped(okReq, 50)).toEqual({ a: 1 })
    const bad = await readJsonCapped(new Request('http://x', { method: 'POST', body: '{nope' }), 50)
    expect(bad instanceof Response && bad.status).toBe(400)
  })
})

describe('sign-in throttle', () => {
  it('blocks an IP after LOGIN_MAX_ATTEMPTS failures, until the window ends', async () => {
    process.env.LOGIN_MAX_ATTEMPTS = '3'
    try {
      const { loginBlockedFor, noteLoginFailure } = await import('@/lib/login-throttle')
      const now = 1_700_000_000_000
      for (let i = 0; i < 3; i++) {
        expect(await loginBlockedFor('1.2.3.4', now)).toBeNull()
        await noteLoginFailure('1.2.3.4', now)
      }
      expect(await loginBlockedFor('1.2.3.4', now)).toBeGreaterThan(0)
      expect(await loginBlockedFor('5.6.7.8', now)).toBeNull()
      expect(await loginBlockedFor('1.2.3.4', now + 301_000)).toBeNull()
    } finally {
      delete process.env.LOGIN_MAX_ATTEMPTS
    }
  })
})
