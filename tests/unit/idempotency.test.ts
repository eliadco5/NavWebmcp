// @vitest-environment node
// Idempotency keys (NavWebMcp 2.1.0): a keyed write runs at most once per
// (user, operation, key). Replays, conflicts, calls still running, failures,
// expiry, composites, credits, and where the key is published.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { customerCtx, supportCtx } from '@/tests/helpers'
import type { Actor, OperationContext } from '@/lib/operations/types'

const BOOK = { date: '2026-07-07', time: '18:00', partySize: 2, name: 'Dana' }
const task = (title: string, idempotencyKey?: string) => ({ title, department: 'Housekeeping', priority: 'low', ...(idempotencyKey && { idempotencyKey }) })

async function setup() {
  await import('@/lib/operations/index')
  const exec = await import('@/lib/operations/execute')
  const { store } = await import('@/lib/store')
  const port = await import('@/lib/idempotency/port')
  return { ...exec, store, port }
}

/** The first open slot on BOOK.date with room for two. */
async function openSlotId() {
  const { store } = await setup()
  const slot = store.searchAvailability(BOOK.date, 2)[0]
  expect(slot).toBeDefined()
  return slot.id
}

function reservationsNamed(store: { getAllReservations(): { name: string; status?: string }[] }, name: string) {
  return store.getAllReservations().filter((r) => r.name === name && r.status !== 'cancelled')
}

beforeAll(async () => {
  await import('@/lib/operations/index')
}, 60_000)

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.IDEMPOTENCY_TTL_SECONDS
})

describe('replay and conflict', () => {
  it('the same key and arguments return the first result and write once', async () => {
    const { execute, store } = await setup()
    const args = { slotId: await openSlotId(), name: 'Idem One', partySize: 2, idempotencyKey: 'k-1' }
    const first = await execute('createReservation', args, customerCtx) as any
    const second = await execute('createReservation', args, customerCtx) as any
    expect(first.success).toBe(true)
    expect(first.idempotency).toBeUndefined()
    expect(second).toMatchObject({ success: true, idempotency: { key: 'k-1', replayed: true } })
    expect(second.data).toEqual(first.data)
    expect(reservationsNamed(store, 'Idem One')).toHaveLength(1)
  })

  it('argument key order does not matter', async () => {
    const { execute } = await setup()
    const slotId = await openSlotId()
    await execute('createReservation', { slotId, name: 'Idem Order', partySize: 2, idempotencyKey: 'k-order' }, customerCtx)
    const again = await execute('createReservation', { idempotencyKey: 'k-order', partySize: 2, name: 'Idem Order', slotId }, customerCtx) as any
    expect(again.idempotency?.replayed).toBe(true)
  })

  it('the same key with other arguments is IDEMPOTENCY_CONFLICT and runs nothing', async () => {
    const { execute, store } = await setup()
    const slotId = await openSlotId()
    await execute('createReservation', { slotId, name: 'Idem Two', partySize: 2, idempotencyKey: 'k-2' }, customerCtx)
    const clash = await execute('createReservation', { slotId, name: 'Idem Other', partySize: 2, idempotencyKey: 'k-2' }, customerCtx) as any
    expect(clash.success).toBe(false)
    expect(clash.error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false })
    expect(clash.error.details).toEqual([{ path: 'idempotencyKey', message: expect.any(String) }])
    expect(reservationsNamed(store, 'Idem Other')).toHaveLength(0)
  })

  it('keys are scoped per user and per operation', async () => {
    const { execute } = await setup()
    const a = await execute('createTask', task('Call Ida', 'shared'), supportCtx) as any
    const otherUser = await execute('createTask', task('Call Ida', 'shared'), { ...supportCtx, userId: 'u_dave' }) as any
    expect(a.success).toBe(true)
    expect(otherUser.success).toBe(true)
    expect(otherUser.idempotency).toBeUndefined()
    expect(otherUser.data.task.taskId).not.toBe(a.data.task.taskId)
    // Same user, same key, another op: independent too.
    const guest = await execute('createGuest', { name: 'Ida Empotent', email: 'ida@example.com', phone: '555-0100', idempotencyKey: 'shared' }, supportCtx) as any
    expect(guest.success).toBe(true)
    expect(guest.idempotency).toBeUndefined()
  })

  it('a call still running under the key is IDEMPOTENCY_IN_PROGRESS (retryable)', async () => {
    const { execute, port } = await setup()
    const slotId = await openSlotId()
    const args = { slotId, name: 'Idem Busy', partySize: 2 }
    const scope = await port.scopeKey(customerCtx.userId, 'createReservation', 'k-busy')
    const hash = await port.sha256Hex(port.canonicalArgs(args))
    await port.idempotencyStore().claim(scope, hash, 60_000)
    const r = await execute('createReservation', { ...args, idempotencyKey: 'k-busy' }, customerCtx) as any
    expect(r.error).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS', retryable: true })
  })

  it('concurrent identical calls make exactly one reservation', async () => {
    const { execute, store } = await setup()
    const args = { slotId: await openSlotId(), name: 'Idem Race', partySize: 2, idempotencyKey: 'k-race' }
    const results = await Promise.all(Array.from({ length: 5 }, () => execute('createReservation', args, customerCtx))) as any[]
    expect(reservationsNamed(store, 'Idem Race')).toHaveLength(1)
    const ran = results.filter((r) => r.success && !r.idempotency)
    expect(ran).toHaveLength(1)
    for (const r of results) {
      if (r !== ran[0]) expect(r.idempotency?.replayed === true || r.error?.code === 'IDEMPOTENCY_IN_PROGRESS').toBe(true)
    }
  })
})

