// @vitest-environment node
// Usage metrics (in-app) and OTLP export: human vs agent usage, latency
// against the PRD target, adoption counts, and the trace shape of a composite.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { customerCtx } from '@/tests/helpers'
import type { CallObservation } from '@/lib/telemetry/port'

const { jar } = vi.hoisted(() => ({ jar: new Map<string, string>() }))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value) },
    delete: (name: string) => { jar.delete(name) },
  }),
}))

const NOW = Date.parse('2026-11-23T12:30:00Z')

function obs(over: Partial<CallObservation> & { actorType?: 'human' | 'agent' | 'system' } = {}): CallObservation {
  const { actorType = 'human', ...rest } = over
  return {
    operation: 'createReservation', permission: 'write', success: true, durationMs: 12,
    startedAt: NOW - 60_000,
    actor: actorType === 'agent'
      ? { type: 'agent', userId: 'u_alice', role: 'customer', assurance: 'verified', agent: { clientId: 'c_1', name: 'Claude' } }
      : { type: actorType, userId: actorType === 'system' ? 'system' : 'u_alice', role: 'customer', assurance: 'asserted' },
    meta: { requestId: crypto.randomUUID(), callId: crypto.randomUUID(), channel: actorType === 'agent' ? 'mcp' : 'ui' },
    ...rest,
  }
}

beforeEach(() => {
  jar.clear()
  delete process.env.REDIS_URL
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
})
afterEach(() => vi.unstubAllGlobals())

