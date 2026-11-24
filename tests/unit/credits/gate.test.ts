// @vitest-environment node
// The request gate (lib/credits/gate.ts): a caller can hold only a few places
// in the instance's queue at once, whatever it sends.
import { describe, it, expect, afterEach } from 'vitest'

afterEach(() => {
  delete process.env.CREDITS_MAX_INFLIGHT_AGENT
  delete process.env.CREDITS_ENABLED
})

const hang = () => {
  let release!: () => void
  const p = new Promise<string>((r) => { release = () => r('done') })
  return { p, release }
}

describe('withRequestGate', () => {
  it('admits up to the limit, refuses the rest at once, then admits again', async () => {
    process.env.CREDITS_MAX_INFLIGHT_AGENT = '3'
    const { withRequestGate, gateCount } = await import('@/lib/credits/gate')
    const holds = Array.from({ length: 3 }, hang)
    const running = holds.map((h) => withRequestGate('a:x', 'agent', () => h.p, () => 'refused'))
    expect(gateCount('a:x')).toBe(3)
    expect(await withRequestGate('a:x', 'agent', async () => 'ran', () => 'refused')).toBe('refused')
    // Another caller is unaffected.
    expect(await withRequestGate('a:y', 'agent', async () => 'ran', () => 'refused')).toBe('ran')
    holds.forEach((h) => h.release())
    expect(await Promise.all(running)).toEqual(['done', 'done', 'done'])
    expect(gateCount('a:x')).toBe(0)
    expect(await withRequestGate('a:x', 'agent', async () => 'ran', () => 'refused')).toBe('ran')
  })

  it('a throwing request frees its place', async () => {
    process.env.CREDITS_MAX_INFLIGHT_AGENT = '1'
    const { withRequestGate, gateCount } = await import('@/lib/credits/gate')
    await expect(withRequestGate('a:t', 'agent', async () => { throw new Error('x') }, () => 'refused')).rejects.toThrow('x')
    expect(gateCount('a:t')).toBe(0)
    expect(await withRequestGate('a:t', 'agent', async () => 'ok', () => 'refused')).toBe('ok')
  })

  it('people get a higher limit than agents', async () => {
    const { gateLimit } = await import('@/lib/credits/gate')
    expect(gateLimit('human')).toBeGreaterThan(gateLimit('agent'))
  })

  it('off when credits are disabled', async () => {
    process.env.CREDITS_ENABLED = 'false'
    process.env.CREDITS_MAX_INFLIGHT_AGENT = '1'
    const { withRequestGate } = await import('@/lib/credits/gate')
    const h = hang()
    const first = withRequestGate('a:off', 'agent', () => h.p, () => 'refused')
    expect(await withRequestGate('a:off', 'agent', async () => 'ran', () => 'refused')).toBe('ran')
    h.release()
    await first
  })

  it('withResponseGate holds the place until the streamed body is fully read', async () => {
    process.env.CREDITS_MAX_INFLIGHT_AGENT = '1'
    const { withResponseGate, gateCount } = await import('@/lib/credits/gate')
    let push!: (s: string | null) => void
    const stream = new ReadableStream<Uint8Array>({
      start(c) { push = (s) => (s === null ? c.close() : c.enqueue(new TextEncoder().encode(s))) },
    })
    const res = await withResponseGate('a:s', 'agent', async () => new Response(stream), () => new Response('refused', { status: 429 }))
    // Handler returned, but the body is still streaming: the place is still taken.
    expect(gateCount('a:s')).toBe(1)
    expect((await withResponseGate('a:s', 'agent', async () => new Response('x'), () => new Response('refused', { status: 429 }))).status).toBe(429)
    push('hello'); push(null)
    expect(await res.text()).toBe('hello')
    expect(gateCount('a:s')).toBe(0)
  })

  it('withResponseGate frees the place when the client cancels the body', async () => {
    process.env.CREDITS_MAX_INFLIGHT_AGENT = '1'
    const { withResponseGate, gateCount } = await import('@/lib/credits/gate')
    const res = await withResponseGate('a:c', 'agent', async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}) } })), () => new Response('r', { status: 429 }))
    expect(gateCount('a:c')).toBe(1)
    await res.body!.cancel()
    expect(gateCount('a:c')).toBe(0)
  })

  it('withResponseGate frees the place when the handler throws, and for bodiless responses', async () => {
    const { withResponseGate, gateCount } = await import('@/lib/credits/gate')
    await expect(withResponseGate('a:e', 'agent', async () => { throw new Error('x') }, () => new Response('r'))).rejects.toThrow('x')
    expect(gateCount('a:e')).toBe(0)
    await withResponseGate('a:e', 'agent', async () => new Response(null, { status: 204 }), () => new Response('r'))
    expect(gateCount('a:e')).toBe(0)
  })

  it('pressure follows event-loop lag, and the worse of lag and in-flight wins', async () => {
    const { pressure, setLagForTests, enter, leave } = await import('@/lib/credits/pressure')
    setLagForTests(0)
    expect(pressure()).toBe(0)
    setLagForTests(50)
    expect(pressure()).toBe(0)
    setLagForTests(225)
    expect(pressure()).toBeCloseTo(0.5, 2)
    setLagForTests(10_000)
    expect(pressure()).toBe(1)
    setLagForTests(0)
    for (let i = 0; i < 64; i++) enter()
    expect(pressure()).toBe(1)
    for (let i = 0; i < 64; i++) leave()
    expect(pressure()).toBe(0)
  })

  it('fair share: the noisy caller feels the load, the quiet one barely does', async () => {
    const { noteCall, shareFactor, pressureFor, setLagForTests } = await import('@/lib/credits/pressure')
    const now = 1_700_000_000_000
    for (let i = 0; i < 100; i++) noteCall('a:noisy', now)
    for (let i = 0; i < 3; i++) noteCall('a:quiet', now)
    expect(shareFactor('a:noisy', now)).toBe(1)
    expect(shareFactor('a:quiet', now)).toBeLessThan(0.1)
    setLagForTests(10_000) // fully loaded
    expect(pressureFor('a:noisy', now)).toBe(1)
    expect(pressureFor('a:quiet', now)).toBeLessThan(0.1)
    // Equals share the load equally.
    for (let i = 0; i < 50; i++) { noteCall('a:e1', now); noteCall('a:e2', now) }
    expect(shareFactor('a:e1', now)).toBeCloseTo(shareFactor('a:e2', now), 5)
    // Alone, a caller is the load.
    expect(shareFactor('a:x', now + 60_000)).toBe(1)
    setLagForTests(0)
  })

  it('quickRefusal: refuses frozen and broke callers at the door, lets the rest in', async () => {
    const { quickRefusal, setCreditPolicy } = await import('@/lib/credits')
    const { updateLedger, freshLedger } = await import('@/lib/credits/ledger')
    const { profile } = await import('@/lib/credits/policy')
    expect(await quickRefusal('a:new', 'agent')).toBeNull() // never seen: let in
    await setCreditPolicy('a:frozen', { frozen: true }, 'u_bob')
    expect((await quickRefusal('a:frozen', 'agent'))?.hint).toMatch(/administrator/)
    // Deep in debt: can't recover within the hold time.
    await updateLedger('a:broke', () => ({ next: { ...freshLedger(profile('agent'), Date.now()), balance: -40 }, value: null }))
    const r = await quickRefusal('a:broke', 'agent')
    expect(r?.hint).toMatch(/Refused: out of credits/)
    expect(r?.retryAfterMs).toBeGreaterThan(1500)
    // Slightly short: admit() can hold it, so the door lets it through.
    await updateLedger('a:short', () => ({ next: { ...freshLedger(profile('agent'), Date.now()), balance: 1 }, value: null }))
    expect(await quickRefusal('a:short', 'agent')).toBeNull()
  })

  it('a hostile env value falls back to the default', async () => {
    process.env.CREDITS_MAX_INFLIGHT_AGENT = '-4'
    const { gateLimit } = await import('@/lib/credits/gate')
    expect(gateLimit('agent')).toBe(8)
  })
})