describe('failures and expiry', () => {
  it('a failed call releases the key, so a corrected retry runs', async () => {
    const { execute, store } = await setup()
    const bad = await execute('createReservation', { slotId: 'slot_missing', name: 'Idem Fix', partySize: 2, idempotencyKey: 'k-fix' }, customerCtx) as any
    expect(bad.error.code).toBe('NOT_FOUND')
    const good = await execute('createReservation', { slotId: await openSlotId(), name: 'Idem Fix', partySize: 2, idempotencyKey: 'k-fix' }, customerCtx) as any
    expect(good.success).toBe(true)
    expect(good.idempotency).toBeUndefined()
    expect(reservationsNamed(store, 'Idem Fix')).toHaveLength(1)
  })

  it('invalid input never claims the key', async () => {
    const { execute } = await setup()
    const slotId = await openSlotId()
    const bad = await execute('createReservation', { slotId, name: '', partySize: 2, idempotencyKey: 'k-input' }, customerCtx) as any
    expect(bad.error.code).toBe('INVALID_INPUT')
    const good = await execute('createReservation', { slotId, name: 'Idem Input', partySize: 2, idempotencyKey: 'k-input' }, customerCtx) as any
    expect(good.success).toBe(true)
  })

  it('a record expires after the TTL; the same key then runs again', async () => {
    process.env.IDEMPOTENCY_TTL_SECONDS = '60'
    const { execute } = await setup()
    const t = task('Expiring', 'k-ttl')
    const first = await execute('createTask', t, supportCtx) as any
    expect((await execute('createTask', t, supportCtx) as any).idempotency?.replayed).toBe(true)
    const later = Date.now() + 61_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    const after = await execute('createTask', t, supportCtx) as any
    expect(after.success).toBe(true)
    expect(after.idempotency).toBeUndefined()
    expect(after.data.task.taskId).not.toBe(first.data.task.taskId)
  })

  it('a key longer than 128 characters is INVALID_INPUT', async () => {
    const { execute } = await setup()
    const r = await execute('createTask', task('Long key', 'x'.repeat(129)), supportCtx) as any
    expect(r.error.code).toBe('INVALID_INPUT')
    expect(r.error.details[0].path).toBe('idempotencyKey')
  })

  it('reads do not accept a key (strict input)', async () => {
    const { execute } = await setup()
    const r = await execute('getWaitTime', { idempotencyKey: 'k' }, customerCtx) as any
    expect(r.error.code).toBe('INVALID_INPUT')
  })

  it('the handler never sees the key', async () => {
    const { execute, getOpByName } = await setup()
    const op = getOpByName().get('createTask')!
    const spy = vi.spyOn(op, 'handler')
    await execute('createTask', task('Strip', 'k-strip'), supportCtx)
    expect(spy.mock.calls[0][0]).not.toHaveProperty('idempotencyKey')
  })
})