describe('percentile / buckets', () => {
  it('reads a percentile as the upper bound of its histogram bucket', async () => {
    const { percentile } = await import('@/lib/telemetry/summary')
    // 98 calls ≤5ms, 2 calls in (100,200]
    const hist = [98, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0]
    expect(percentile(hist, 0.5)).toBe(5)
    expect(percentile(hist, 0.99)).toBe(200)
    expect(percentile([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 0.99)).toBeNull() // > 5s
  })

  it('bucket ids round-trip in UTC', async () => {
    const { bucketId, bucketStart } = await import('@/lib/telemetry/metrics')
    expect(bucketId(NOW, 'minute')).toBe('202611231230')
    expect(bucketId(NOW, 'hour')).toBe('2026112312')
    expect(bucketStart('202611231230')).toBe(NOW)
  })
})

describe('usage summary', () => {
  it('splits human and agent usage, and the agent share of writes', async () => {
    const { recordCallMetrics } = await import('@/lib/telemetry/metrics')
    const { getUsageSummary } = await import('@/lib/telemetry/summary')
    await recordCallMetrics(obs())
    await recordCallMetrics(obs({ actorType: 'agent' }))
    await recordCallMetrics(obs({ actorType: 'agent' }))
    await recordCallMetrics(obs({ actorType: 'agent', operation: 'getWaitTime', permission: 'read', durationMs: 150 }))
    await recordCallMetrics(obs({ operation: 'issueRefund', success: false, errorCode: 'FORBIDDEN' }))

    const s = await getUsageSummary({ from: NOW - 3_600_000, to: NOW, includeConnections: false }, NOW)
    expect(s.range.resolution).toBe('minute')
    expect(s.totals).toMatchObject({ calls: 5, writes: 4, denials: 1, errors: 0, topLevelCalls: 5 })
    expect(s.byActorType.agent).toMatchObject({ calls: 3, writes: 2 })
    expect(s.byActorType.human).toMatchObject({ calls: 2, writes: 2, denials: 1 })
    expect(s.adoption.agentShareOfWrites).toBe(0.5)
    expect(s.adoption).toMatchObject({ activeUsers: 1, activeAgentClients: 1 })
    expect(s.byChannel.mcp.calls).toBe(3)
    expect(s.operations[0]).toMatchObject({ operation: 'createReservation', calls: 3, byActorType: { human: 1, agent: 2, system: 0 } })
    expect(s.latency).toMatchObject({ p50Ms: 25, p99Ms: 200, sloMs: 200, sloMet: true })
    expect(s.series.reduce((n, p) => n + p.agent, 0)).toBe(3)
  })

  it('uses hour buckets for long ranges', async () => {
    const { recordCallMetrics } = await import('@/lib/telemetry/metrics')
    const { getUsageSummary } = await import('@/lib/telemetry/summary')
    await recordCallMetrics(obs({ startedAt: NOW - 3 * 86_400_000 }))
    await recordCallMetrics(obs())
    const s = await getUsageSummary({ from: NOW - 7 * 86_400_000, to: NOW, includeConnections: false }, NOW)
    expect(s.range.resolution).toBe('hour')
    expect(s.totals.calls).toBe(2)
  })

  it('counts nested calls but not as requests (calls per request)', async () => {
    const { recordCallMetrics } = await import('@/lib/telemetry/metrics')
    const { getUsageSummary } = await import('@/lib/telemetry/summary')
    const parent = obs({ operation: 'book' })
    await recordCallMetrics(parent)
    for (const op of ['searchAvailability', 'createReservation', 'getReservation']) {
      await recordCallMetrics(obs({ operation: op, meta: { ...parent.meta, callId: crypto.randomUUID(), parentCallId: parent.meta.callId } }))
    }
    const s = await getUsageSummary({ from: NOW - 3_600_000, to: NOW, includeConnections: false }, NOW)
    expect(s.totals).toMatchObject({ calls: 4, topLevelCalls: 1, callsPerRequest: 4 })
  })
})

describe('wired into execute()', () => {
  it('a real /api/call is counted with its channel and actor type', async () => {
    await import('@/lib/operations/index')
    const { createSession, newSessionId } = await import('@/lib/auth-tokens')
    const { getUserById, SESSION_COOKIE } = await import('@/lib/auth')
    jar.set(SESSION_COOKIE, createSession(getUserById('u_alice')!, newSessionId()))
    const { POST } = await import('@/app/api/call/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(new Request('http://localhost/api/call', { method: 'POST', body: JSON.stringify({ name: 'getWaitTime', params: {} }), headers: { 'x-navwebmcp-channel': 'webmcp' } }) as any)
    const { getUsageSummary } = await import('@/lib/telemetry')
    const s = await getUsageSummary({ includeConnections: false })
    expect(s.byChannel.webmcp.calls).toBe(1)
    expect(s.byActorType.agent.calls).toBe(1)
  })

  it('an unlabelled in-process call is still counted (as system)', async () => {
    await import('@/lib/operations/index')
    await import('@/lib/telemetry')
    const { execute } = await import('@/lib/operations/execute')
    await execute('getWaitTime', {}, customerCtx)
    const { getUsageSummary } = await import('@/lib/telemetry')
    expect((await getUsageSummary({ includeConnections: false })).byActorType.system.calls).toBe(1)
  })
})

describe('OTLP export', () => {
  it('is off unless OTEL_EXPORTER_OTLP_ENDPOINT is set, and can be switched off per signal', async () => {
    const { otlpEnabled } = await import('@/lib/telemetry/otlp')
    expect(otlpEnabled('traces')).toBe(false)
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.example'
    process.env.OTEL_METRICS_EXPORTER = 'none'
    expect(otlpEnabled('traces')).toBe(true)
    expect(otlpEnabled('metrics')).toBe(false)
    delete process.env.OTEL_METRICS_EXPORTER
  })

  it('a composite becomes one trace with its nested calls as child spans', async () => {
    const { buildTraces } = await import('@/lib/telemetry/otlp')
    const parent = obs({ operation: 'book', actorType: 'agent' })
    const child = obs({ operation: 'createReservation', actorType: 'agent', meta: { ...parent.meta, callId: crypto.randomUUID(), parentCallId: parent.meta.callId } })
    const [p, c] = buildTraces([parent, child]).resourceSpans[0].scopeSpans[0].spans
    expect(p.traceId).toHaveLength(32)
    expect(c.traceId).toBe(p.traceId)
    expect(c.parentSpanId).toBe(p.spanId)
    expect(p.attributes).toEqual(expect.arrayContaining([
      { key: 'navwebmcp.actor.type', value: { stringValue: 'agent' } },
      { key: 'gen_ai.agent.name', value: { stringValue: 'Claude' } },
    ]))
  })

  it('flushes traces and delta metrics in one batch; a collector error is swallowed', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.example/'
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return new Response(null, { status: url.endsWith('metrics') ? 503 : 200 }) }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { enqueueOtlp, flushOtlp, buildMetrics } = await import('@/lib/telemetry/otlp')
    await enqueueOtlp(obs())
    await enqueueOtlp(obs({ actorType: 'agent' }))
    await flushOtlp()
    expect(urls.sort()).toEqual(['https://otel.example/v1/metrics', 'https://otel.example/v1/traces'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()

    const m = buildMetrics([obs(), obs()]).resourceMetrics[0].scopeMetrics[0].metrics
    expect(m[0].sum!.dataPoints[0].asInt).toBe('2')
    expect(m[1].histogram!.dataPoints[0].bucketCounts[2]).toBe('2') // 12ms → (10,25]
  })
})
