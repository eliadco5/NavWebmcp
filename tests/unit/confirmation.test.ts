// @vitest-environment node
// Confirmation previews, tokens and dry-run (NavWebMcp 2.6.0): a destructive
// call without approval answers CONFIRMATION_REQUIRED with a preview and a token
// bound to (caller, operation, arguments, expiry), valid once. confirm: true
// keeps working unless REQUIRE_CONFIRMATION_TOKEN=true. dryRun previews any
// write at read cost and never writes. MCP clients that can elicit are asked
// directly, and that approval is audited as "user-elicitation".
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server'
import { Client } from '@modelcontextprotocol/client'
import { adminCtx, customerCtx } from '@/tests/helpers'
import type { Actor, OperationContext } from '@/lib/operations/types'

beforeAll(async () => {
  await import('@/lib/operations/index')
  await import('@/lib/adapters/mcp')
}, 60_000)

const agent = (ctx: OperationContext, clientId = 'c_agent'): OperationContext => ({
  ...ctx,
  actor: { type: 'agent', userId: ctx.userId, role: ctx.role, assurance: 'verified', agent: { clientId } } satisfies Actor,
})
const human = (ctx: OperationContext): OperationContext => ({
  ...ctx,
  actor: { type: 'human', userId: ctx.userId, role: ctx.role, assurance: 'asserted' } satisfies Actor,
})

async function setup() {
  // setup.ts resets modules before each test: load the registry again.
  await import('@/lib/operations/index')
  const { execute } = await import('@/lib/operations/execute')
  const { store } = await import('@/lib/store')
  const { tasksStore } = await import('@/lib/seed/tasks')
  return { execute, store, tasks: tasksStore() }
}

/** Book a reservation the customer owns, and return its id. */
async function myReservation(name = 'Conf Guest'): Promise<string> {
  const { execute, store } = await setup()
  const slot = store.searchAvailability('2026-07-07', 2)[0]
  const r = await execute('createReservation', { slotId: slot.id, name, partySize: 2 }, customerCtx) as any
  expect(r.success, JSON.stringify(r)).toBe(true)
  return r.data.reservation.id
}

/** Every audited call, captured for the test. */
let audited: { operation: string; meta: { approvedBy?: string; dryRun?: boolean }; errorCode?: string }[] = []
async function captureAudit() {
  const { installAuditRecorder } = await import('@/lib/audit/port')
  installAuditRecorder(async (c: any) => { audited.push(c); return null })
}
beforeEach(async () => {
  audited = []
  await captureAudit()
})
afterEach(() => {
  delete process.env.REQUIRE_CONFIRMATION_TOKEN
  delete process.env.CONFIRMATION_TTL_SECONDS
  vi.useRealTimers()
})

describe('CONFIRMATION_REQUIRED carries a preview and a token', () => {
  it('a call without confirm runs nothing and says what it would do', async () => {
    const { execute, store } = await setup()
    const id = await myReservation('Preview Me')
    const r = await execute('cancelReservation', { reservationId: id }, agent(customerCtx)) as any
    expect(r.success).toBe(false)
    expect(r.error.code).toBe('CONFIRMATION_REQUIRED')
    expect(r.error.confirmation.preview.summary).toMatch(/Cancel reservation .* for Preview Me, party of 2 on 2026-07-07/)
    expect(r.error.confirmation.preview.data.reservation.id).toBe(id)
    expect(r.error.confirmation.token).toMatch(/^c1\./)
    expect(Date.parse(r.error.confirmation.expiresAt)).toBeGreaterThan(Date.now())
    expect(store.getReservationById(id)).toBeDefined()
  })

  it('the token approves the call: it runs, and the audit says how it was approved', async () => {
    const { execute, store } = await setup()
    const id = await myReservation()
    const ask = await execute('cancelReservation', { reservationId: id }, agent(customerCtx)) as any
    const done = await execute('cancelReservation', { reservationId: id, confirmationToken: ask.error.confirmation.token }, agent(customerCtx)) as any
    expect(done).toMatchObject({ success: true, data: { cancelled: true, reservationId: id } })
    expect(store.getReservationById(id)).toBeUndefined()
    expect(audited.at(-1)?.meta.approvedBy).toBe('confirmation-token')
  })

  it('a preview that fails is the answer: nobody is asked to approve the impossible', async () => {
    const { execute } = await setup()
    const r = await execute('cancelReservation', { reservationId: 'r_nope' }, agent(customerCtx)) as any
    expect(r.error.code).toBe('NOT_FOUND')
    expect(r.error.confirmation).toBeUndefined()
  })

  it('every requiresConfirmation op publishes confirmationToken, and confirm is optional', async () => {
    const { registry } = await import('@/lib/operations')
    const { inputObject } = await import('@/lib/schema')
    const ops = registry.filter((o) => o.requiresConfirmation)
    expect(ops.length).toBe(9)
    for (const op of ops) {
      expect(op.inputSchema, op.name).toHaveProperty('confirmationToken')
      expect(op.inputSchema, op.name).toHaveProperty('dryRun')
      const shape = inputObject(op.inputSchema).shape as Record<string, { isOptional(): boolean }>
      expect(shape.confirm.isOptional(), op.name).toBe(true)
    }
  })
})

