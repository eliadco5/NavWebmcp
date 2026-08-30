// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { adminCtx, supportCtx, customerCtx } from '@/tests/helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let searchAvailability: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createReservation: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cancelReservation: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let listReservations: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getReservation: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let listAllReservations: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cancelAnyReservation: any

/** Get today + N days as YYYY-MM-DD */
function futureDate(daysAhead: number): string {
  const d = new Date()
  d.setDate(d.getDate() + daysAhead)
  return d.toISOString().split('T')[0]
}

/** Return first available slot for a party of 2 within the seeded 7-day window */
async function firstAvailableSlot(partySize = 2, daysAhead = 1) {
  for (let i = daysAhead; i < 7; i++) {
    const date = futureDate(i)
    const r = await searchAvailability.handler({ date, partySize }, customerCtx)
    if (r.success && r.data.slots.length > 0) return r.data.slots[0]
  }
  return null
}

beforeEach(async () => {
  await import('@/lib/operations/index')
  const mods = await Promise.all([
    import('@/lib/operations/searchAvailability'),
    import('@/lib/operations/createReservation'),
    import('@/lib/operations/cancelReservation'),
    import('@/lib/operations/listReservations'),
    import('@/lib/operations/getReservation'),
    import('@/lib/operations/listAllReservations'),
    import('@/lib/operations/cancelAnyReservation'),
  ])
  searchAvailability = mods[0].searchAvailability
  createReservation = mods[1].createReservation
  cancelReservation = mods[2].cancelReservation
  listReservations = mods[3].listReservations
  getReservation = mods[4].getReservation
  listAllReservations = mods[5].listAllReservations
  cancelAnyReservation = mods[6].cancelAnyReservation
})

// ── searchAvailability ────────────────────────────────────────────────────────

describe('searchAvailability', () => {
  it('valid date + partySize returns {slots, count, message}', async () => {
    const date = futureDate(1)
    const result = await searchAvailability.handler({ date, partySize: 2 }, customerCtx)
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty('slots')
    expect(result.data).toHaveProperty('count')
    expect(result.data).toHaveProperty('message')
  })

  // lib/store.ts lazily seeds any requested date on first touch — a far-future
  // date returns real slots now (self-healing across serverless instances is
  // the whole point), so "empty results" has to come from party size instead.
  it('returns slots array (empty when party size exceeds every slot capacity)', async () => {
    const result = await searchAvailability.handler({ date: '2099-12-31', partySize: 2 }, customerCtx)
    expect(result.success).toBe(true)
    expect(Array.isArray(result.data.slots)).toBe(true)
    expect(result.data.slots.length).toBeGreaterThan(0)

    const empty = await searchAvailability.handler({ date: '2099-12-31', partySize: 99 }, customerCtx)
    expect(empty.data.slots.length).toBe(0)
  })

  it('count matches slots.length', async () => {
    const date = futureDate(1)
    const result = await searchAvailability.handler({ date, partySize: 2 }, customerCtx)
    expect(result.data.count).toBe(result.data.slots.length)
  })

  it('message says "No availability" for empty results', async () => {
    const result = await searchAvailability.handler({ date: '2099-12-31', partySize: 99 }, customerCtx)
    expect(result.data.message).toContain('No availability')
  })

  it('message says "N slot(s) available" for non-empty results', async () => {
    const date = futureDate(1)
    const result = await searchAvailability.handler({ date, partySize: 1 }, customerCtx)
    if (result.data.slots.length > 0) {
      expect(result.data.message).toMatch(/slot\(s\) available/i)
    }
  })

  it('partySize 1 returns slots with capacity >= 1', async () => {
    const date = futureDate(1)
    const result = await searchAvailability.handler({ date, partySize: 1 }, customerCtx)
    for (const slot of result.data.slots) {
      expect(slot.capacity).toBeGreaterThanOrEqual(1)
    }
  })

  it('partySize 20 returns fewer or no slots (high capacity requirement)', async () => {
    const date = futureDate(1)
    const r1 = await searchAvailability.handler({ date, partySize: 1 }, customerCtx)
    const r20 = await searchAvailability.handler({ date, partySize: 20 }, customerCtx)
    expect(r20.data.count).toBeLessThanOrEqual(r1.data.count)
  })

  it('only returns available slots', async () => {
    const date = futureDate(1)
    const result = await searchAvailability.handler({ date, partySize: 1 }, customerCtx)
    for (const slot of result.data.slots) {
      expect(slot.available).toBe(true)
    }
  })
})

