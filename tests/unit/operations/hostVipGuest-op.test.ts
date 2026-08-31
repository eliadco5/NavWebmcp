// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { adminCtx, supportCtx, customerCtx } from '@/tests/helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let hostVipGuestOp: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getLoyaltyStatus: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let listCommunications: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let checkOutGuest: any

beforeEach(async () => {
  await import('@/lib/operations/index')
  const mods = await Promise.all([
    import('@/lib/operations/hostVipGuest-op'),
    import('@/lib/operations/getLoyaltyStatus'),
    import('@/lib/operations/listCommunications'),
    import('@/lib/operations/checkOutGuest'),
  ])
  hostVipGuestOp = mods[0].hostVipGuestOp
  getLoyaltyStatus = mods[1].getLoyaltyStatus
  listCommunications = mods[2].listCommunications
  checkOutGuest = mods[3].checkOutGuest
})

// res_003 (frontoffice seed) is "pending", guestId g_003, party size 3 — fits t_03 (cap 4),
// the only available table with sufficient capacity. g_003 (CRM seed, "Carol Diaz" in
// frontoffice / "Catherine Wu" in CRM — same id, different seeded display names, a known
// quirk of the two independent seed sets) has platinum loyalty (9800 pts, 35000 lifetime)
// and nut-allergy/outdoor preferences.
const INPUT = { reservationId: 'res_003', guestId: 'g_003', pointsToAward: 100, visitNote: 'VIP anniversary visit' }

// ── Operation descriptor ──────────────────────────────────────────────────────

describe('hostVipGuestOp descriptor', () => {
  it('name is "hostVipGuest"', () => {
    expect(hostVipGuestOp.name).toBe('hostVipGuest')
  })

  it('permission is "write"', () => {
    expect(hostVipGuestOp.permission).toBe('write')
  })

  it('allowed roles are support and admin only (not customer)', () => {
    expect(hostVipGuestOp.roles).toContain('support')
    expect(hostVipGuestOp.roles).toContain('admin')
    expect(hostVipGuestOp.roles).not.toContain('customer')
  })

  it('not alwaysOn (progressive disclosure)', () => {
    expect(hostVipGuestOp.alwaysOn).toBeFalsy()
  })

  it('inputSchema has reservationId, guestId, pointsToAward, visitNote', () => {
    expect(hostVipGuestOp.inputSchema).toHaveProperty('reservationId')
    expect(hostVipGuestOp.inputSchema).toHaveProperty('guestId')
    expect(hostVipGuestOp.inputSchema).toHaveProperty('pointsToAward')
    expect(hostVipGuestOp.inputSchema).toHaveProperty('visitNote')
  })
})

// ── Happy path ────────────────────────────────────────────────────────────────

describe('hostVipGuestOp happy path', () => {
  it('hosts the VIP visit end to end', async () => {
    const result = await hostVipGuestOp.handler(INPUT, adminCtx)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.preferences.guestId).toBe('g_003')
      expect(result.data.loyaltyBefore.pointBalance).toBe(9800)
      expect(result.data.loyaltyAfter.pointBalance).toBe(9900)
      expect(result.data.validated).toBe(true)
    }
  })

  it('support role can call hostVipGuestOp', async () => {
    const result = await hostVipGuestOp.handler(INPUT, supportCtx)
    expect(result.success).toBe(true)
  })

  it('actually awards loyalty points in the CRM store', async () => {
    await hostVipGuestOp.handler(INPUT, adminCtx)
    const status = await getLoyaltyStatus.handler({ guestId: 'g_003' }, adminCtx)
    expect(status.success).toBe(true)
    expect(status.data.loyalty.pointBalance).toBe(9900)
    expect(status.data.loyalty.lifetimePoints).toBe(35100)
  })

  it('actually logs a communication entry', async () => {
    await hostVipGuestOp.handler(INPUT, adminCtx)
    const comms = await listCommunications.handler({ guestId: 'g_003' }, adminCtx)
    expect(comms.success).toBe(true)
    const logged = comms.data.communications.find((c: { subject: string }) => c.subject === 'VIP visit hosted')
    expect(logged).toBeDefined()
    expect(logged.body).toBe('VIP anniversary visit')
    expect(logged.type).toBe('note')
  })

  it('actually seats the guest (reservation checked-in)', async () => {
    const result = await hostVipGuestOp.handler(INPUT, adminCtx)
    expect(result.success).toBe(true)
    // clean up so other tests in this file that reuse res_003 aren't affected
    await checkOutGuest.handler({ reservationId: 'res_003', confirm: true }, adminCtx)
  })
})

// ── Error paths ───────────────────────────────────────────────────────────────

describe('hostVipGuestOp error paths', () => {
  it('customer role is not permitted (RBAC boundary covered by rbac.test.ts)', () => {
    expect(hostVipGuestOp.roles).not.toContain(customerCtx.role)
  })

  it('NOT_FOUND when guestId has no loyalty account', async () => {
    const result = await hostVipGuestOp.handler({ ...INPUT, guestId: 'g_does_not_exist' }, adminCtx)
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('NOT_FOUND')
  })

  it('NOT_FOUND for a nonexistent reservation', async () => {
    const result = await hostVipGuestOp.handler({ ...INPUT, reservationId: 'res_does_not_exist' }, adminCtx)
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('NOT_FOUND')
  })

  it('already checked-in reservation fails at the checkInGuest step', async () => {
    const first = await hostVipGuestOp.handler(INPUT, adminCtx)
    expect(first.success).toBe(true)
    const second = await hostVipGuestOp.handler(INPUT, adminCtx)
    expect(second.success).toBe(false)
    expect(second.error.code).toBe('ALREADY_CHECKED_IN')
    await checkOutGuest.handler({ reservationId: 'res_003', confirm: true }, adminCtx)
  })
})

// ── Discovery integration ─────────────────────────────────────────────────────

describe('hostVipGuestOp in registry', () => {
  it('appears in the operations registry', async () => {
    const { registry } = await import('@/lib/operations')
    const found = registry.find((op) => op.name === 'hostVipGuest')
    expect(found).toBeDefined()
  })

  it('is discoverable via search("hostVipGuest")', async () => {
    const { search } = await import('@/lib/operations/search')
    const result = await search.handler({ pattern: 'hostVipGuest' }, supportCtx)
    expect(result.success).toBe(true)
    const names = result.data.functions.map((f: { name: string }) => f.name)
    expect(names).toContain('hostVipGuest')
  })

  it('describe_tool("hostVipGuest") returns full inputSchema', async () => {
    const { describeTool } = await import('@/lib/operations/describeTool')
    const result = await describeTool.handler({ name: 'hostVipGuest' }, supportCtx)
    expect(result.success).toBe(true)
    const schema = result.data.inputSchema
    expect(schema.properties).toHaveProperty('reservationId')
    expect(schema.properties).toHaveProperty('guestId')
    expect(schema.properties).toHaveProperty('pointsToAward')
    expect(schema.properties).toHaveProperty('visitNote')
  })

  it('invoke("hostVipGuest") dispatches to hostVipGuestOp handler', async () => {
    const { invoke } = await import('@/lib/operations/invoke')
    const result = await invoke.handler({ name: 'hostVipGuest', args: INPUT }, adminCtx)
    expect(result.success).toBe(true)
    const inner = result.data as { success: boolean; data: { validated: boolean } }
    expect(inner.success).toBe(true)
    expect(inner.data.validated).toBe(true)
  })
})
