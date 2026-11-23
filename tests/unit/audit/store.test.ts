// @vitest-environment node
// The SOC2 audit store: append-only, hash-chained, queryable, retained.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { AuditEventBody } from '@/lib/audit/types'

function body(over: Partial<AuditEventBody> = {}): AuditEventBody {
  return {
    v: 1, id: crypto.randomUUID(), ts: new Date().toISOString(), category: 'operation',
    action: 'getWaitTime', outcome: 'success', channel: 'ui',
    actor: { type: 'human', userId: 'u_alice', role: 'customer', assurance: 'asserted' },
    ...over,
  }
}

describe('memory backend (no REDIS_URL)', () => {
  beforeEach(() => { delete process.env.REDIS_URL })

  it('assigns contiguous sequence numbers even for concurrent appends, and the chain verifies', async () => {
    const store = await import('@/lib/audit/store')
    const events = await Promise.all(Array.from({ length: 20 }, () => store.appendAuditEvent(body())))
    expect(events.map((e) => e!.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(await store.verifyAuditChain()).toMatchObject({ ok: true, checked: 20, durable: false })
  })

  it('verification catches an edited or truncated store', async () => {
    const store = await import('@/lib/audit/store')
    for (let i = 0; i < 5; i++) await store.appendAuditEvent(body())
    const mem = globalThis.__auditStore!
    mem.events[2] = { ...mem.events[2], outcome: 'failure' }
    expect(await store.verifyAuditChain()).toMatchObject({ ok: false, brokenAt: { seq: 3, reason: 'hash_mismatch' } })

    mem.events[2] = { ...mem.events[2], outcome: 'success' } // restore
    expect((await store.verifyAuditChain()).ok).toBe(true)
    mem.events.pop() // drop the newest: head no longer matches
    expect((await store.verifyAuditChain()).ok).toBe(false)
  })

  it('queries newest first with filters and a cursor', async () => {
    const store = await import('@/lib/audit/store')
    for (let i = 0; i < 6; i++) {
      await store.appendAuditEvent(body({
        action: i % 2 ? 'createReservation' : 'getWaitTime',
        target: i % 2 ? { type: 'reservation', id: `res_${i}` } : undefined,
        actor: i < 3
          ? { type: 'human', userId: 'u_alice', role: 'customer', assurance: 'asserted' }
          : { type: 'agent', userId: 'u_alice', role: 'customer', assurance: 'verified', agent: { clientId: 'c_x' } },
      }))
    }
    const agents = await store.queryAudit({ actorType: 'agent' })
    expect(agents.events.map((e) => e.seq)).toEqual([6, 5, 4])
    expect((await store.queryAudit({ clientId: 'c_x', action: 'createReservation' })).events.map((e) => e.seq)).toEqual([6, 4])
    expect((await store.queryAudit({ targetType: 'reservation', targetId: 'res_1' })).events).toHaveLength(1)

    const page1 = await store.queryAudit({ limit: 2 })
    expect(page1.events.map((e) => e.seq)).toEqual([6, 5])
    const page2 = await store.queryAudit({ limit: 2, beforeSeq: page1.nextBeforeSeq })
    expect(page2.events.map((e) => e.seq)).toEqual([4, 3])
  })

  it('retention drops only events older than the window', async () => {
    const store = await import('@/lib/audit/store')
    process.env.AUDIT_RETENTION_DAYS = '30'
    const now = Date.parse('2026-11-23T00:00:00Z')
    const day = 86_400_000
    for (const ageDays of [90, 60, 31, 10, 1]) {
      await store.appendAuditEvent(body({ ts: new Date(now - ageDays * day).toISOString() }))
    }
    expect(await store.enforceRetention(now)).toEqual({ trimmed: 3, oldestSeq: 4 })
    const left = await store.queryAudit({})
    expect(left.events.map((e) => e.seq)).toEqual([5, 4])
    // The retained window still verifies from its own anchor.
    expect((await store.verifyAuditChain()).ok).toBe(true)
    delete process.env.AUDIT_RETENTION_DAYS
  })
})

describe('redis backend', () => {
  // A fake that implements exactly the commands the store uses, including the
  // compare-and-set semantics of its Lua append script.
  function fakeRedis() {
    const state = { head: '' as string, stream: [] as { id: string; message: Record<string, string> }[] }
    const seqOf = (id: string) => Number(id.split('-')[0])
    return {
      state,
      isReady: true,
      async get() { return state.head || null },
      async eval(_script: string, { arguments: [expected, next, seq, json] }: { keys: string[]; arguments: string[] }) {
        if (state.head !== expected) return state.head
        state.stream.push({ id: `${seq}-0`, message: { e: json } })
        state.head = next
        return 'OK'
      },
      async xRange(_k: string, from: string, to: string, { COUNT }: { COUNT: number }) {
        return state.stream.filter((x) => seqOf(x.id) >= seqOf(from) && seqOf(x.id) <= seqOf(to)).slice(0, COUNT)
      },
      async xRevRange(_k: string, to: string, from: string, { COUNT }: { COUNT: number }) {
        return state.stream.filter((x) => seqOf(x.id) >= seqOf(from) && seqOf(x.id) <= seqOf(to)).reverse().slice(0, COUNT)
      },
      async xTrim(_k: string, _s: string, minId: string) {
        const before = state.stream.length
        state.stream = state.stream.filter((x) => seqOf(x.id) >= seqOf(minId))
        return before - state.stream.length
      },
    }
  }

  let fake: ReturnType<typeof fakeRedis>
  beforeEach(() => {
    fake = fakeRedis()
    vi.doMock('@/lib/shared-state/redis', () => ({ getRedis: async () => fake }))
  })
  afterEach(() => { vi.doUnmock('@/lib/shared-state/redis') })

  it('re-links on top of another instance\'s append instead of forking the chain', async () => {
    const store = await import('@/lib/audit/store')
    const { link } = await import('@/lib/audit/chain')
    await store.appendAuditEvent(body())

    // Another instance appends between our head read and our CAS: simulate by
    // wrapping eval so the first attempt loses the race.
    const realEval = fake.eval.bind(fake)
    let raced = false
    fake.eval = async (script, args) => {
      if (!raced) {
        raced = true
        const [seq, hash] = fake.state.head.split(':')
        const foreign = link(body({ action: 'fromOtherInstance' }), { seq: Number(seq), hash })
        await realEval(script, { keys: [], arguments: [fake.state.head, `${foreign.seq}:${foreign.hash}`, String(foreign.seq), JSON.stringify(foreign)] })
      }
      return realEval(script, args)
    }
    const mine = await store.appendAuditEvent(body({ action: 'mine' }))
    expect(mine!.seq).toBe(3)
    expect(fake.state.stream.map((x) => JSON.parse(x.message.e).action)).toEqual(['getWaitTime', 'fromOtherInstance', 'mine'])
    expect(await store.verifyAuditChain()).toMatchObject({ ok: true, checked: 3, durable: true })
  })

  it('falls back to memory (and does not throw) when Redis fails', async () => {
    const store = await import('@/lib/audit/store')
    fake.eval = async () => { throw new Error('connection reset') }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const e = await store.appendAuditEvent(body())
    expect(e).not.toBeNull()
    expect(globalThis.__auditStore!.events).toHaveLength(1)
    err.mockRestore()
  })
})