// ── createReservation ─────────────────────────────────────────────────────────

describe('createReservation', () => {
  it('get valid slotId via searchAvailability, then create returns success with reservation', async () => {
    const slot = await firstAvailableSlot(2)
    expect(slot).not.toBeNull()
    const result = await createReservation.handler({ slotId: slot.id, name: 'Test Guest', partySize: 2 }, customerCtx)
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty('reservation')
  })

  it('non-existent slotId returns NOT_FOUND', async () => {
    const result = await createReservation.handler({ slotId: 'slot_nonexistent', name: 'X', partySize: 1 }, customerCtx)
    expect(result.success).toBe(false)
    expect((result as any).error.code).toBe('NOT_FOUND')
  })

  it('capacity exceeded returns CAPACITY_EXCEEDED', async () => {
    const slot = await firstAvailableSlot(1)
    expect(slot).not.toBeNull()
    const overCapacity = slot.capacity + 1
    const result = await createReservation.handler({ slotId: slot.id, name: 'X', partySize: overCapacity }, customerCtx)
    expect(result.success).toBe(false)
    expect((result as any).error.code).toBe('CAPACITY_EXCEEDED')
  })

  it('second booking of same slot returns SLOT_UNAVAILABLE', async () => {
    const slot = await firstAvailableSlot(2)
    expect(slot).not.toBeNull()
    await createReservation.handler({ slotId: slot.id, name: 'First', partySize: 2 }, customerCtx)
    const result2 = await createReservation.handler({ slotId: slot.id, name: 'Second', partySize: 2 }, adminCtx)
    expect(result2.success).toBe(false)
    expect((result2 as any).error.code).toBe('SLOT_UNAVAILABLE')
  })

  it('created reservation has userId matching ctx.userId', async () => {
    const slot = await firstAvailableSlot(2)
    expect(slot).not.toBeNull()
    const result = await createReservation.handler({ slotId: slot.id, name: 'Alice Test', partySize: 2 }, customerCtx)
    expect(result.data.reservation.userId).toBe(customerCtx.userId)
  })

  it('created reservation has correct date and time matching the slot', async () => {
    const slot = await firstAvailableSlot(2)
    expect(slot).not.toBeNull()
    const result = await createReservation.handler({ slotId: slot.id, name: 'Date Check', partySize: 2 }, customerCtx)
    expect(result.data.reservation.date).toBe(slot.date)
    expect(result.data.reservation.time).toBe(slot.time)
  })

  it('partySize exactly at slot capacity succeeds', async () => {
    const slot = await firstAvailableSlot(1)
    expect(slot).not.toBeNull()
    const result = await createReservation.handler({ slotId: slot.id, name: 'Full House', partySize: slot.capacity }, customerCtx)
    expect(result.success).toBe(true)
  })

  it('different users can both create reservations for different slots', async () => {
    const date = futureDate(1)
    const r = await searchAvailability.handler({ date, partySize: 2 }, customerCtx)
    expect(r.data.slots.length).toBeGreaterThanOrEqual(2)
    const [slot1, slot2] = r.data.slots

    const res1 = await createReservation.handler({ slotId: slot1.id, name: 'Alice', partySize: 2 }, customerCtx)
    const res2 = await createReservation.handler({ slotId: slot2.id, name: 'Bob', partySize: 2 }, adminCtx)
    expect(res1.success).toBe(true)
    expect(res2.success).toBe(true)
  })

  it('booked slot no longer appears in searchAvailability results', async () => {
    const slot = await firstAvailableSlot(2)
    expect(slot).not.toBeNull()
    await createReservation.handler({ slotId: slot.id, name: 'Guest', partySize: 2 }, customerCtx)
    const after = await searchAvailability.handler({ date: slot.date, partySize: 2 }, customerCtx)
    const ids = after.data.slots.map((s: any) => s.id)
    expect(ids).not.toContain(slot.id)
  })

  it('created reservation has id, slotId, name, partySize fields', async () => {
    const slot = await firstAvailableSlot(2)
    const result = await createReservation.handler({ slotId: slot.id, name: 'Fields Check', partySize: 2 }, customerCtx)
    const res = result.data.reservation
    expect(res).toHaveProperty('id')
    expect(res).toHaveProperty('slotId', slot.id)
    expect(res).toHaveProperty('name', 'Fields Check')
    expect(res).toHaveProperty('partySize', 2)
  })
})

