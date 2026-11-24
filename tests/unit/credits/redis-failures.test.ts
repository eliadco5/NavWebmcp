// @vitest-environment node
// Credits against a Redis that misbehaves: hangs (connected but never
// answering), throws, returns garbage, or loses every CAS race. In every case
// a call must still be answered quickly and metering must keep working.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Fake = {
  mGet: (keys: string[]) => Promise<(string | null)[]>
  get: (k: string) => Promise<string | null>
  eval: (s: string, o: unknown) => Promise<number>
  sAdd: () => Promise<number>
  sMembers: () => Promise<string[]>
  sRem: () => Promise<number>
  del: () => Promise<number>
  multi: () => { set: () => unknown; sAdd: () => unknown; exec: () => Promise<unknown> }
}
const state: { fake: Fake | null } = vi.hoisted(() => ({ fake: null }))
vi.mock('@/lib/shared-state/redis', () => ({
  getRedis: async () => state.fake,
  isRedisDown: () => false,
  resetRedisClientForTests: () => undefined,
}))

const never = () => new Promise<never>(() => {})
function fake(over: Partial<Fake>): Fake {
  const chain = { set: () => chain, sAdd: () => chain, exec: async () => [] }
  return {
    mGet: async (keys) => keys.map(() => null), get: async () => null, eval: async () => 1,
    sAdd: async () => 1, sMembers: async () => [], sRem: async () => 0, del: async () => 1,
    multi: () => chain, ...over,
  }
}

beforeEach(() => {
  state.fake = null
  process.env.CREDITS_REDIS_TIMEOUT_MS = '100'
})

async function ledgerMod() {
  return import('@/lib/credits/ledger')
}

describe('Redis misbehaving', () => {
  it('hung Redis: an update falls back to memory within the timeout', async () => {
    state.fake = fake({ mGet: never, eval: never, get: never })
    const { updateLedger, freshLedger } = await ledgerMod()
    const { profile } = await import('@/lib/credits/policy')
    const t0 = Date.now()
    await updateLedger('a:hung', (cur) => ({ next: { ...(cur ?? freshLedger(profile('agent'), 1)), calls: 3 }, value: null }))
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(globalThis.__creditLedgers!.ledgers.get('a:hung')?.calls).toBe(3)
  })

  it('hung Redis: a full metered call through execute() is answered quickly', async () => {
    state.fake = fake({ mGet: never, eval: never, get: never, sMembers: never })
    await import('@/lib/operations/index')
    await import('@/lib/credits')
    const { executeDetailed } = await import('@/lib/operations/execute')
    const actor = { type: 'agent' as const, userId: 'u_alice', role: 'customer' as const, assurance: 'verified' as const, agent: { clientId: 'c_hung' } }
    const t0 = Date.now()
    const { result, credits } = await executeDetailed('explore', {}, { userId: 'u_alice', role: 'customer', token: '', actor, meta: { requestId: 'r', channel: 'mcp' } })
    expect(result.success).toBe(true)
    expect(credits).toBeTruthy()
    expect(Date.now() - t0).toBeLessThan(2000)
  }, 10_000)

  it('Redis throwing on every command: metering continues in memory', async () => {
    const boom = async () => { throw new Error('ECONNRESET') }
    state.fake = fake({ mGet: boom, eval: boom, get: boom })
    const { updateLedger, getLedger, freshLedger } = await ledgerMod()
    const { profile } = await import('@/lib/credits/policy')
    for (let i = 0; i < 5; i++) {
      await updateLedger('a:boom', (cur) => {
        const l = cur ?? freshLedger(profile('agent'), 1)
        return { next: { ...l, calls: l.calls + 1 }, value: null }
      })
    }
    expect((await getLedger('a:boom')).ledger?.calls).toBe(5)
  })

  it('Redis returning garbage: the caller starts fresh, never locked out', async () => {
    state.fake = fake({ mGet: async () => ['{"balance":"NaN"', '<<<'], eval: async () => 1 })
    const { updateLedger, freshLedger, reserve } = await ledgerMod()
    const { profile } = await import('@/lib/credits/policy')
    const p = profile('agent')
    const ok = await updateLedger('a:garbage', (cur) => {
      const r = reserve(cur ?? freshLedger(p, Date.now()), 2, p, Date.now())
      return { next: r.ledger, value: r.ok }
    })
    expect(ok).toBe(true)
  })

  it('every CAS lost (permanent contention): still answers, falls back to memory', async () => {
    state.fake = fake({ eval: async () => 0 })
    const { updateLedger, freshLedger } = await ledgerMod()
    const { profile } = await import('@/lib/credits/policy')
    const t0 = Date.now()
    const v = await updateLedger('a:contended', (cur) => ({ next: cur ?? freshLedger(profile('agent'), 1), value: 'done' }))
    expect(v).toBe('done')
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('admin listing with a hung Redis answers from memory', async () => {
    state.fake = fake({ sMembers: never, mGet: never })
    const { listLedgers } = await ledgerMod()
    const t0 = Date.now()
    await listLedgers()
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('sign-in throttle with a hung Redis never blocks a sign-in', async () => {
    state.fake = fake({ get: never, multi: () => ({ set: () => undefined as never, sAdd: () => undefined as never, exec: never }) as never })
    // multi().incr().expire().exec() chain
    state.fake.multi = () => {
      const c = { incr: () => c, expire: () => c, exec: never }
      return c as never
    }
    const { loginBlockedFor, noteLoginFailure } = await import('@/lib/login-throttle')
    const t0 = Date.now()
    expect(await loginBlockedFor('1.1.1.1', 'bob')).toBeNull()
    await noteLoginFailure('1.1.1.1', 'bob')
    expect(Date.now() - t0).toBeLessThan(1500)
  })
})