describe('token binding', () => {
  async function tokenFor(id: string, ctx = agent(customerCtx)) {
    const { execute } = await setup()
    const ask = await execute('cancelReservation', { reservationId: id }, ctx) as any
    return ask.error.confirmation.token as string
  }

  it('other arguments: CONFIRMATION_STALE, with a fresh preview and token for the new ones', async () => {
    const { execute, store } = await setup()
    const a = await myReservation('Stale A')
    const b = await myReservation('Stale B')
    const token = await tokenFor(a)
    const r = await execute('cancelReservation', { reservationId: b, confirmationToken: token }, agent(customerCtx)) as any
    expect(r.error.code).toBe('CONFIRMATION_STALE')
    expect(r.error.message).toMatch(/arguments changed/)
    expect(r.error.confirmation.preview.summary).toMatch(/Stale B/)
    expect(r.error.confirmation.token).not.toBe(token)
    expect(store.getReservationById(b)).toBeDefined()
  })

  it('another user, or another agent client of the same user: not valid', async () => {
    const { execute } = await setup()
    const id = await myReservation()
    const token = await tokenFor(id)
    const otherClient = await execute('cancelReservation', { reservationId: id, confirmationToken: token }, agent(customerCtx, 'c_other')) as any
    expect(otherClient.error.code).toBe('CONFIRMATION_STALE')
    expect(otherClient.error.message).toMatch(/not valid/)
    const adminAsk = await execute('cancelAnyReservation', { reservationId: id }, agent(adminCtx)) as any
    const wrongOp = await execute('cancelReservation', { reservationId: id, confirmationToken: adminAsk.error.confirmation.token }, agent(customerCtx)) as any
    expect(wrongOp.error.code).toBe('CONFIRMATION_STALE')
  })

  it('used once only', async () => {
    const { execute } = await setup()
    const id = await myReservation()
    const token = await tokenFor(id)
    // Two callers racing with one token: exactly one runs.
    const [a, b] = await Promise.all([
      execute('cancelReservation', { reservationId: id, confirmationToken: token }, agent(customerCtx)),
      execute('cancelReservation', { reservationId: id, confirmationToken: token }, agent(customerCtx)),
    ]) as any[]
    // The loser finds the token used; its fresh preview then finds the
    // reservation gone, which is the answer it gets.
    const codes = [a, b].map((r) => (r.success ? 'OK' : r.error.code)).sort()
    expect(codes).toEqual(['NOT_FOUND', 'OK'])
  })

  it('used once only, at the port: the second redeem is "used"', async () => {
    const port = await import('@/lib/confirmation/port')
    const binding = { userId: 'u', clientId: 'c', operation: 'deleteTask', argsHash: 'h' }
    const { token } = await port.mintConfirmationToken(binding)
    expect(await port.redeemConfirmationToken(token, binding)).toBe('ok')
    expect(await port.redeemConfirmationToken(token, binding)).toBe('used')
    expect(await port.checkConfirmationToken(token, { ...binding, argsHash: 'other' })).toBe('mismatch')
  })

  it('expired', async () => {
    const { execute } = await setup()
    const id = await myReservation()
    process.env.CONFIRMATION_TTL_SECONDS = '1'
    const token = await tokenFor(id)
    vi.useFakeTimers({ now: Date.now() + 2_000, toFake: ['Date'] })
    const r = await execute('cancelReservation', { reservationId: id, confirmationToken: token }, agent(customerCtx)) as any
    expect(r.error.code).toBe('CONFIRMATION_STALE')
    expect(r.error.message).toMatch(/expired/)
  })

  it('forged or tampered', async () => {
    const { execute } = await setup()
    const id = await myReservation()
    const token = await tokenFor(id)
    const [v, body, mac] = token.split('.')
    const flipped = `${v}.${body}.${mac.slice(0, -2)}${mac.endsWith('AA') ? 'BB' : 'AA'}`
    for (const t of [flipped, 'c1.e30.x', 'garbage']) {
      const r = await execute('cancelReservation', { reservationId: id, confirmationToken: t }, agent(customerCtx)) as any
      expect(r.error.code, t).toBe('CONFIRMATION_STALE')
    }
  })
})

