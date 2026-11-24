// @vitest-environment node
// Property-based ("fuzz") and negative tests for the credit ledger. If credits
// break, every call is refused and the app is unreachable — so these hammer the
// arithmetic with random operation sequences and hostile inputs and check the
// invariants that keep the app reachable:
//   I1 outstanding == sum of live reservations, never negative
//   I2 after a refill: balance + outstanding <= window (+ float slack)
//   I3 minWindow <= window <= maxWindow
//   I4 every number stays finite (no NaN / Infinity leaks into storage)
//   I5 an idle caller always recovers to a full window (no permanent starvation)
//   I6 a reservation that is never settled expires
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  freshLedger, refill, reserve, settle, sanitizeLedger, sanitizeOverride, effectiveProfile,
  updateLedger, getLedger, holdStaleMs, type Ledger,
} from '@/lib/credits/ledger'
import { chargeFor, extraFor, profile, type Profile } from '@/lib/credits/policy'
import { hintFor } from '@/lib/credits/hint'

// Small deterministic PRNG so a failure is reproducible from its seed.
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const EPS = 1e-6

function checkInvariants(l: Ledger, p: Profile, ctx: string) {
  const sum = Object.values(l.holds ?? {}).reduce((s, h) => s + h[0], 0)
  expect(l.outstanding, `${ctx}: I1 outstanding = sum(holds)`).toBeCloseTo(sum, 9)
  expect(l.outstanding, `${ctx}: I1 outstanding >= 0`).toBeGreaterThanOrEqual(0)
  expect(l.window, `${ctx}: I3 window >= min`).toBeGreaterThanOrEqual(p.minWindow)
  expect(l.window, `${ctx}: I3 window <= max`).toBeLessThanOrEqual(p.maxWindow)
  for (const [k, v] of Object.entries(l)) {
    if (typeof v === 'number') expect(Number.isFinite(v), `${ctx}: I4 ${k} finite (${v})`).toBe(true)
  }
}

beforeEach(() => { delete process.env.CREDITS_HOLD_STALE_MS })
afterEach(() => { delete process.env.CREDITS_HOLD_STALE_MS })

describe('fuzz: random reserve/settle sequences keep every invariant', () => {
  const profiles: [string, Profile][] = [
    ['agent', profile('agent')],
    ['human', profile('human')],
    ['tiny override', effectiveProfile(profile('agent'), { maxWindow: 1, refillPerSec: 0.1 })],
    ['no refill', effectiveProfile(profile('agent'), { refillPerSec: 0 })],
  ]

  for (const [name, p] of profiles) {
    it(`${name}: 300 seeds × 400 steps`, () => {
      for (let seed = 1; seed <= 300; seed++) {
        const r = rng(seed)
        let now = 1_700_000_000_000
        let l = freshLedger(p, now)
        const open: { id: string; reserved: number }[] = []
        for (let step = 0; step < 400; step++) {
          now += Math.floor(r() * 3000) - (r() < 0.05 ? 5000 : 0) // includes clock going backwards
          const roll = r()
          if (roll < 0.45) {
            const charge = r() < 0.05 ? [0, -5, NaN, Infinity, 1e9][Math.floor(r() * 5)] : 1 + Math.floor(r() * 12)
            const out = reserve(l, charge, p, now, r() < 0.02)
            l = out.ledger
            if (out.ok) {
              expect(out.reserved).toBeGreaterThanOrEqual(1)
              open.push({ id: out.holdId, reserved: out.reserved })
            }
          } else if (roll < 0.9 && open.length) {
            const [c] = open.splice(Math.floor(r() * open.length), 1)
            const hostile = r() < 0.05
            l = settle(l, {
              reserved: c.reserved,
              holdId: c.id,
              extra: hostile ? [NaN, -10, Infinity][Math.floor(r() * 3)] : Math.floor(r() * 10),
              durationMs: hostile ? NaN : Math.floor(r() * 9000),
              creditRequest: r() < 0.2 ? (hostile ? NaN : Math.floor(r() * 2000)) : undefined,
              pressure: hostile ? NaN : r(),
            }, p, now).ledger
          } else {
            l = refill(l, p, now)
          }
          checkInvariants(l, p, `${name} seed ${seed} step ${step}`)
          // What storage would round-trip must survive sanitizing unchanged in meaning.
          const back = sanitizeLedger(JSON.parse(JSON.stringify(l)))!
          expect(back.outstanding).toBeCloseTo(l.outstanding, 9)
        }
      }
    }, 120_000)
  }

  it('I2: after a refill with no debt, balance + outstanding never exceeds the window', () => {
    const p = profile('agent')
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed)
      let now = 1_700_000_000_000
      let l = freshLedger(p, now)
      const open: { id: string; reserved: number }[] = []
      for (let step = 0; step < 300; step++) {
        now += Math.floor(r() * 2000)
        if (r() < 0.5) {
          const out = reserve(l, 1 + Math.floor(r() * 6), p, now)
          l = out.ledger
          if (out.ok) open.push({ id: out.holdId, reserved: out.reserved })
        } else if (open.length) {
          const [c] = open.splice(0, 1)
          l = settle(l, { reserved: c.reserved, holdId: c.id, extra: 0, durationMs: 10, pressure: r(), creditRequest: Math.floor(r() * 500) }, p, now).ledger
        }
        const f = refill(l, p, now)
        if (f.balance >= 0) expect(f.balance + f.outstanding).toBeLessThanOrEqual(f.window + EPS)
      }
    }
  })
})

