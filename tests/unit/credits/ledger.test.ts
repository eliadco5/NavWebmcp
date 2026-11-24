// @vitest-environment node
// The credit arithmetic (lib/credits/ledger.ts, policy.ts): pure functions, so
// the Redis and in-process paths can't disagree.
import { describe, it, expect } from 'vitest'
import { freshLedger, refill, reserve, settle, effectiveProfile, updateLedger, listLedgers } from '@/lib/credits/ledger'
import { chargeFor, extraFor, profile, principalOf, REQUEST_COST } from '@/lib/credits/policy'

const p = profile('agent')
const T0 = 1_000_000

describe('profiles and principals', () => {
  it('agents are strict, people loose, system exempt', () => {
    expect(profile('agent').maxWindow).toBeLessThan(profile('human').maxWindow)
    expect(profile('human').timeRate).toBe(0)
    expect(principalOf({ type: 'system', userId: 'u', role: 'admin', assurance: 'asserted' })).toBeNull()
    expect(principalOf({ type: 'agent', userId: 'u_bob', role: 'admin', assurance: 'verified', agent: { clientId: 'c1' } })).toEqual({ key: 'a:c1', profile: 'agent' })
    expect(principalOf({ type: 'human', userId: 'u_bob', role: 'admin', assurance: 'asserted' })).toEqual({ key: 'h:u_bob', profile: 'human' })
  })

  it('env overrides a profile field', () => {
    process.env.CREDITS_AGENT_MAX_WINDOW = '99'
    try {
      expect(profile('agent').maxWindow).toBe(99)
    } finally {
      delete process.env.CREDITS_AGENT_MAX_WINDOW
    }
  })
})