describe('confirm: true and REQUIRE_CONFIRMATION_TOKEN', () => {
  it('by default confirm: true still runs (audited as asserted); a person in the UI as human', async () => {
    const { execute } = await setup()
    const a = await myReservation()
    expect((await execute('cancelReservation', { reservationId: a, confirm: true }, agent(customerCtx)) as any).success).toBe(true)
    expect(audited.at(-1)?.meta.approvedBy).toBe('asserted')
    const b = await myReservation()
    expect((await execute('cancelReservation', { reservationId: b, confirm: true }, human(customerCtx)) as any).success).toBe(true)
    expect(audited.at(-1)?.meta.approvedBy).toBe('human')
  })

  it('enforced: an agent\'s bare confirm: true is refused with the preview and a token; people are not affected', async () => {
    process.env.REQUIRE_CONFIRMATION_TOKEN = 'true'
    const { execute, store } = await setup()
    const id = await myReservation()
    const refused = await execute('cancelReservation', { reservationId: id, confirm: true }, agent(customerCtx)) as any
    expect(refused.error.code).toBe('CONFIRMATION_REQUIRED')
    expect(refused.error.message).toMatch(/requires a confirmationToken/)
    expect(store.getReservationById(id)).toBeDefined()
    const ok = await execute('cancelReservation', { reservationId: id, confirmationToken: refused.error.confirmation.token }, agent(customerCtx)) as any
    expect(ok.success).toBe(true)
    const other = await myReservation()
    expect((await execute('cancelReservation', { reservationId: other, confirm: true }, human(customerCtx)) as any).success).toBe(true)
  })

  it('a keyed retry of a call that already ran replays without asking again', async () => {
    process.env.REQUIRE_CONFIRMATION_TOKEN = 'true'
    const { execute } = await setup()
    const id = await myReservation()
    const ask = await execute('cancelReservation', { reservationId: id }, agent(customerCtx)) as any
    const args = { reservationId: id, confirmationToken: ask.error.confirmation.token, idempotencyKey: 'conf-k' }
    const first = await execute('cancelReservation', args, agent(customerCtx)) as any
    const again = await execute('cancelReservation', args, agent(customerCtx)) as any
    expect(first.success).toBe(true)
    expect(again).toMatchObject({ success: true, idempotency: { key: 'conf-k', replayed: true } })
  })

  it('a refused confirmation releases the idempotency key', async () => {
    const { execute } = await setup()
    const id = await myReservation()
    const ask = await execute('cancelReservation', { reservationId: id, idempotencyKey: 'conf-rel' }, agent(customerCtx)) as any
    expect(ask.error.code).toBe('CONFIRMATION_REQUIRED')
    const run = await execute('cancelReservation', { reservationId: id, idempotencyKey: 'conf-rel', confirmationToken: ask.error.confirmation.token }, agent(customerCtx)) as any
    expect(run.success).toBe(true)
    expect(run.idempotency).toBeUndefined()
  })
})

