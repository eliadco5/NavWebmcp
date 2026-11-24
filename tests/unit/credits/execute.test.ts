// @vitest-environment node
// Credits through execute(), the one path every call takes: who pays, when the
// Result carries a hint, backpressure, refusal, and the fan-out/deadline limits
// that ship with them.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import type { Actor, OperationContext } from '@/lib/operations/types'

const agent: Actor = { type: 'agent', userId: 'u_alice', role: 'customer', assurance: 'verified', agent: { clientId: 'c_test' } }
const human: Actor = { type: 'human', userId: 'u_alice', role: 'customer', assurance: 'asserted' }

async function setup() {
  await import('@/lib/operations/index')
  const credits = await import('@/lib/credits')
  const exec = await import('@/lib/operations/execute')
  return { ...credits, ...exec }
}

function ctx(actor: Actor, meta?: Partial<OperationContext['meta']>): OperationContext {
  return { userId: actor.userId, role: actor.role, token: '', actor, meta: { requestId: crypto.randomUUID(), channel: 'mcp', ...meta } }
}

// A loaded test runner can make a call take over a second. Keep that out of the
// exact-cost assertions: run time is charged per minute here, except in the one
// test that sets it back.
// Pay the cold module transform once, outside any one test's 5 s budget (the
// suite's other first-in-file tests hit that timeout under parallel load).
beforeAll(async () => {
  await import('@/lib/operations/index')
  await import('@/lib/credits')
}, 60_000)

beforeEach(() => {
  delete process.env.CREDITS_ENABLED
  process.env.CREDITS_AGENT_TIME_UNIT_MS = '60000'
})
afterEach(() => {
  delete process.env.CREDITS_AGENT_TIME_UNIT_MS
})

describe('metering', () => {
  it('a steady-state call carries no credits field, but the surface still gets the state', async () => {
    const { executeDetailed } = await setup()
    const { result, credits } = await executeDetailed('explore', {}, ctx(agent))
    expect(result.success).toBe(true)
    expect(result.credits).toBeUndefined()
    expect(credits).toMatchObject({ window: expect.any(Number), charged: 2, granted: 2 })
  })

  it('system actors and nested calls are not metered', async () => {
    const { executeDetailed, listCreditLedgers } = await setup()
    const sys: Actor = { type: 'system', userId: 'u_alice', role: 'customer', assurance: 'asserted' }
    expect((await executeDetailed('explore', {}, ctx(sys))).credits).toBeUndefined()
    // book runs 4 nested ops; only one ledger entry with one call.
    await executeDetailed('book', { date: '2026-07-07', time: '18:00', partySize: 2, name: 'Dana' }, ctx(agent))
    const rows = await listCreditLedgers()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ principal: 'a:c_test', calls: 1, spent: 5 })
  })

  it('people use the loose profile, keyed by user', async () => {
    const { executeDetailed, listCreditLedgers } = await setup()
    const { credits } = await executeDetailed('explore', {}, ctx(human, { channel: 'ui' }))
    expect(credits!.window).toBeGreaterThan(64)
    expect((await listCreditLedgers())[0]).toMatchObject({ principal: 'h:u_alice', kind: 'human' })
  })

  it('CREDITS_ENABLED=false turns it off', async () => {
    process.env.CREDITS_ENABLED = 'false'
    const { executeDetailed } = await setup()
    expect((await executeDetailed('explore', {}, ctx(agent))).credits).toBeUndefined()
  })
})