describe('chargeFor', () => {
  const ops: Record<string, { permission: 'read' | 'write'; credits?: { weight: number }; dispatchesOps?: boolean }> = {
    getGuest: { permission: 'read' },
    createTask: { permission: 'write' },
    book: { permission: 'write', credits: { weight: 4 } },
    invoke: { permission: 'read', dispatchesOps: true },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lookup = (n: string) => ops[n] as any

  it('read 1, write 2, declared weights, plus the per-request cost', () => {
    expect(chargeFor(lookup('getGuest'), {}, lookup, p).charge).toBe(REQUEST_COST + 1)
    expect(chargeFor(lookup('createTask'), {}, lookup, p).charge).toBe(REQUEST_COST + 2)
    expect(chargeFor(lookup('book'), {}, lookup, p).charge).toBe(REQUEST_COST + 4)
    expect(chargeFor(undefined, {}, lookup, p).charge).toBe(REQUEST_COST + 1)
  })

  it('a batch costs the sum of what it runs, but pays the request cost once', () => {
    const calls = [{ name: 'getGuest' }, { name: 'getGuest' }, { name: 'book' }]
    const batch = chargeFor(lookup('invoke'), { calls }, lookup, p)
    expect(batch.charge).toBe(REQUEST_COST + 1 + 1 + 4)
    // 3 dispatched + book's own 4
    expect(batch.estimatedOps).toBe(7)
    const separately = calls.reduce((s, c) => s + chargeFor(lookup(c.name), {}, lookup, p).charge, 0)
    expect(batch.charge).toBeLessThan(separately)
  })

  it('large arguments cost more', () => {
    const big = { note: 'x'.repeat(p.sizeUnit * 3) }
    expect(chargeFor(lookup('getGuest'), big, lookup, p).charge).toBe(REQUEST_COST + 1 + 3)
  })

  it('extra cost: response size, full seconds of run time, undeclared nested ops', () => {
    expect(extraFor({ durationMs: 40, responseBytes: 200, nestedOps: 0 }, 0, 1, p).extra).toBe(0)
    expect(extraFor({ durationMs: 4200, responseBytes: 0, nestedOps: 0 }, 0, 1, p).timeCost).toBe(4)
    expect(extraFor({ durationMs: 0, responseBytes: p.sizeUnit * 2, nestedOps: 0 }, 0, 1, p).sizeCost).toBe(2)
    expect(extraFor({ durationMs: 0, responseBytes: 0, nestedOps: 9 }, 4, 4, p).opsCost).toBe(5)
    // People aren't charged for time.
    expect(extraFor({ durationMs: 9000, responseBytes: 0, nestedOps: 0 }, 0, 1, profile('human')).timeCost).toBe(0)
  })
})

describe('reserve / settle', () => {
  it('a quick, small call costs nothing net: the grant returns the charge', () => {
    const l = freshLedger(p, T0)
    const r = reserve(l, 2, p, T0)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ledger.balance).toBe(p.initialWindow - 2)
    expect(r.ledger.outstanding).toBe(2)
    const s = settle(r.ledger, { reserved: 2, extra: 0, durationMs: 20, pressure: 0 }, p, T0)
    expect(s.granted).toBe(2)
    expect(s.ledger.outstanding).toBe(0)
    expect(s.ledger.balance).toBe(p.initialWindow)
  })

  it('caps how many credits can be outstanding at once (the window)', () => {
    let l = freshLedger(p, T0)
    let admitted = 0
    for (let i = 0; i < 100; i++) {
      const r = reserve(l, 2, p, T0)
      if (!r.ok) break
      l = r.ledger
      admitted++
    }
    expect(admitted).toBe(p.initialWindow / 2)
    const refused = reserve(l, 2, p, T0)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.waitMs).toBe(Math.ceil((2 / p.refillPerSec) * 1000))
  })

  it('a long call puts the caller in debt and halves its window', () => {
    const r = reserve(freshLedger(p, T0), 2, p, T0)
    if (!r.ok) throw new Error('should admit')
    const s = settle(r.ledger, { reserved: 2, extra: 20, durationMs: 8000, pressure: 0 }, p, T0)
    expect(s.shrunk).toBe(true)
    expect(s.ledger.window).toBe(p.initialWindow / 2)
    // Debt is paid back by the grant first; with this much debt it stays negative.
    expect(s.ledger.balance).toBeLessThan(p.initialWindow)
    expect(s.ledger.spent).toBe(22)
  })

  it('quick calls under low load grow the window, up to the max', () => {
    let l = freshLedger(p, T0)
    for (let i = 0; i < 200; i++) {
      const r = reserve(l, 2, p, T0)
      if (!r.ok) throw new Error('should admit')
      l = settle(r.ledger, { reserved: 2, extra: 0, durationMs: 5, pressure: 0 }, p, T0).ledger
    }
    expect(l.window).toBe(p.maxWindow)
  })

  it('server load scales the grant down', () => {
    const r = reserve(freshLedger(p, T0), 4, p, T0)
    if (!r.ok) throw new Error('should admit')
    expect(settle(r.ledger, { reserved: 4, extra: 0, durationMs: 5, pressure: 0.5 }, p, T0).granted).toBe(2)
    expect(settle(r.ledger, { reserved: 4, extra: 0, durationMs: 5, pressure: 1 }, p, T0).granted).toBe(0)
  })

  it('CreditRequest asks for more than the charge, within the window', () => {
    let l = freshLedger(p, T0)
    const a = reserve(l, 8, p, T0)
    if (!a.ok) throw new Error('should admit')
    l = a.ledger
    const s = settle(l, { reserved: 8, extra: 0, durationMs: 5, creditRequest: 100, pressure: 0 }, p, T0)
    // Window grew by one; the grant fills it and no further.
    expect(s.ledger.balance + s.ledger.outstanding).toBe(s.ledger.window)
  })

  it('the trickle refill recovers a caller over time, never past the window', () => {
    const debt = { ...freshLedger(p, T0), balance: -10 }
    expect(refill(debt, p, T0 + 5000).balance).toBe(-10 + 5 * p.refillPerSec)
    expect(refill(debt, p, T0 + 3_600_000).balance).toBe(p.initialWindow)
  })

  it('frozen refuses and counts it', () => {
    const r = reserve(freshLedger(p, T0), 2, p, T0, true)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('frozen')
      expect(r.ledger.refused).toBe(1)
    }
  })

  it('a charge bigger than the window is admitted against the whole window', () => {
    const r = reserve(freshLedger(p, T0), 500, p, T0)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.reserved).toBe(p.initialWindow)
  })

  it('an admin override caps the window', () => {
    const capped = effectiveProfile(p, { maxWindow: 4 })
    expect(refill(freshLedger(p, T0), capped, T0).window).toBe(4)
  })
})

describe('storage (in-process fallback, no REDIS_URL)', () => {
  it('updateLedger persists and listLedgers sees it', async () => {
    await updateLedger('a:test', (cur) => ({ next: { ...(cur ?? freshLedger(p, T0)), calls: 7 }, value: null }))
    const rows = await listLedgers()
    expect(rows.find((r) => r.principal === 'a:test')?.ledger?.calls).toBe(7)
  })
})
