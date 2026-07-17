// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { customerCtx, adminCtx, supportCtx } from '@/tests/helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bookOp: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let searchAvailability: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createReservation: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cancelReservation: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getReservation: any

function futureDate(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().split('T')[0]
}

async function firstAvailableSlot(partySize = 2, ctx = customerCtx) {
  for (let i = 1; i < 7; i++) {
    const date = futureDate(i)
    const r = await searchAvailability.handler({ date, partySize }, ctx)
    if (r.success && r.data.slots.length > 0) return { slot: r.data.slots[0], date }
  }
  return null
}

beforeEach(async () => {
  await import('@/lib/operations/index')
  const mods = await Promise.all([
    import('@/lib/operations/book-op'),
    import('@/lib/operations/searchAvailability'),
    import('@/lib/operations/createReservation'),
    import('@/lib/operations/cancelReservation'),
    import('@/lib/operations/getReservation'),
  ])
  bookOp            = mods[0].bookOp
  searchAvailability = mods[1].searchAvailability
  createReservation = mods[2].createReservation
  cancelReservation = mods[3].cancelReservation
  getReservation    = mods[4].getReservation
})

// ── Operation descriptor ──────────────────────────────────────────────────────

describe('bookOp descriptor', () => {
  it('name is "book"', () => {
    expect(bookOp.name).toBe('book')
  })

  it('permission is "write"', () => {
    expect(bookOp.permission).toBe('write')
  })

  it('allowed roles include customer, support, admin', () => {
    expect(bookOp.roles).toContain('customer')
    expect(bookOp.roles).toContain('support')
    expect(bookOp.roles).toContain('admin')
  })

  it('module is reservation.booking', () => {
    expect(bookOp.module).toBe('reservation.booking')
  })

  it('not alwaysOn (progressive disclosure)', () => {
    expect(bookOp.alwaysOn).toBeFalsy()
  })

  it('inputSchema has required date, time, partySize, name fields', () => {
    expect(bookOp.inputSchema).toHaveProperty('date')
    expect(bookOp.inputSchema).toHaveProperty('time')
    expect(bookOp.inputSchema).toHaveProperty('partySize')
    expect(bookOp.inputSchema).toHaveProperty('name')
  })
})

// ── Happy path ────────────────────────────────────────────────────────────────

describe('bookOp happy path', () => {
  it('returns { reservation, validated: true } for a valid booking', async () => {
    const found = await firstAvailableSlot(2)
    expect(found).not.toBeNull()
    const { slot, date } = found!
    const result = await bookOp.handler(
      { date, time: slot.time, partySize: 2, name: 'Alice' },
      customerCtx
    )
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toHaveProperty('reservation')
      expect(result.data.validated).toBe(true)
    }
  })

  it('reservation has correct name, partySize, date, time', async () => {
    const found = await firstAvailableSlot(2)
    const { slot, date } = found!
    const result = await bookOp.handler(
      { date, time: slot.time, partySize: 2, name: 'Test Guest' },
      customerCtx
    )
    expect(result.success).toBe(true)
    const res = result.data.reservation
    expect(res.name).toBe('Test Guest')
    expect(res.partySize).toBe(2)
    expect(res.date).toBe(date)
    expect(res.time).toBe(slot.time)
  })

  it('reservation belongs to the calling userId', async () => {
    const found = await firstAvailableSlot(2)
    const { slot, date } = found!
    const result = await bookOp.handler(
      { date, time: slot.time, partySize: 2, name: 'Alice' },
      customerCtx
    )
    expect(result.data.reservation.userId).toBe(customerCtx.userId)
  })

  it('slot is no longer available after booking', async () => {
    const found = await firstAvailableSlot(2)
    const { slot, date } = found!
    await bookOp.handler({ date, time: slot.time, partySize: 2, name: 'Alice' }, customerCtx)
    const after = await searchAvailability.handler({ date, partySize: 2 }, customerCtx)
    const ids = after.data.slots.map((s: any) => s.id)
    expect(ids).not.toContain(slot.id)
  })

  it('all roles (customer, support, admin) can call bookOp', async () => {
    for (const ctx of [customerCtx, supportCtx, adminCtx]) {
      const found = await firstAvailableSlot(2, ctx)
      expect(found).not.toBeNull()
      const { slot, date } = found!
      const result = await bookOp.handler(
        { date, time: slot.time, partySize: 2, name: `Guest-${ctx.role}` },
        ctx
      )
      expect(result.success).toBe(true)
    }
  })
})

// ── Error paths ───────────────────────────────────────────────────────────────

