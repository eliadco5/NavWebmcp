// @vitest-environment node
// Opt-in: runs the management stores against a REAL Redis.
//   REDIS_LIVE_URL=redis://localhost:6379 npx vitest run tests/integration/redis-live.test.ts
// Skipped otherwise. Uses its own namespace and deletes its keys afterwards.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const URL = process.env.REDIS_LIVE_URL
const NS = `livetest${Date.now()}`

describe.skipIf(!URL)('against a real Redis', () => {
  beforeAll(() => {
    process.env.REDIS_URL = URL
    process.env.VERCEL_ENV = NS // namespaces every key this run writes
  })
  afterAll(async () => {
    const { getRedis } = await import('@/lib/shared-state/redis')
    const r = await getRedis()
    if (r) {
      for await (const batch of r.scanIterator({ MATCH: `*${NS}*`, COUNT: 500 })) {
        const keys = Array.isArray(batch) ? batch : [batch]
        if (keys.length) await r.del(keys)
      }
      await r.quit()
    }
    delete process.env.REDIS_URL
    delete process.env.VERCEL_ENV
  })

  it('audit: concurrent appends form one verifiable chain; tampering is detected', async () => {
    const store = await import('@/lib/audit/store')
    const body = (i: number) => ({
      v: 1 as const, id: `e${i}`, ts: new Date().toISOString(), category: 'operation' as const,
      action: 'op', outcome: 'success' as const, channel: 'ui' as const,
      actor: { type: 'human' as const, userId: 'u_alice', role: 'customer' as const, assurance: 'asserted' as const },
    })
    const events = await Promise.all(Array.from({ length: 25 }, (_, i) => store.appendAuditEvent(body(i))))
    expect(events.every(Boolean)).toBe(true)
    const v = await store.verifyAuditChain()
    expect(v).toMatchObject({ ok: true, checked: 25, durable: true })
    expect((await store.queryAudit({ limit: 3 })).events.map((e) => e.seq)).toEqual([25, 24, 23])

    // Tamper with one stored entry directly in Redis.
    const { getRedis } = await import('@/lib/shared-state/redis')
    const r = (await getRedis())!
    const key = `webmcp:audit:${NS}:v1`
    const [entry] = await r.xRange(key, '10-0', '10-0')
    const forged = { ...JSON.parse(entry.message.e), outcome: 'failure' }
    await r.xDel(key, '10-0')
    await r.xAdd(key, '10-0', { e: JSON.stringify(forged) }).catch(() => undefined) // ids must increase: may be refused
    const after = await store.verifyAuditChain()
    expect(after.ok).toBe(false)
  })

  it('metrics: counters, latency buckets and active-user HLLs round-trip', async () => {
    const { recordCallMetrics } = await import('@/lib/telemetry/metrics')
    const { getUsageSummary } = await import('@/lib/telemetry/summary')
    const now = Date.now()
    const base = {
      operation: 'createReservation', permission: 'write' as const, success: true, durationMs: 40, startedAt: now,
      meta: { requestId: 'r', callId: 'c', channel: 'mcp' as const },
    }
    await recordCallMetrics({ ...base, actor: { type: 'agent', userId: 'u_alice', role: 'customer', assurance: 'verified', agent: { clientId: 'c_live' } } })
    await recordCallMetrics({ ...base, meta: { ...base.meta, channel: 'ui' }, actor: { type: 'human', userId: 'u_bob', role: 'admin', assurance: 'asserted' } })
    const s = await getUsageSummary({ from: now - 60_000, to: now + 60_000 })
    expect(s.totals).toMatchObject({ calls: 2, writes: 2 })
    expect(s.adoption).toMatchObject({ activeUsers: 2, activeAgentClients: 1, agentShareOfWrites: 0.5 })
    expect(s.latency.p50Ms).toBe(50)
  })

  it('sessions/clients: revocation is visible to a fresh read', async () => {
    const { recordClient, listClients, getEnd } = await import('@/lib/management/sessions')
    const { revokeClient } = await import('@/lib/management/auth')
    await recordClient({ clientId: 'c_livex', userId: 'u_alice', role: 'customer', kind: 'connected', createdAt: new Date().toISOString() })
    await revokeClient('c_livex', 'u_bob')
    globalThis.__mgmtRecords = undefined // drop the in-process copy: read from Redis only
    expect(await getEnd('c_livex')).toMatchObject({ reason: 'revoked', by: 'u_bob' })
    expect((await listClients({ userId: 'u_alice' })).find((c) => c.clientId === 'c_livex')?.endReason).toBe('revoked')
  })
})