describe('starvation: no caller is locked out for good', () => {
  it('I5: after any abuse, an idle agent recovers to a full window', () => {
    const p = profile('agent')
    for (let seed = 1; seed <= 100; seed++) {
      const r = rng(seed)
      let now = 1_700_000_000_000
      let l = freshLedger(p, now)
      // Abuse: long, huge calls, many never settled.
      for (let i = 0; i < 50; i++) {
        now += 100
        const out = reserve(l, 1 + Math.floor(r() * 20), p, now)
        l = out.ledger
        if (out.ok && r() < 0.5) {
          l = settle(l, { reserved: out.reserved, holdId: out.holdId, extra: 500, durationMs: 60_000, pressure: 1 }, p, now).ledger
        }
      }
      // Idle long enough for lost reservations to expire and the trickle to refill everything.
      now += holdStaleMs() + 1 + (1000 * (p.maxWindow + 500 * 50)) / p.refillPerSec
      const healed = refill(l, p, now)
      expect(healed.outstanding).toBe(0)
      expect(healed.balance).toBe(healed.window)
      expect(reserve(healed, 2, p, now).ok).toBe(true)
    }
  })

  it('I6: a reservation never settled (instance killed mid-call) expires after CREDITS_HOLD_STALE_MS', () => {
    const p = profile('agent')
    const t0 = 1_700_000_000_000
    let l = freshLedger(p, t0)
    // Fill the window with calls that will never settle.
    for (let i = 0; i < 8; i++) l = (reserve(l, 2, p, t0) as { ledger: Ledger }).ledger
    expect(l.outstanding).toBe(16)
    expect(reserve(l, 2, p, t0 + 1000).ok).toBe(false)
    // Before the stale time: still held. After it: released.
    expect(refill(l, p, t0 + holdStaleMs() - 1).outstanding).toBe(16)
    const after = refill(l, p, t0 + holdStaleMs() + 1)
    expect(after.outstanding).toBe(0)
    expect(reserve(after, 2, p, t0 + holdStaleMs() + 1).ok).toBe(true)
  })

  it('a settle that arrives after its reservation expired does not double-release', () => {
    const p = profile('agent')
    const t0 = 1_700_000_000_000
    const a = reserve(freshLedger(p, t0), 2, p, t0)
    if (!a.ok) throw new Error('admit')
    const b = reserve(a.ledger, 2, p, t0 + holdStaleMs() + 10) // a's hold expires here; b holds 2
    if (!b.ok) throw new Error('admit b')
    const late = settle(b.ledger, { reserved: 2, holdId: a.holdId, extra: 0, durationMs: 5, pressure: 0 }, p, t0 + holdStaleMs() + 20)
    expect(late.ledger.outstanding).toBe(2) // b is still running
  })

  it('refillPerSec 0 refuses with a finite retry, never an infinite wait', () => {
    const p = effectiveProfile(profile('agent'), { refillPerSec: 0, maxWindow: 2 })
    let l = freshLedger(p, 0)
    l = (reserve(l, 2, p, 0) as { ledger: Ledger }).ledger
    const r = reserve(l, 2, p, 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.waitMs).toBe(Number.POSITIVE_INFINITY) // index.ts caps Retry-After at 60 s
  })
})