describe('when the caller should change course', () => {
  it('a burst in parallel: early calls run, the rest are refused with a plain-language hint and retryAfterMs', async () => {
    const { executeDetailed, creditTuning } = await setup()
    creditTuning.sleep = async () => {}
    const results = await Promise.all(Array.from({ length: 30 }, () => executeDetailed('explore', {}, ctx(agent))))
    const ok = results.filter((r) => r.result.success)
    const refused = results.filter((r) => !r.result.success)
    expect(ok.length).toBeGreaterThan(0)
    expect(refused.length).toBeGreaterThan(0)
    for (const r of refused) {
      expect(r.stage).toBe('credits')
      if (r.result.success) continue
      expect(r.result.error.code).toBe('INSUFFICIENT_CREDITS')
      expect(r.result.error.message).toMatch(/Retry in \d+ s|waiting for credits/)
      expect(r.result.credits?.hint).toBeTruthy()
      expect(r.result.credits?.retryAfterMs).toBeGreaterThan(0)
    }
  })

  it('refusals are audited and counted as denials', async () => {
    const { executeDetailed, setCreditPolicy } = await setup()
    await setCreditPolicy('a:c_test', { frozen: true }, 'u_bob')
    const { result } = await executeDetailed('explore', {}, ctx(agent))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe('INSUFFICIENT_CREDITS')
      expect(result.credits?.hint).toMatch(/administrator has paused/)
    }
    const { auditLog } = await import('@/lib/auditlog')
    expect(auditLog.getEntries()[0]).toMatchObject({ operation: 'explore', success: false })
  })

  it('backpressure: a caller slightly short is held, then run, and told to slow down', async () => {
    const { executeDetailed, creditTuning, setCreditPolicy } = await setup()
    // Window 2 = exactly one read in flight at a time.
    await setCreditPolicy('a:c_test', { maxWindow: 2, refillPerSec: 100 }, 'u_bob')
    let slept = 0
    creditTuning.sleep = async (ms) => { slept += ms; await new Promise((r) => setTimeout(r, ms)) }
    const [a, b] = await Promise.all([executeDetailed('explore', {}, ctx(agent)), executeDetailed('explore', {}, ctx(agent))])
    expect(a.result.success && b.result.success).toBe(true)
    expect(slept).toBeGreaterThan(0)
    const held = [a, b].find((r) => r.result.credits?.heldMs)
    expect(held?.result.credits?.hint).toMatch(/waited .* for credits/)
  })

  it('only one held call per caller: a third concurrent call is refused as busy', async () => {
    const { executeDetailed, creditTuning, setCreditPolicy } = await setup()
    await setCreditPolicy('a:c_test', { maxWindow: 2, refillPerSec: 100 }, 'u_bob')
    creditTuning.sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const rs = await Promise.all([1, 2, 3].map(() => executeDetailed('explore', {}, ctx(agent))))
    const busy = rs.find((r) => !r.result.success && r.result.credits?.hint?.includes('already waiting'))
    expect(busy).toBeTruthy()
  })

  it('a long call is charged for its time and the hint says why', async () => {
    const { executeDetailed } = await setup()
    const { registry } = await import('@/lib/operations/registry')
    const { invalidateOpCache } = await import('@/lib/operations/execute')
    registry.push({
      name: 'slowThing', title: 'Slow', description: 'test', permission: 'read', roles: ['customer'],
      inputSchema: {}, outputSchema: {},
      handler: async () => { await new Promise((r) => setTimeout(r, 1100)); return { success: true, data: {} } },
    } as never)
    invalidateOpCache()
    // Count anything over 0.5 s as long, so the test needn't wait 3 s.
    process.env.CREDITS_AGENT_LONG_CALL_MS = '500'
    process.env.CREDITS_AGENT_TIME_UNIT_MS = '1000'
    try {
      const { result, credits } = await executeDetailed('slowThing', {}, ctx(agent))
      expect(credits!.charged).toBe(2 + 1) // base 2 + 1 full second
      expect(credits!.window).toBe(8) // halved from 16
      expect(result.credits?.hint).toMatch(/because it ran 1 s.*hold at most 8 credits/)
    } finally {
      delete process.env.CREDITS_AGENT_LONG_CALL_MS
      registry.pop()
      invalidateOpCache()
    }
  }, 10_000)
})

describe('fan-out and deadline', () => {
  it('invoke nested deeper than the limit is refused with FANOUT_LIMIT', async () => {
    const { executeDetailed } = await setup()
    let args: Record<string, unknown> = { name: 'explore', args: {} }
    for (let i = 0; i < 4; i++) args = { name: 'invoke', args }
    const { result } = await executeDetailed('invoke', args, ctx(agent))
    const text = JSON.stringify(result)
    expect(text).toContain('FANOUT_LIMIT')
  })

  it('more than maxNested operations under one call are refused', async () => {
    const { executeDetailed, FANOUT } = await setup()
    const saved = FANOUT.maxNested
    FANOUT.maxNested = 5
    try {
      const calls = Array.from({ length: 8 }, () => ({ name: 'explore', args: {} }))
      const sys: Actor = { type: 'system', userId: 'u_alice', role: 'customer', assurance: 'asserted' }
      const { result } = await executeDetailed('invoke', { calls }, ctx(sys))
      const inner = (result as { data: { results: { success: boolean; error?: { code: string } }[] } }).data.results
      expect(inner.filter((r) => r.success)).toHaveLength(5)
      expect(inner.filter((r) => r.error?.code === 'FANOUT_LIMIT')).toHaveLength(3)
    } finally {
      FANOUT.maxNested = saved
    }
  })

  it('a handler past its deadline returns HANDLER_TIMEOUT', async () => {
    const { executeDetailed, invalidateOpCache } = await setup()
    const { registry } = await import('@/lib/operations/registry')
    registry.push({
      name: 'hangs', title: 'Hangs', description: 'test', permission: 'read', roles: ['customer'], deadlineMs: 50,
      inputSchema: {}, outputSchema: {},
      handler: () => new Promise(() => {}),
    } as never)
    invalidateOpCache()
    try {
      const { result } = await executeDetailed('hangs', {}, ctx(agent))
      expect(result.success).toBe(false)
      if (!result.success) expect(result.error.code).toBe('HANDLER_TIMEOUT')
    } finally {
      registry.pop()
      invalidateOpCache()
    }
  })
})

describe('getContext', () => {
  it('reports the caller\'s credit snapshot', async () => {
    const { executeDetailed } = await setup()
    const { result } = await executeDetailed('getContext', {}, ctx(agent))
    expect(result.success && (result.data as { credits?: unknown }).credits).toMatchObject({ window: 16, maxWindow: 64, frozen: false })
  })
})
