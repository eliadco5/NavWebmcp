// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { adminCtx, supportCtx, customerCtx } from '@/tests/helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let invoke: any

beforeEach(async () => {
  await import('@/lib/operations/index')
  const mod = await import('@/lib/operations/invoke')
  invoke = mod.invoke
})

/** Run an op via invoke. Protocol ≥ 2.0.0: a single invoke returns the op's own
 *  Result, with no second envelope around it. */
async function run(name: string, args: Record<string, unknown>, ctx: typeof adminCtx) {
  return (await invoke.handler({ name, args }, ctx)) as any
}

// ── Customer restrictions ──────────────────────────────────────────────────────

describe('customer role restrictions', () => {
  it('searchGuests → FORBIDDEN', async () => {
    const inner = await run('searchGuests', { query: 'alice' }, customerCtx)
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })

  it('getGuest → FORBIDDEN', async () => {
    const inner = await run('getGuest', { guestId: 'g_001' }, customerCtx)
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })

  it('createGuest → FORBIDDEN', async () => {
    const inner = await run('createGuest', { name: 'X', email: 'x@x.com', phone: '123' }, customerCtx)
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })

  it('updateGuest → FORBIDDEN', async () => {
    const inner = await run('updateGuest', { guestId: 'g_001', name: 'Y' }, customerCtx)
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })

  it('addLoyaltyPoints → FORBIDDEN', async () => {
    const inner = await run('addLoyaltyPoints', { guestId: 'g_001', points: 10, reason: 'test' }, customerCtx)
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })

  it('listCommunications → FORBIDDEN', async () => {
    const inner = await run('listCommunications', { guestId: 'g_001' }, customerCtx)
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })

  it('logCommunication → FORBIDDEN', async () => {
    const inner = await run('logCommunication', { guestId: 'g_001', type: 'note', subject: 'hi', body: 'hello' }, customerCtx)
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })

  it('checkInGuest → FORBIDDEN', async () => {
    const inner = await run('checkInGuest', { reservationId: 'res_001' }, customerCtx)
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })

  it('getCheckinStatus → FORBIDDEN', async () => {
    const inner = await run('getCheckinStatus', { reservationId: 'res_001' }, customerCtx)
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })

  it('getOccupancy → FORBIDDEN', async () => {
    const inner = await run('getOccupancy', {}, customerCtx)
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })

  it('listAllReservations → FORBIDDEN', async () => {
    const inner = await run('listAllReservations', {}, customerCtx)
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })

  it('getDailyRevenueSummary → FORBIDDEN', async () => {
    const inner = await run('getDailyRevenueSummary', { date: '2026-07-07' }, customerCtx)
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })
})

// ── Customer allowed ops ───────────────────────────────────────────────────────

describe('customer allowed operations', () => {
  it('searchAvailability → NOT FORBIDDEN (success)', async () => {
    const today = new Date()
    today.setDate(today.getDate() + 1)
    const date = today.toISOString().split('T')[0]
    const inner = await run('searchAvailability', { date, partySize: 2 }, customerCtx)
    // Should not be FORBIDDEN — may succeed or return other errors but not auth error
    if (!inner.success) {
      expect(inner.error.code).not.toBe('FORBIDDEN')
    } else {
      expect(inner.success).toBe(true)
    }
  })

  it('getContext → success', async () => {
    const inner = await run('getContext', {}, customerCtx)
    expect(inner.success).toBe(true)
    expect(inner.data.user).toEqual({ id: 'u_alice', displayName: 'Alice' })
  })

  it('getWaitTime → NOT FORBIDDEN', async () => {
    const inner = await run('getWaitTime', { partySize: 2 }, customerCtx)
    if (!inner.success) {
      expect(inner.error.code).not.toBe('FORBIDDEN')
    } else {
      expect(inner.success).toBe(true)
    }
  })

  it('getLoyaltyStatus → NOT FORBIDDEN', async () => {
    const inner = await run('getLoyaltyStatus', { guestId: 'g_001' }, customerCtx)
    // Customer can call this even if guestId lookup may fail — but should not be FORBIDDEN
    if (!inner.success) {
      expect(inner.error.code).not.toBe('FORBIDDEN')
    }
  })

  it('getMyTasks → NOT FORBIDDEN', async () => {
    const inner = await run('getMyTasks', {}, customerCtx)
    if (!inner.success) {
      expect(inner.error.code).not.toBe('FORBIDDEN')
    } else {
      expect(inner.success).toBe(true)
    }
  })
})

// ── Support role restrictions ──────────────────────────────────────────────────

describe('support role restrictions', () => {
  it('getDailyRevenueSummary → FORBIDDEN for support', async () => {
    const inner = await run('getDailyRevenueSummary', { date: '2026-07-07' }, supportCtx)
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })

  it('getWeeklyRevenueSummary → FORBIDDEN for support', async () => {
    const inner = await run('getWeeklyRevenueSummary', { weekStartDate: '2026-07-07' }, supportCtx)
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })

  it('issueRefund → FORBIDDEN for support', async () => {
    const inner = await run('issueRefund', { paymentId: 'pay_001', reason: 'test reason' }, supportCtx)
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })

  it('listInspections → FORBIDDEN for support', async () => {
    const inner = await run('listInspections', {}, supportCtx)
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })

  it('logInspection → FORBIDDEN for support', async () => {
    const inner = await run('logInspection', { tableId: 't_01', inspector: 'me', result: 'pass', notes: 'ok' }, supportCtx)
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })
})

// ── Support allowed ops ────────────────────────────────────────────────────────

describe('support allowed operations', () => {
  it('searchGuests → NOT FORBIDDEN for support', async () => {
    const inner = await run('searchGuests', { query: 'alice' }, supportCtx)
    if (!inner.success) {
      expect(inner.error.code).not.toBe('FORBIDDEN')
    } else {
      expect(inner.success).toBe(true)
    }
  })

  it('listAllReservations → success for support', async () => {
    const inner = await run('listAllReservations', {}, supportCtx)
    expect(inner.success).toBe(true)
  })

  it('checkInGuest → NOT FORBIDDEN for support (may fail for business reasons)', async () => {
    const inner = await run('checkInGuest', { reservationId: 'res_nonexistent_xyz' }, supportCtx)
    if (!inner.success) {
      expect(inner.error.code).not.toBe('FORBIDDEN')
    }
  })
})

// ── Admin allowed ops ─────────────────────────────────────────────────────────

describe('admin role', () => {
  it('getDailyRevenueSummary → NOT FORBIDDEN for admin', async () => {
    const inner = await run('getDailyRevenueSummary', { date: '2026-07-07' }, adminCtx)
    // May succeed or fail for other reasons but never FORBIDDEN
    if (!inner.success) {
      expect(inner.error.code).not.toBe('FORBIDDEN')
    } else {
      expect(inner.success).toBe(true)
    }
  })

  it('listAllReservations → success for admin', async () => {
    const inner = await run('listAllReservations', {}, adminCtx)
    expect(inner.success).toBe(true)
  })

  it('cancelAnyReservation → NOT FORBIDDEN for admin (may fail NOT_FOUND)', async () => {
    const inner = await run('cancelAnyReservation', { reservationId: 'nonexistent', confirm: true }, adminCtx)
    if (!inner.success) {
      expect(inner.error.code).not.toBe('FORBIDDEN')
      expect(inner.error.code).toBe('NOT_FOUND')
    }
  })
})