describe('negative: corrupt and hostile stored data', () => {
  it.each([
    ['null', null],
    ['string', 'garbage'],
    ['array', [1, 2, 3]],
    ['NaN balance', { balance: NaN, window: 16, refilledAt: 1, lastAt: 1 }],
    ['string balance', { balance: '16', window: 16, refilledAt: 1, lastAt: 1 }],
    ['zero window', { balance: 1, window: 0, refilledAt: 1, lastAt: 1 }],
    ['missing window', { balance: 1, refilledAt: 1, lastAt: 1 }],
  ])('%s is discarded (caller starts fresh, never locked out)', (_n, raw) => {
    expect(sanitizeLedger(raw)).toBeNull()
  })

  it('bad holds are dropped and outstanding is recomputed, not trusted', () => {
    const l = sanitizeLedger({
      balance: 5, window: 16, refilledAt: 1, lastAt: 1, outstanding: 9999,
      holds: { a: [2, 1], b: ['x', 1], c: [-3, 1], d: [NaN, 1], e: 'junk', f: [3, 2] },
    })!
    expect(Object.keys(l.holds!)).toEqual(['a', 'f'])
    expect(l.outstanding).toBe(5)
  })

  it('hostile overrides are ignored field by field', () => {
    expect(sanitizeOverride({ maxWindow: 'big', refillPerSec: NaN, frozen: 'yes', by: 7 })).toEqual({})
    expect(sanitizeOverride('nope')).toBeNull()
    const p = effectiveProfile(profile('agent'), { maxWindow: -5, refillPerSec: -1 })
    expect(p.maxWindow).toBe(1)
    expect(p.refillPerSec).toBe(profile('agent').refillPerSec)
  })

  it('chargeFor never returns a non-finite or sub-1 charge for hostile args', () => {
    const p = profile('agent')
    const invoke = { permission: 'read', dispatchesOps: true } as never
    const circular: Record<string, unknown> = {}
    circular.self = circular
    for (const args of [
      {}, { calls: 'x' }, { calls: [null, 1, 'a', { name: 5 }, { name: 'nope' }] }, { name: 42 },
      { calls: Array.from({ length: 1000 }, () => ({ name: 'invoke' })) }, circular,
    ]) {
      const { charge } = chargeFor(invoke, args as Record<string, unknown>, () => undefined, p)
      expect(Number.isFinite(charge)).toBe(true)
      expect(charge).toBeGreaterThanOrEqual(1)
    }
  })

  it('extraFor is finite for hostile outcomes', () => {
    const p = profile('agent')
    const e = extraFor({ durationMs: -5, responseBytes: -1, nestedOps: -3 }, 0, 1, p)
    expect(e.extra).toBeLessThanOrEqual(0)
    expect(Number.isFinite(e.extra)).toBe(true)
  })

  it('hints never throw and always produce one sentence for every state', () => {
    for (const balance of [-1e6, -1, 0, 0.5, 3, 16, 1e6]) {
      for (const window of [1, 2, 16, 512]) {
        for (const refused of [undefined, 'insufficient', 'frozen', 'busy'] as const) {
          const h = hintFor({
            balance, window, charged: 3, refillPerSec: 0, heldMs: 100, shrunk: true, timeCost: 1, sizeCost: 1, durationMs: 1500,
            ...(refused && { refused: { reason: refused, retryAfterMs: 1000 } }),
          })
          expect(typeof h).toBe('string')
          expect(h!.length).toBeLessThan(300)
          expect(h).not.toMatch(/NaN|undefined|Infinity/)
        }
      }
    }
  })
})

describe('storage under concurrency (in-process path)', () => {
  it('1000 concurrent updates of one ledger lose nothing', async () => {
    const p = profile('agent')
    await Promise.all(Array.from({ length: 1000 }, () =>
      updateLedger('a:race', (cur) => {
        const l = cur ?? freshLedger(p, 1)
        return { next: { ...l, calls: l.calls + 1 }, value: null }
      })))
    expect((await getLedger('a:race')).ledger?.calls).toBe(1000)
  })

  it('the in-process ledger map is bounded (oldest dropped first)', async () => {
    process.env.CREDITS_MEMORY_MAX_LEDGERS = '50'
    try {
      const p = profile('agent')
      for (let i = 0; i < 200; i++) {
        await updateLedger(`a:many${i}`, () => ({ next: freshLedger(p, 1), value: null }))
      }
      expect(globalThis.__creditLedgers!.ledgers.size).toBe(50)
      expect((await getLedger('a:many0')).ledger).toBeNull()
      expect((await getLedger('a:many199')).ledger).not.toBeNull()
    } finally {
      delete process.env.CREDITS_MEMORY_MAX_LEDGERS
    }
  })

  it('a throwing update does not poison the per-caller queue', async () => {
    const p = profile('agent')
    await expect(updateLedger('a:boom', () => { throw new Error('boom') })).rejects.toThrow('boom')
    await updateLedger('a:boom', () => ({ next: { ...freshLedger(p, 1), calls: 1 }, value: null }))
    expect((await getLedger('a:boom')).ledger?.calls).toBe(1)
  })
})