// ── cancelReservation ─────────────────────────────────────────────────────────

describe('cancelReservation', () => {
  async function bookSlot(ctx = customerCtx, partySize = 2) {
    const slot = await firstAvailableSlot(partySize)
    if (!slot) throw new Error('No slots available')
    const r = await createReservation.handler({ slotId: slot.id, name: 'Test', partySize }, ctx)
    return { reservation: r.data.reservation, slot }
  }

  it('cancel own reservation with confirm:true returns success', async () => {
    const { reservation } = await bookSlot()
    const result = await cancelReservation.handler({ reservationId: reservation.id, confirm: true }, customerCtx)
    expect(result.success).toBe(true)
    expect(result.data.cancelled).toBe(true)
  })

  it('cancel without confirm (confirm:false) returns CONFIRMATION_REQUIRED', async () => {
    const { reservation } = await bookSlot()
    const result = await cancelReservation.handler({ reservationId: reservation.id, confirm: false }, customerCtx)
    expect(result.success).toBe(false)
    expect((result as any).error.code).toBe('CONFIRMATION_REQUIRED')
  })

  it('cancel non-existent id returns NOT_FOUND', async () => {
    const result = await cancelReservation.handler({ reservationId: 'nonexistent', confirm: true }, customerCtx)
    expect(result.success).toBe(false)
    expect((result as any).error.code).toBe('NOT_FOUND')
  })

  it("cancel another user's reservation returns FORBIDDEN", async () => {
    const { reservation } = await bookSlot(customerCtx)
    const result = await cancelReservation.handler({ reservationId: reservation.id, confirm: true }, adminCtx)
    expect(result.success).toBe(false)
    expect((result as any).error.code).toBe('FORBIDDEN')
  })

  it('after cancel, slot is available again in searchAvailability', async () => {
    const { reservation, slot } = await bookSlot()
    await cancelReservation.handler({ reservationId: reservation.id, confirm: true }, customerCtx)
    const after = await searchAvailability.handler({ date: slot.date, partySize: 2 }, customerCtx)
    const ids = after.data.slots.map((s: any) => s.id)
    expect(ids).toContain(slot.id)
  })

  it('after cancel, listReservations no longer includes it', async () => {
    const { reservation } = await bookSlot()
    await cancelReservation.handler({ reservationId: reservation.id, confirm: true }, customerCtx)
    const list = await listReservations.handler({}, customerCtx)
    const ids = list.data.reservations.map((r: any) => r.id)
    expect(ids).not.toContain(reservation.id)
  })

  it('customer can cancel own reservation', async () => {
    const { reservation } = await bookSlot(customerCtx)
    const result = await cancelReservation.handler({ reservationId: reservation.id, confirm: true }, customerCtx)
    expect(result.success).toBe(true)
  })

  it('support can cancel own reservation', async () => {
    const { reservation } = await bookSlot(supportCtx)
    const result = await cancelReservation.handler({ reservationId: reservation.id, confirm: true }, supportCtx)
    expect(result.success).toBe(true)
  })
})

// ── listReservations ──────────────────────────────────────────────────────────