describe('bookOp error paths', () => {
  it('NO_AVAILABILITY for a date with no slots', async () => {
    const result = await bookOp.handler(
      { date: '2099-12-31', time: '18:00', partySize: 2, name: 'Alice' },
      customerCtx
    )
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('NO_AVAILABILITY')
  })

  it('NO_AVAILABILITY when time does not match any slot', async () => {
    const found = await firstAvailableSlot(2)
    const { date } = found!
    const result = await bookOp.handler(
      { date, time: '03:00', partySize: 2, name: 'Alice' },
      customerCtx
    )
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('NO_AVAILABILITY')
  })

  it('error when slot is already booked by another call before book() runs', async () => {
    const found = await firstAvailableSlot(2)
    const { slot, date } = found!
    // Snipe the slot directly before bookOp runs
    await createReservation.handler({ slotId: slot.id, name: 'Sniper', partySize: 2 }, adminCtx)
    const result = await bookOp.handler(
      { date, time: slot.time, partySize: 2, name: 'Alice' },
      customerCtx
    )
    expect(result.success).toBe(false)
    // Either NO_AVAILABILITY (slot gone from availability list) or SLOT_UNAVAILABLE (create step)
    expect(['NO_AVAILABILITY', 'SLOT_UNAVAILABLE']).toContain(result.error.code)
  })

  it('partySize exceeding slot capacity returns capacity error', async () => {
    const found = await firstAvailableSlot(1)
    const { slot, date } = found!
    const result = await bookOp.handler(
      { date, time: slot.time, partySize: 20, name: 'Crowd' },
      customerCtx
    )
    expect(result.success).toBe(false)
    expect(['NO_AVAILABILITY', 'CAPACITY_EXCEEDED']).toContain(result.error.code)
  })
})

// ── Store consistency ─────────────────────────────────────────────────────────

describe('bookOp store consistency', () => {
  it('getReservation confirms the booking exists in the store', async () => {
    const found = await firstAvailableSlot(2)
    const { slot, date } = found!
    const bookResult = await bookOp.handler(
      { date, time: slot.time, partySize: 2, name: 'Store Check' },
      customerCtx
    )
    const getResult = await getReservation.handler(
      { reservationId: bookResult.data.reservation.id },
      customerCtx
    )
    expect(getResult.success).toBe(true)
    expect(getResult.data.reservation.id).toBe(bookResult.data.reservation.id)
  })

  it('slot can be rebooked after cancellation of bookOp reservation', async () => {
    const found = await firstAvailableSlot(2)
    const { slot, date } = found!
    const bookResult = await bookOp.handler(
      { date, time: slot.time, partySize: 2, name: 'Alice' },
      customerCtx
    )
    expect(bookResult.success).toBe(true)

    // Cancel it
    await cancelReservation.handler(
      { reservationId: bookResult.data.reservation.id, confirm: true },
      customerCtx
    )

    // Slot should be available again for rebooking
    const rebook = await bookOp.handler(
      { date, time: slot.time, partySize: 2, name: 'Bob' },
      adminCtx
    )
    expect(rebook.success).toBe(true)
  })

  it('two concurrent bookOp calls for the same slot: exactly one succeeds', async () => {
    const found = await firstAvailableSlot(2)
    const { slot, date } = found!
    const [r1, r2] = await Promise.all([
      bookOp.handler({ date, time: slot.time, partySize: 2, name: 'Alice' }, customerCtx),
      bookOp.handler({ date, time: slot.time, partySize: 2, name: 'Bob' }, adminCtx),
    ])
    const successes = [r1, r2].filter((r: any) => r.success).length
    expect(successes).toBe(1)
  })
})

// ── Discovery integration ─────────────────────────────────────────────────────

describe('bookOp in registry', () => {
  it('appears in the operations registry', async () => {
    const { registry } = await import('@/lib/operations')
    const found = registry.find((op) => op.name === 'book')
    expect(found).toBeDefined()
  })

  it('is discoverable via explore(reservation.booking)', async () => {
    const { explore } = await import('@/lib/operations/explore')
    const result = await explore.handler({ path: 'reservation.booking' }, customerCtx)
    expect(result.success).toBe(true)
    const names = result.data.functions.map((f: any) => f.name)
    expect(names).toContain('book')
  })

  it('is discoverable via search("book")', async () => {
    const { search } = await import('@/lib/operations/search')
    const result = await search.handler({ pattern: 'book' }, customerCtx)
    expect(result.success).toBe(true)
    const names = result.data.functions.map((f: any) => f.name)
    expect(names).toContain('book')
  })

  it('describe_tool("book") returns full inputSchema', async () => {
    const { describeTool } = await import('@/lib/operations/describeTool')
    const result = await describeTool.handler({ name: 'book' }, customerCtx)
    expect(result.success).toBe(true)
    const schema = result.data.inputSchema
    expect(schema.properties).toHaveProperty('date')
    expect(schema.properties).toHaveProperty('time')
    expect(schema.properties).toHaveProperty('partySize')
    expect(schema.properties).toHaveProperty('name')
  })

  it('invoke("book") dispatches to bookOp handler', async () => {
    const { invoke } = await import('@/lib/operations/invoke')
    const found = await firstAvailableSlot(2)
    const { slot, date } = found!
    const result = await invoke.handler(
      { name: 'book', args: { date, time: slot.time, partySize: 2, name: 'Invoke Alice' } },
      customerCtx
    )
    expect(result.success).toBe(true)
    const inner = result.data as any
    expect(inner.success).toBe(true)
    expect(inner.data.validated).toBe(true)
  })
})
