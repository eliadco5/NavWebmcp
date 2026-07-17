// @vitest-environment node
// End-to-end flows comparing book() orchestration across surfaces
import { describe, it, expect, beforeEach } from 'vitest'
import { customerCtx, adminCtx, supportCtx } from '@/tests/helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bookOp: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let invoke: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let searchAvailability: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createReservation: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getReservation: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cancelReservation: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let listReservations: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bookOrchestration: any

function futureDate(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().split('T')[0]
}

async function pickSlot(partySize = 2, ctx = customerCtx) {
  for (let i = 1; i < 7; i++) {
    const date = futureDate(i)
    const r = await searchAvailability.handler({ date, partySize }, ctx)
    if (r.success && r.data.slots.length > 0)
      return { slot: r.data.slots[0], date }
  }
  return null
}

async function pickTwoSlots(partySize = 2) {
  for (let i = 1; i < 7; i++) {
    const date = futureDate(i)
    const r = await searchAvailability.handler({ date, partySize }, customerCtx)
    if (r.success && r.data.slots.length >= 2)
      return [
        { slot: r.data.slots[0], date },
        { slot: r.data.slots[1], date },
      ]
  }
  return null
}

beforeEach(async () => {
  await import('@/lib/operations/index')
  const mods = await Promise.all([
    import('@/lib/operations/book-op'),
    import('@/lib/operations/invoke'),
    import('@/lib/operations/searchAvailability'),
    import('@/lib/operations/createReservation'),
    import('@/lib/operations/getReservation'),
    import('@/lib/operations/cancelReservation'),
    import('@/lib/operations/listReservations'),
    import('@/lib/core/book'),
  ])
  bookOp             = mods[0].bookOp
  invoke             = mods[1].invoke
  searchAvailability = mods[2].searchAvailability
  createReservation  = mods[3].createReservation
  getReservation     = mods[4].getReservation
  cancelReservation  = mods[5].cancelReservation
  listReservations   = mods[6].listReservations
  bookOrchestration  = mods[7].bookOrchestration
})

// ── Flow A: bookOp (MCP server-side) vs 3-call manual ────────────────────────
// Both approaches must produce the same logical outcome on the same store.

describe('Flow A — bookOp vs 3-call equivalence', () => {
  it('bookOp and 3-call produce validated reservations with the same fields', async () => {
    const slots = await pickTwoSlots(2)
    expect(slots).not.toBeNull()
    const [s1, s2] = slots!

    // bookOp (1-call)
    const bookResult = await bookOp.handler(
      { date: s1.date, time: s1.slot.time, partySize: 2, name: 'BookOp Guest' },
      customerCtx
    )
    expect(bookResult.success).toBe(true)

    // 3-call manual
    const avail = await searchAvailability.handler({ date: s2.date, partySize: 2 }, adminCtx)
    const slot = avail.data.slots.find((sl: any) => sl.id === s2.slot.id)
    const createResult = await createReservation.handler(
      { slotId: slot.id, name: 'ThreeCall Guest', partySize: 2 },
      adminCtx
    )
    const getResult = await getReservation.handler(
      { reservationId: createResult.data.reservation.id },
      adminCtx
    )

    // Both reservations must have the expected structure
    for (const res of [bookResult.data.reservation, getResult.data.reservation]) {
      expect(res).toHaveProperty('id')
      expect(res).toHaveProperty('slotId')
      expect(res).toHaveProperty('name')
      expect(res).toHaveProperty('partySize', 2)
      expect(res).toHaveProperty('date')
      expect(res).toHaveProperty('time')
    }
  })

  it('bookOp and 3-call both consume their respective slots', async () => {
    const slots = await pickTwoSlots(2)
    expect(slots).not.toBeNull()
    const [s1, s2] = slots!

    await bookOp.handler(
      { date: s1.date, time: s1.slot.time, partySize: 2, name: 'BookOp' },
      customerCtx
    )
    await createReservation.handler({ slotId: s2.slot.id, name: 'ThreeCall', partySize: 2 }, adminCtx)

    const after = await searchAvailability.handler({ date: s1.date, partySize: 2 }, customerCtx)
    const ids = after.data.slots.map((s: any) => s.id)
    expect(ids).not.toContain(s1.slot.id)
    expect(ids).not.toContain(s2.slot.id)
  })

  it('bookOp result has validated:true, 3-call has no such field (demonstrates the value)', async () => {
    const slots = await pickTwoSlots(2)
    expect(slots).not.toBeNull()
    const [s1, s2] = slots!

    const bookResult = await bookOp.handler(
      { date: s1.date, time: s1.slot.time, partySize: 2, name: 'BookOp' },
      customerCtx
    )
    const createResult = await createReservation.handler(
      { slotId: s2.slot.id, name: 'ThreeCall', partySize: 2 },
      adminCtx
    )

    // bookOp tells the agent the booking was validated — 3-call does not
    expect(bookResult.data.validated).toBe(true)
    expect(createResult.data).not.toHaveProperty('validated')
  })
})