describe('timeouts and composites', () => {
  it('book retried after a timeout makes one reservation: in progress, then replayed', async () => {
    const { execute, getOpByName, store } = await setup()
    const op = getOpByName().get('book')!
    const original = op.handler
    const saved = op.deadlineMs
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    op.deadlineMs = 20
    op.handler = (async (input: any, ctx: any) => { await gate; return original(input, ctx) }) as typeof op.handler
    try {
      const args = { ...BOOK, name: 'Idem Slow', idempotencyKey: 'k-slow' }
      const timedOut = await execute('book', args, customerCtx) as any
      expect(timedOut.error).toMatchObject({ code: 'HANDLER_TIMEOUT', retryable: true })
      expect(timedOut.error.hint).toMatch(/idempotencyKey/)
      const busy = await execute('book', args, customerCtx) as any
      expect(busy.error.code).toBe('IDEMPOTENCY_IN_PROGRESS')
      release()
      await vi.waitFor(async () => {
        const r = await execute('book', args, customerCtx) as any
        expect(r.idempotency?.replayed).toBe(true)
      })
      expect(reservationsNamed(store, 'Idem Slow')).toHaveLength(1)
    } finally {
      op.handler = original
      op.deadlineMs = saved
    }
  })

  it('an unkeyed timeout keeps the old, non-retryable error', async () => {
    const { execute, getOpByName } = await setup()
    const op = getOpByName().get('createTask')!
    const original = op.handler
    const saved = op.deadlineMs
    op.deadlineMs = 10
    op.handler = (async (input: any, ctx: any) => { await new Promise((r) => setTimeout(r, 50)); return original(input, ctx) }) as typeof op.handler
    try {
      const r = await execute('createTask', task('No key'), supportCtx) as any
      expect(r.error).toMatchObject({ code: 'HANDLER_TIMEOUT', retryable: false })
    } finally {
      op.handler = original
      op.deadlineMs = saved
    }
  })

  it('a keyed composite passes derived keys to the writes it runs', async () => {
    const { execute, store } = await setup()
    const booked = await execute('book', { ...BOOK, name: 'Idem Child', idempotencyKey: 'k-book' }, customerCtx) as any
    expect(booked.success).toBe(true)
    // The nested createReservation ran under 'k-book/createReservation#1'.
    const child = await execute('createReservation', {
      slotId: booked.data.reservation.slotId, name: 'Idem Child', partySize: 2,
      idempotencyKey: 'k-book/createReservation#1',
    }, customerCtx) as any
    expect(child.idempotency?.replayed).toBe(true)
    expect(child.data.reservation.id).toBe(booked.data.reservation.id)
    expect(reservationsNamed(store, 'Idem Child')).toHaveLength(1)
  })

  it('an unkeyed composite runs its writes unkeyed', async () => {
    const { execute, store } = await setup()
    const a = await execute('book', { ...BOOK, time: '20:00', name: 'Idem Free' }, customerCtx) as any
    expect(a.success).toBe(true)
    expect(reservationsNamed(store, 'Idem Free')).toHaveLength(1)
  })

  it('keyed writes inside an invoke batch are each idempotent', async () => {
    const { execute } = await setup()
    const calls = [{ name: 'createTask', args: task('Batch A', 'b-a') }]
    await execute('invoke', { calls }, supportCtx)
    const again = await execute('invoke', { calls }, supportCtx) as any
    expect(again.data.results[0].idempotency).toEqual({ key: 'b-a', replayed: true })
  })
})

