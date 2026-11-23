// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { canonicalJson, link, verifyEvents } from '@/lib/audit/chain'
import { redact, REDACTED, MAX_FIELD_BYTES } from '@/lib/audit/redact'
import type { AuditEvent, AuditEventBody } from '@/lib/audit/types'

function body(i: number): AuditEventBody {
  return {
    v: 1, id: `e${i}`, ts: new Date(2026, 0, 1, 0, i).toISOString(), category: 'operation',
    action: 'createReservation', outcome: 'success', channel: 'mcp',
    actor: { type: 'agent', userId: 'u_alice', role: 'customer', assurance: 'verified', agent: { clientId: 'c_1' } },
    input: { partySize: i },
  }
}

function chain(n: number): AuditEvent[] {
  const out: AuditEvent[] = []
  let prev = { seq: 0, hash: '' }
  for (let i = 1; i <= n; i++) {
    const e = link(body(i), prev)
    out.push(e)
    prev = e
  }
  return out
}

describe('canonicalJson', () => {
  it('is independent of key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [1, 'x'] } })).toBe(canonicalJson({ a: { c: [1, 'x'] }, b: 1 }))
  })
})

describe('hash chain', () => {
  it('verifies an intact chain, and survives a JSON round trip (as stored)', () => {
    const events = chain(5).map((e) => JSON.parse(JSON.stringify(e)))
    expect(verifyEvents(events)).toMatchObject({ ok: true, checked: 5, firstSeq: 1, lastSeq: 5 })
  })

  it('detects an edited event', () => {
    const events = chain(5)
    events[2] = { ...events[2], actor: { ...events[2].actor, userId: 'u_bob' } }
    expect(verifyEvents(events)).toMatchObject({ ok: false, brokenAt: { seq: 3, reason: 'hash_mismatch' } })
  })

  it('detects a deleted event', () => {
    const events = chain(5)
    events.splice(2, 1)
    expect(verifyEvents(events)).toMatchObject({ ok: false, brokenAt: { seq: 4, reason: 'seq_gap' } })
  })

  it('detects an edit that also recomputes the hash without the key', () => {
    const events = chain(3)
    // An attacker re-linking event 2 with a plain SHA-256 (no HMAC key) still fails.
    events[1] = { ...events[1], outcome: 'failure', hash: 'f'.repeat(64) }
    expect(verifyEvents(events).ok).toBe(false)
  })

  it('a window starting mid-chain (after retention trim) still verifies', () => {
    expect(verifyEvents(chain(6).slice(3)).ok).toBe(true)
  })
})

describe('redact', () => {
  it('drops secrets entirely and masks personal data, at any depth', () => {
    const out = redact({
      password: 'hunter2', agentToken: 'ab1.x', name: 'Dana',
      guest: { email: 'dana@example.com', phone: '+1 555', notes: 'window seat' },
      cards: [{ cardNumber: '4111111111111111' }],
    }) as Record<string, unknown>
    expect(out).not.toHaveProperty('password')
    expect(out).not.toHaveProperty('agentToken')
    expect(out.name).toBe('Dana')
    expect(out.guest).toEqual({ email: REDACTED, phone: REDACTED, notes: 'window seat' })
    expect(out.cards).toEqual([{ cardNumber: REDACTED }])
  })

  it('masks extra per-operation keys', () => {
    expect(redact({ reason: 'x', amount: 5 }, { keys: ['reason'] })).toEqual({ reason: REDACTED, amount: 5 })
  })

  it('caps oversized payloads', () => {
    const big = { items: Array.from({ length: 40 }, () => 'y'.repeat(400)) }
    expect(redact(big)).toEqual({ truncated: true, bytes: expect.any(Number) })
    expect((redact(big) as { bytes: number }).bytes).toBeGreaterThan(MAX_FIELD_BYTES)
  })
})