describe('dryRun', () => {
  it('previews a destructive call, never runs it, and hands out a token that works afterwards', async () => {
    const { execute, store } = await setup()
    const id = await myReservation('Dry Guest')
    const before = JSON.stringify(store.getAllReservations())
    const dry = await execute('cancelReservation', { reservationId: id, dryRun: true }, agent(customerCtx)) as any
    expect(dry.success).toBe(true)
    expect(dry.data.dryRun).toBe(true)
    expect(dry.data.preview.summary).toMatch(/Dry Guest/)
    expect(JSON.stringify(store.getAllReservations())).toBe(before)
    expect(audited.at(-1)?.meta.dryRun).toBe(true)
    const run = await execute('cancelReservation', { reservationId: id, confirmationToken: dry.data.confirmation.token }, agent(customerCtx)) as any
    expect(run.success).toBe(true)
  })

  it('works on any server write: no mutation, generic preview when the op has none', async () => {
    const { execute, tasks } = await setup()
    const size = tasks.size
    const dry = await execute('createTask', { title: 'Dry task', department: 'Housekeeping', priority: 'low', dryRun: true }, adminCtx) as any
    expect(dry.success).toBe(true)
    expect(dry.data.preview.summary).toMatch(/^Create Task \(title=Dry task/)
    expect(dry.data.confirmation).toBeUndefined()
    expect(tasks.size).toBe(size)
  })

  it('the preview\'s own failure comes back (check a plan before asking)', async () => {
    const { execute } = await setup()
    const r = await execute('issueRefund', { paymentId: 'p_missing', reason: 'Guest complaint', dryRun: true }, adminCtx) as any
    expect(r.error.code).toBe('NOT_FOUND')
  })

  it('is not accepted on reads (strict input)', async () => {
    const { execute } = await setup()
    const r = await execute('getGuest', { guestId: 'g_1', dryRun: true }, adminCtx) as any
    expect(r.error.code).toBe('INVALID_INPUT')
  })

  it('adds little to schemas: describe_tool(book) stays inside one 4 KB credit size unit', async () => {
    const { execute } = await setup()
    const { bytesOf } = await import('@/lib/credits/policy')
    const r = await execute('describe_tool', { name: 'book' }, customerCtx)
    expect(bytesOf(r)).toBeLessThan(4096)
  })

  it('is charged at read cost', async () => {
    await setup()
    const { chargeFor, weightOf } = await import('@/lib/credits/policy')
    const { getOpByName } = await import('@/lib/operations/execute')
    const p = { sizeUnit: 4096 } as any
    const op = getOpByName().get('cancelReservation')!
    expect(weightOf(op)).toBe(2)
    expect(chargeFor(op, { reservationId: 'r', dryRun: true }, (n) => getOpByName().get(n), p).weight).toBe(1)
    const invoke = getOpByName().get('invoke')!
    const batch = { calls: [{ name: 'cancelReservation', args: { reservationId: 'r', dryRun: true } }, { name: 'createTask', args: {} }] }
    expect(chargeFor(invoke, batch, (n) => getOpByName().get(n), p).weight).toBe(3)
  })
})

describe('through invoke', () => {
  it('a nested destructive call relays CONFIRMATION_REQUIRED with its preview and token', async () => {
    const { execute } = await setup()
    const id = await myReservation()
    const r = await execute('invoke', { name: 'cancelReservation', args: { reservationId: id } }, agent(customerCtx)) as any
    expect(r.error.code).toBe('CONFIRMATION_REQUIRED')
    expect(r.error.confirmation.token).toBeTruthy()
    const ok = await execute('invoke', { name: 'cancelReservation', args: { reservationId: id, confirmationToken: r.error.confirmation.token } }, agent(customerCtx)) as any
    expect(ok.success).toBe(true)
  })
})

// ── MCP elicitation ──────────────────────────────────────────────────────────

const TOKEN = 'tok_conf'
let client: Client

async function connect(opts: { elicit?: (req: any) => any; loaded?: string[] } = {}) {
  await import('@/lib/operations/index')
  const { registerMcpTools, withMcpAuthRole } = await import('@/lib/adapters/mcp')
  const { addLoaded } = await import('@/lib/loadedTools')
  if (opts.loaded) addLoaded(TOKEN, opts.loaded)
  const server = new McpServer({ name: 't', version: '0' })
  await withMcpAuthRole(async () => { registerMcpTools(server); return new Response() }, () => 'customer', () => TOKEN)(new Request('http://x/api/mcp'))
  const [a, b] = InMemoryTransport.createLinkedPair()
  const send = a.send.bind(a)
  a.send = (msg, o) => send(msg, { ...o, authInfo: { token: TOKEN, clientId: 'c_mcp', scopes: [], extra: { userId: 'u_alice', role: 'customer' } } })
  await server.connect(b)
  client = new Client({ name: 'conf-client', version: '0' }, opts.elicit ? { capabilities: { elicitation: {} } } : {})
  if (opts.elicit) client.setRequestHandler('elicitation/create', async (req) => opts.elicit!(req))
  await client.connect(a)
  // The adapter's import installs the real audit trail; capture it again.
  await captureAudit()
}

afterEach(async () => { await client?.close() })

describe('MCP elicitation', () => {
  it('the client is asked with the preview; accepting runs the call, audited as user-elicitation', async () => {
    const { store } = await setup()
    const id = await myReservation('Elicit Me')
    const seen: string[] = []
    await connect({ elicit: (req) => { seen.push(req.params.message); return { action: 'accept', content: { approve: true } } } })
    const r = await client.callTool({ name: 'invoke', arguments: { name: 'cancelReservation', args: { reservationId: id } } }) as any
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/Cancel reservation .* for Elicit Me/)
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent).toMatchObject({ cancelled: true, reservationId: id })
    expect(store.getReservationById(id)).toBeUndefined()
    const cancel = audited.filter((c) => c.operation === 'cancelReservation')
    expect(cancel.at(-1)?.meta.approvedBy).toBe('user-elicitation')
  })

  it('declining is CONFIRMATION_DENIED, and nothing is done', async () => {
    const { store } = await setup()
    const id = await myReservation()
    await connect({ elicit: () => ({ action: 'decline' }) })
    const r = await client.callTool({ name: 'invoke', arguments: { name: 'cancelReservation', args: { reservationId: id } } }) as any
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content[0].text).code).toBe('CONFIRMATION_DENIED')
    expect(store.getReservationById(id)).toBeDefined()
  })

  it('answering approve: false is a decline too', async () => {
    const id = await myReservation()
    await connect({ elicit: () => ({ action: 'accept', content: { approve: false } }) })
    const r = await client.callTool({ name: 'invoke', arguments: { name: 'cancelReservation', args: { reservationId: id } } }) as any
    expect(JSON.parse(r.content[0].text).code).toBe('CONFIRMATION_DENIED')
  })

  it('a client without elicitation gets CONFIRMATION_REQUIRED with the preview and token', async () => {
    const id = await myReservation()
    await connect()
    const r = await client.callTool({ name: 'invoke', arguments: { name: 'cancelReservation', args: { reservationId: id } } }) as any
    expect(r.isError).toBe(true)
    const err = JSON.parse(r.content[0].text)
    expect(err.code).toBe('CONFIRMATION_REQUIRED')
    expect(err.confirmation.token).toMatch(/^c1\./)
  })

  it('a batch with several destructive calls asks once, listing each', async () => {
    const a = await myReservation('Batch A')
    const b = await myReservation('Batch B')
    const seen: string[] = []
    await connect({ elicit: (req) => { seen.push(req.params.message); return { action: 'accept', content: { approve: true } } } })
    const r = await client.callTool({ name: 'invoke', arguments: { calls: [
      { name: 'cancelReservation', args: { reservationId: a } },
      { name: 'cancelReservation', args: { reservationId: b } },
    ] } }) as any
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/Batch A[\s\S]*Batch B/)
    expect(r.structuredContent.results.map((x: any) => x.success)).toEqual([true, true])
  })

  it('a batch that also wrote is not re-run for elicitation: the tokens come back instead', async () => {
    const { store } = await setup()
    const id = await myReservation()
    const slot = store.searchAvailability('2026-07-08', 2)[0]
    const elicit = vi.fn(() => ({ action: 'accept', content: { approve: true } }))
    await connect({ elicit })
    const r = await client.callTool({ name: 'invoke', arguments: { calls: [
      { name: 'createReservation', args: { slotId: slot.id, name: 'Wrote Once', partySize: 2 } },
      { name: 'cancelReservation', args: { reservationId: id } },
    ] } }) as any
    expect(elicit).not.toHaveBeenCalled()
    expect(r.structuredContent.results[1].error.code).toBe('CONFIRMATION_REQUIRED')
    expect(store.getAllReservations().filter((x) => x.name === 'Wrote Once')).toHaveLength(1)
  })

  it('a native tool\'s dryRun passes the SDK output check', async () => {
    const id = await myReservation()
    await connect({ loaded: ['cancelReservation'] })
    const r = await client.callTool({ name: 'cancelReservation', arguments: { reservationId: id, dryRun: true } }) as any
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent).toMatchObject({ dryRun: true, preview: { summary: expect.stringMatching(/Cancel reservation/) } })
  })
})