describe('listReservations', () => {
  it('initially empty for fresh user', async () => {
    const result = await listReservations.handler({}, customerCtx)
    expect(result.success).toBe(true)
    expect(result.data.count).toBe(0)
    expect(result.data.reservations).toHaveLength(0)
  })

  it('after creating reservation, count is 1', async () => {
    const slot = await (async () => {
      const date = futureDate(1)
      const r = await searchAvailability.handler({ date, partySize: 2 }, customerCtx)
      return r.data.slots[0]
    })()
    await createReservation.handler({ slotId: slot.id, name: 'Test', partySize: 2 }, customerCtx)
    const list = await listReservations.handler({}, customerCtx)
    expect(list.data.count).toBe(1)
  })

  it("only returns caller's reservations not other users'", async () => {
    const date = futureDate(1)
    const r = await searchAvailability.handler({ date, partySize: 2 }, customerCtx)
    const slots = r.data.slots
    await createReservation.handler({ slotId: slots[0].id, name: 'Alice', partySize: 2 }, customerCtx)
    await createReservation.handler({ slotId: slots[1].id, name: 'Bob', partySize: 2 }, adminCtx)
    const customerList = await listReservations.handler({}, customerCtx)
    for (const res of customerList.data.reservations) {
      expect(res.userId).toBe(customerCtx.userId)
    }
  })

  it('returns {reservations, count}', async () => {
    const result = await listReservations.handler({}, customerCtx)
    expect(result.data).toHaveProperty('reservations')
    expect(result.data).toHaveProperty('count')
  })

  it('count equals reservations.length', async () => {
    const result = await listReservations.handler({}, customerCtx)
    expect(result.data.count).toBe(result.data.reservations.length)
  })
})

// ── getReservation ────────────────────────────────────────────────────────────

describe('getReservation', () => {
  it('valid id + owner userId returns reservation', async () => {
    const date = futureDate(1)
    const r = await searchAvailability.handler({ date, partySize: 2 }, customerCtx)
    const slot = r.data.slots[0]
    const created = await createReservation.handler({ slotId: slot.id, name: 'Get Test', partySize: 2 }, customerCtx)
    const result = await getReservation.handler({ reservationId: created.data.reservation.id }, customerCtx)
    expect(result.success).toBe(true)
    expect(result.data.reservation.id).toBe(created.data.reservation.id)
  })

  it('valid id + wrong userId returns NOT_FOUND (ownership check)', async () => {
    const date = futureDate(1)
    const r = await searchAvailability.handler({ date, partySize: 2 }, customerCtx)
    const slot = r.data.slots[0]
    const created = await createReservation.handler({ slotId: slot.id, name: 'Ownership Test', partySize: 2 }, customerCtx)
    const result = await getReservation.handler({ reservationId: created.data.reservation.id }, adminCtx)
    expect(result.success).toBe(false)
    expect((result as any).error.code).toBe('NOT_FOUND')
  })

  it('non-existent id returns NOT_FOUND', async () => {
    const result = await getReservation.handler({ reservationId: 'nonexistent' }, customerCtx)
    expect(result.success).toBe(false)
    expect((result as any).error.code).toBe('NOT_FOUND')
  })

  it('returns correct fields: id, name, partySize, date, time', async () => {
    const date = futureDate(1)
    const r = await searchAvailability.handler({ date, partySize: 2 }, customerCtx)
    const slot = r.data.slots[0]
    const created = await createReservation.handler({ slotId: slot.id, name: 'Fields Test', partySize: 2 }, customerCtx)
    const result = await getReservation.handler({ reservationId: created.data.reservation.id }, customerCtx)
    const res = result.data.reservation
    expect(res).toHaveProperty('id')
    expect(res).toHaveProperty('name', 'Fields Test')
    expect(res).toHaveProperty('partySize', 2)
    expect(res).toHaveProperty('date')
    expect(res).toHaveProperty('time')
  })
})

// ── listAllReservations ───────────────────────────────────────────────────────