// ── Flow B: bookOrchestration core with in-process dispatcher ────────────────

describe('Flow B — bookOrchestration shares logic with bookOp', () => {
  it('bookOrchestration with makeDispatch(ctx) produces the same result as bookOp.handler', async () => {
    const { makeDispatch } = await import('@/lib/operations/dispatch')
    const slots = await pickTwoSlots(2)
    expect(slots).not.toBeNull()
    const [s1, s2] = slots!

    const [orchestrationResult, opResult] = await Promise.all([
      bookOrchestration(
        { date: s1.date, time: s1.slot.time, partySize: 2, name: 'OrchestratedAlice' },
        makeDispatch(customerCtx)
      ),
      bookOp.handler(
        { date: s2.date, time: s2.slot.time, partySize: 2, name: 'OpBob' },
        adminCtx
      ),
    ])

    expect(orchestrationResult.success).toBe(true)
    expect(opResult.success).toBe(true)
    expect(orchestrationResult.data.validated).toBe(true)
    expect(opResult.data.validated).toBe(true)
  })
})

// ── Flow C: invoke dispatch path ──────────────────────────────────────────────

describe('Flow C — invoke("book") dispatch', () => {
  it('invoke("book") returns a validated booking', async () => {
    const found = await pickSlot(2)
    expect(found).not.toBeNull()
    const { slot, date } = found!

    const result = await invoke.handler(
      { name: 'book', args: { date, time: slot.time, partySize: 2, name: 'InvokeAlice' } },
      customerCtx
    )
    expect(result.success).toBe(true)
    const inner = result.data as any
    expect(inner.success).toBe(true)
    expect(inner.data.validated).toBe(true)
  })

  it('invoke("book") and invoke("createReservation") both consume slots independently', async () => {
    const slots = await pickTwoSlots(2)
    expect(slots).not.toBeNull()
    const [s1, s2] = slots!

    const [bookRes, createRes] = await Promise.all([
      invoke.handler(
        { name: 'book', args: { date: s1.date, time: s1.slot.time, partySize: 2, name: 'A' } },
        customerCtx
      ),
      invoke.handler(
        { name: 'createReservation', args: { slotId: s2.slot.id, name: 'B', partySize: 2 } },
        adminCtx
      ),
    ])

    expect(bookRes.success).toBe(true)
    expect(createRes.success).toBe(true)

    const after = await searchAvailability.handler({ date: s1.date, partySize: 2 }, customerCtx)
    const ids = after.data.slots.map((s: any) => s.id)
    expect(ids).not.toContain(s1.slot.id)
    expect(ids).not.toContain(s2.slot.id)
  })

  it('invoke("book") RBAC — customer is allowed', async () => {
    const found = await pickSlot(2, customerCtx)
    const { slot, date } = found!
    const result = await invoke.handler(
      { name: 'book', args: { date, time: slot.time, partySize: 2, name: 'Customer' } },
      customerCtx
    )
    const inner = result.data as any
    expect(inner.success).toBe(true)
  })

  it('invoke("book") with bad date format returns INVALID_ARGS', async () => {
    const result = await invoke.handler(
      { name: 'book', args: { date: 'not-a-date', time: '18:00', partySize: 2, name: 'Alice' } },
      customerCtx
    )
    expect(result.success).toBe(true)  // invoke itself succeeds
    const inner = result.data as any
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('INVALID_ARGS')
  })

  it('invoke("book") with partySize 0 returns INVALID_ARGS', async () => {
    const found = await pickSlot(1)
    const { date, slot } = found!
    const result = await invoke.handler(
      { name: 'book', args: { date, time: slot.time, partySize: 0, name: 'Alice' } },
      customerCtx
    )
    const inner = result.data as any
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('INVALID_ARGS')
  })
})

