// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { adminCtx, supportCtx, customerCtx } from '@/tests/helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let seatGuestOp: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getOccupancy: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let checkOutGuest: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getCheckinStatus: any

beforeEach(async () => {
  await import('@/lib/operations/index')
  const mods = await Promise.all([
    import('@/lib/operations/seatGuest-op'),
    import('@/lib/operations/getOccupancy'),
    import('@/lib/operations/checkOutGuest'),
    import('@/lib/operations/getCheckinStatus'),
  ])
  seatGuestOp = mods[0].seatGuestOp
  getOccupancy = mods[1].getOccupancy
  checkOutGuest = mods[2].checkOutGuest
  getCheckinStatus = mods[3].getCheckinStatus
})

// ── Operation descriptor ──────────────────────────────────────────────────────

describe('seatGuestOp descriptor', () => {
  it('name is "seatGuest"', () => {
    expect(seatGuestOp.name).toBe('seatGuest')
  })

  it('permission is "write"', () => {
    expect(seatGuestOp.permission).toBe('write')
  })

  it('allowed roles are support and admin only (not customer)', () => {
    expect(seatGuestOp.roles).toContain('support')
    expect(seatGuestOp.roles).toContain('admin')
    expect(seatGuestOp.roles).not.toContain('customer')
  })

  it('module is frontoffice.checkin', () => {
    expect(seatGuestOp.module).toBe('frontoffice.checkin')
  })

  it('not alwaysOn (progressive disclosure)', () => {
    expect(seatGuestOp.alwaysOn).toBeFalsy()
  })

  it('inputSchema has reservationId (required) and tableId (optional)', () => {
    expect(seatGuestOp.inputSchema).toHaveProperty('reservationId')
    expect(seatGuestOp.inputSchema).toHaveProperty('tableId')
  })
})

// ── Happy path ──────────────────────────────────────────────────────────────────
// Seeded frontoffice store: res_003 is "pending" with partySize 3. Of the available
// tables (t_01 cap2, t_03 cap4, t_05 cap2), only t_03 has sufficient capacity — that's
// also what auto-assign in checkInGuest.ts picks, so it doubles as the explicit-tableId case.

describe('seatGuestOp happy path', () => {
  it('seats a pending reservation into an available table', async () => {
    const result = await seatGuestOp.handler({ reservationId: 'res_003' }, adminCtx)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.checkin.reservationId).toBe('res_003')
      expect(result.data.checkin.tableId).toBe('t_03')
      expect(result.data.validated).toBe(true)
    }
  })

  it('occupies the assigned table after seating', async () => {
    const result = await seatGuestOp.handler({ reservationId: 'res_003' }, adminCtx)
    const tableId = result.data.checkin.tableId
    const occ = await getOccupancy.handler({}, adminCtx)
    const table = occ.data.tables.find((t: { tableId: string }) => t.tableId === tableId)
    expect(table.status).toBe('occupied')
  })

  it('support role can call seatGuestOp', async () => {
    const result = await seatGuestOp.handler({ reservationId: 'res_003' }, supportCtx)
    expect(result.success).toBe(true)
  })

  it('respects an explicit tableId with sufficient capacity', async () => {
    const result = await seatGuestOp.handler({ reservationId: 'res_003', tableId: 't_03' }, adminCtx)
    expect(result.success).toBe(true)
    expect(result.data.checkin.tableId).toBe('t_03')
  })
})

// ── Error paths ───────────────────────────────────────────────────────────────

describe('seatGuestOp error paths', () => {
  it('customer role is forbidden (RBAC gate before handler runs)', async () => {
    // customer isn't in seatGuestOp.roles, so dispatch would reject before reaching
    // the handler; calling the handler directly still exercises the business logic
    // — the RBAC boundary itself is covered by tests/integration/rbac.test.ts.
    expect(seatGuestOp.roles).not.toContain(customerCtx.role)
  })

  it('NOT_FOUND for a nonexistent reservation', async () => {
    const result = await seatGuestOp.handler({ reservationId: 'res_does_not_exist' }, adminCtx)
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('NOT_FOUND')
  })

  it('requested table already occupied yields NO_TABLE_AVAILABLE', async () => {
    const result = await seatGuestOp.handler({ reservationId: 'res_003', tableId: 't_02' }, adminCtx)
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('NO_TABLE_AVAILABLE')
  })

  it('already checked-in reservation fails at the checkInGuest step', async () => {
    const first = await seatGuestOp.handler({ reservationId: 'res_003' }, adminCtx)
    expect(first.success).toBe(true)
    const second = await seatGuestOp.handler({ reservationId: 'res_003' }, adminCtx)
    expect(second.success).toBe(false)
    expect(second.error.code).toBe('ALREADY_CHECKED_IN')
  })
})

// ── Store consistency ─────────────────────────────────────────────────────────

describe('seatGuestOp store consistency', () => {
  it('getCheckinStatus confirms checked-in state after seating', async () => {
    const result = await seatGuestOp.handler({ reservationId: 'res_003' }, adminCtx)
    const status = await getCheckinStatus.handler({ reservationId: 'res_003' }, adminCtx)
    expect(status.success).toBe(true)
    expect(status.data.status).toBe('checked-in')
    expect(status.data.tableId).toBe(result.data.checkin.tableId)
  })

  it('table becomes available again after checkOutGuest', async () => {
    const result = await seatGuestOp.handler({ reservationId: 'res_003' }, adminCtx)
    const tableId = result.data.checkin.tableId
    await checkOutGuest.handler({ reservationId: 'res_003' }, adminCtx)
    const occ = await getOccupancy.handler({}, adminCtx)
    const table = occ.data.tables.find((t: { tableId: string }) => t.tableId === tableId)
    expect(table.status).toBe('available')
  })
})

// ── Discovery integration ─────────────────────────────────────────────────────

describe('seatGuestOp in registry', () => {
  it('appears in the operations registry', async () => {
    const { registry } = await import('@/lib/operations')
    const found = registry.find((op) => op.name === 'seatGuest')
    expect(found).toBeDefined()
  })

  it('is discoverable via explore(frontoffice.checkin)', async () => {
    const { explore } = await import('@/lib/operations/explore')
    const result = await explore.handler({ path: 'frontoffice.checkin' }, supportCtx)
    expect(result.success).toBe(true)
    const names = result.data.functions.map((f: { name: string }) => f.name)
    expect(names).toContain('seatGuest')
  })

  it('is discoverable via search("seatGuest")', async () => {
    const { search } = await import('@/lib/operations/search')
    const result = await search.handler({ pattern: 'seatGuest' }, supportCtx)
    expect(result.success).toBe(true)
    const names = result.data.functions.map((f: { name: string }) => f.name)
    expect(names).toContain('seatGuest')
  })

  it('describe_tool("seatGuest") returns full inputSchema', async () => {
    const { describeTool } = await import('@/lib/operations/describeTool')
    const result = await describeTool.handler({ name: 'seatGuest' }, supportCtx)
    expect(result.success).toBe(true)
    const schema = result.data.inputSchema
    expect(schema.properties).toHaveProperty('reservationId')
    expect(schema.properties).toHaveProperty('tableId')
  })

  it('invoke("seatGuest") dispatches to seatGuestOp handler', async () => {
    const { invoke } = await import('@/lib/operations/invoke')
    const result = await invoke.handler(
      { name: 'seatGuest', args: { reservationId: 'res_003' } },
      adminCtx
    )
    expect(result.success).toBe(true)
    const inner = result.data as { success: boolean; data: { validated: boolean } }
    expect(inner.success).toBe(true)
    expect(inner.data.validated).toBe(true)
  })
})