describe('listAllReservations', () => {
  it('customer role is not in allowed roles — handler should not be called directly but RBAC at invoke level', async () => {
    // Handler itself does no role check; RBAC is in invoke
    // Confirm the operation has correct roles defined
    expect(listAllReservations.roles).not.toContain('customer')
  })

  it('support returns all reservations regardless of owner', async () => {
    const result = await listAllReservations.handler({}, supportCtx)
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty('reservations')
    expect(result.data).toHaveProperty('count')
  })

  it('after two users create reservations, admin sees both', async () => {
    const date = futureDate(1)
    const r = await searchAvailability.handler({ date, partySize: 2 }, customerCtx)
    const slots = r.data.slots
    await createReservation.handler({ slotId: slots[0].id, name: 'Alice', partySize: 2 }, customerCtx)
    await createReservation.handler({ slotId: slots[1].id, name: 'Bob', partySize: 2 }, adminCtx)
    const result = await listAllReservations.handler({}, adminCtx)
    expect(result.data.count).toBeGreaterThanOrEqual(2)
  })
})

// ── cancelAnyReservation ──────────────────────────────────────────────────────

describe('cancelAnyReservation', () => {
  it('operation is restricted to admin role', () => {
    expect(cancelAnyReservation.roles).toEqual(['admin'])
  })

  it('admin can cancel any reservation with confirm:true', async () => {
    const date = futureDate(1)
    const r = await searchAvailability.handler({ date, partySize: 2 }, customerCtx)
    const slot = r.data.slots[0]
    const created = await createReservation.handler({ slotId: slot.id, name: 'Customer Res', partySize: 2 }, customerCtx)
    const result = await cancelAnyReservation.handler({ reservationId: created.data.reservation.id, confirm: true }, adminCtx)
    expect(result.success).toBe(true)
    expect(result.data.cancelled).toBe(true)
  })

  it('without confirm:true returns CONFIRMATION_REQUIRED', async () => {
    const date = futureDate(1)
    const r = await searchAvailability.handler({ date, partySize: 2 }, customerCtx)
    const slot = r.data.slots[0]
    const created = await createReservation.handler({ slotId: slot.id, name: 'Guest', partySize: 2 }, customerCtx)
    const result = await cancelAnyReservation.handler({ reservationId: created.data.reservation.id, confirm: false }, adminCtx)
    expect(result.success).toBe(false)
    expect((result as any).error.code).toBe('CONFIRMATION_REQUIRED')
  })

  it('non-existent id returns NOT_FOUND', async () => {
    const result = await cancelAnyReservation.handler({ reservationId: 'nonexistent_xyz', confirm: true }, adminCtx)
    expect(result.success).toBe(false)
    expect((result as any).error.code).toBe('NOT_FOUND')
  })

  it('after admin cancel, slot becomes available again', async () => {
    const date = futureDate(1)
    const r = await searchAvailability.handler({ date, partySize: 2 }, customerCtx)
    const slot = r.data.slots[0]
    const created = await createReservation.handler({ slotId: slot.id, name: 'Guest', partySize: 2 }, customerCtx)
    await cancelAnyReservation.handler({ reservationId: created.data.reservation.id, confirm: true }, adminCtx)
    const after = await searchAvailability.handler({ date: slot.date, partySize: 2 }, customerCtx)
    const ids = after.data.slots.map((s: any) => s.id)
    expect(ids).toContain(slot.id)
  })

  it('cancelled reservation no longer appears in listAllReservations', async () => {
    const date = futureDate(1)
    const r = await searchAvailability.handler({ date, partySize: 2 }, customerCtx)
    const slot = r.data.slots[0]
    const created = await createReservation.handler({ slotId: slot.id, name: 'Doomed', partySize: 2 }, customerCtx)
    await cancelAnyReservation.handler({ reservationId: created.data.reservation.id, confirm: true }, adminCtx)
    const list = await listAllReservations.handler({}, adminCtx)
    const ids = list.data.reservations.map((res: any) => res.id)
    expect(ids).not.toContain(created.data.reservation.id)
  })
})