describe('credits', () => {
  const agent: Actor = { type: 'agent', userId: 'u_alice', role: 'customer', assurance: 'verified', agent: { clientId: 'c_idem' } }
  const ctx = (): OperationContext => ({ userId: 'u_alice', role: 'customer', token: '', actor: agent, meta: { requestId: crypto.randomUUID(), channel: 'mcp' } })

  beforeEach(() => {
    delete process.env.CREDITS_ENABLED
    process.env.CREDITS_AGENT_TIME_UNIT_MS = '60000'
  })
  afterEach(() => {
    delete process.env.CREDITS_AGENT_TIME_UNIT_MS
  })

  it('a replay is charged the per-request cost only', async () => {
    const { executeDetailed } = await setup()
    await import('@/lib/credits')
    const { REQUEST_COST } = await import('@/lib/credits/policy')
    const args = { slotId: await openSlotId(), name: 'Idem Paid', partySize: 2, idempotencyKey: 'k-paid' }
    const first = await executeDetailed('createReservation', args, ctx())
    const replay = await executeDetailed('createReservation', args, ctx())
    expect(first.credits!.charged).toBeGreaterThan(REQUEST_COST)
    expect(replay.result).toMatchObject({ idempotency: { replayed: true } })
    expect(replay.credits!.charged).toBe(REQUEST_COST)
  })

  it('invoke relaying a replay is charged the per-request cost only', async () => {
    const { executeDetailed } = await setup()
    await import('@/lib/credits')
    const { REQUEST_COST } = await import('@/lib/credits/policy')
    const args = { name: 'book', args: { ...BOOK, time: '12:00', name: 'Idem Relay', idempotencyKey: 'k-relay' } }
    const first = await executeDetailed('invoke', args, ctx())
    const replay = await executeDetailed('invoke', args, ctx())
    expect(first.credits!.charged).toBeGreaterThan(REQUEST_COST)
    expect(replay.result).toMatchObject({ success: true, idempotency: { key: 'k-relay', replayed: true } })
    expect(replay.credits!.charged).toBe(REQUEST_COST)
  })
})

describe('published contract', () => {
  it('every server-side write publishes idempotencyKey; no read, invoke or ui_* op does', async () => {
    const { registry } = await import('@/lib/operations/index')
    const { isIdempotentOp } = await import('@/lib/idempotency/port')
    for (const op of registry) {
      expect('idempotencyKey' in op.inputSchema, op.name).toBe(isIdempotentOp(op))
    }
    expect(registry.filter(isIdempotentOp).length).toBeGreaterThan(20)
    expect(isIdempotentOp(registry.find((o) => o.name === 'invoke')!)).toBe(false)
    expect(isIdempotentOp(registry.find((o) => o.name === 'ui_action')!)).toBe(false)
  })

  it('describe_tool, getCapabilities and MCP annotations say which ops are idempotent', async () => {
    const { execute } = await setup()
    const d = await execute('describe_tool', { name: ['createReservation', 'getReservation'] }, customerCtx) as any
    expect(d.data.tools[0].idempotent).toBe(true)
    expect(d.data.tools[0].inputSchema.properties).toHaveProperty('idempotencyKey')
    expect(d.data.tools[0].inputSchema.required).not.toContain('idempotencyKey')
    expect(d.data.tools[1].idempotent).toBeUndefined()
    const caps = await execute('getCapabilities', {}, customerCtx) as any
    expect(caps.data.tools.find((t: any) => t.name === 'book').idempotent).toBe(true)
    expect(caps.data.tools.find((t: any) => t.name === 'getReservation').idempotent).toBeUndefined()
    const { mcpAnnotations } = await import('@/lib/adapters/mcp')
    const { getOpByName } = await import('@/lib/operations/execute')
    expect(mcpAnnotations(getOpByName().get('createReservation')!)).toMatchObject({ idempotentHint: true })
    expect(mcpAnnotations(getOpByName().get('getReservation')!)).not.toHaveProperty('idempotentHint')
  })
})