// ── Flow D: cross-surface parity ──────────────────────────────────────────────

describe('Flow D — same store, same result regardless of call path', () => {
  it('booking via bookOp is visible via getReservation', async () => {
    const found = await pickSlot(2)
    const { slot, date } = found!
    const bookResult = await bookOp.handler(
      { date, time: slot.time, partySize: 2, name: 'Visible' },
      customerCtx
    )
    const getResult = await getReservation.handler(
      { reservationId: bookResult.data.reservation.id },
      customerCtx
    )
    expect(getResult.success).toBe(true)
    expect(getResult.data.reservation.name).toBe('Visible')
  })

  it('booking via bookOp appears in listReservations', async () => {
    const found = await pickSlot(2)
    const { slot, date } = found!
    const bookResult = await bookOp.handler(
      { date, time: slot.time, partySize: 2, name: 'Listed' },
      customerCtx
    )
    const listResult = await listReservations.handler({}, customerCtx)
    const ids = listResult.data.reservations.map((r: any) => r.id)
    expect(ids).toContain(bookResult.data.reservation.id)
  })

  it('booking via 3-call is indistinguishable from bookOp in listReservations', async () => {
    const slots = await pickTwoSlots(2)
    expect(slots).not.toBeNull()
    const [s1, s2] = slots!

    // Book via bookOp
    const bookResult = await bookOp.handler(
      { date: s1.date, time: s1.slot.time, partySize: 2, name: 'ViaBook' },
      customerCtx
    )
    // Book via 3-call
    const createResult = await createReservation.handler(
      { slotId: s2.slot.id, name: 'ViaCreate', partySize: 2 },
      customerCtx
    )

    const list = await listReservations.handler({}, customerCtx)
    const ids = list.data.reservations.map((r: any) => r.id)
    expect(ids).toContain(bookResult.data.reservation.id)
    expect(ids).toContain(createResult.data.reservation.id)
  })

  it('cancelling a bookOp reservation restores availability for all call paths', async () => {
    const found = await pickSlot(2)
    const { slot, date } = found!

    const bookResult = await bookOp.handler(
      { date, time: slot.time, partySize: 2, name: 'ToCancel' },
      customerCtx
    )
    await cancelReservation.handler(
      { reservationId: bookResult.data.reservation.id, confirm: true },
      customerCtx
    )

    // Slot available again — can be booked via any path
    const rebook = await invoke.handler(
      { name: 'book', args: { date, time: slot.time, partySize: 2, name: 'Rebook' } },
      adminCtx
    )
    const inner = rebook.data as any
    expect(inner.success).toBe(true)
  })
})

// ── Flow E: multi-user isolation ──────────────────────────────────────────────

describe('Flow E — multi-user isolation', () => {
  it('each user sees only their own reservations regardless of booking path', async () => {
    const slots = await pickTwoSlots(2)
    expect(slots).not.toBeNull()
    const [s1, s2] = slots!

    await bookOp.handler(
      { date: s1.date, time: s1.slot.time, partySize: 2, name: 'Alice' },
      customerCtx
    )
    await invoke.handler(
      { name: 'book', args: { date: s2.date, time: s2.slot.time, partySize: 2, name: 'Admin' } },
      adminCtx
    )

    const customerList = await listReservations.handler({}, customerCtx)
    const adminList    = await listReservations.handler({}, adminCtx)

    for (const r of customerList.data.reservations) {
      expect(r.userId).toBe(customerCtx.userId)
    }
    for (const r of adminList.data.reservations) {
      expect(r.userId).toBe(adminCtx.userId)
    }
  })
})
