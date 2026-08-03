// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { hostVipGuestOrchestration } from '@/lib/core/hostVipGuest'
import type { HostVipGuestInput } from '@/lib/core/hostVipGuest'

// Simple sequential mock: per-name queue of responses, repeats last when exhausted.
function makeMockCall(responses: Record<string, unknown[]>) {
  const counts: Record<string, number> = {}
  return vi.fn(async (name: string, _params: Record<string, unknown>) => {
    counts[name] = (counts[name] ?? 0) + 1
    const queue = (responses[name] ?? []) as unknown[]
    if (queue.length === 0) return { success: true }
    return queue[Math.min(counts[name] - 1, queue.length - 1)]
  })
}

const PREFERENCES = { guestId: 'g_test_1', dietaryRestrictions: ['nut-allergy'], seatingPreference: 'outdoor', specialNotes: '', updatedAt: '2024-06-03T09:00:00Z' }
const LOYALTY_BEFORE = { guestId: 'g_test_1', tier: 'gold' as const, pointBalance: 1000, lifetimePoints: 9000 }
const LOYALTY_AFTER = { ...LOYALTY_BEFORE, pointBalance: 1100, lifetimePoints: 9100 }
const AVAILABLE_TABLES = { tables: [{ tableId: 't_01', status: 'available' }, { tableId: 't_02', status: 'occupied' }] }
const NO_AVAILABLE_TABLES = { tables: [{ tableId: 't_02', status: 'occupied' }] }

const INPUT: HostVipGuestInput = {
  reservationId: 'res_test_1',
  guestId: 'g_test_1',
  pointsToAward: 100,
  visitNote: 'Anniversary dinner',
}

function happyPathCall() {
  return makeMockCall({
    getGuestPreferences: [{ success: true, data: { preferences: PREFERENCES } }],
    getLoyaltyStatus: [{ success: true, data: { loyalty: LOYALTY_BEFORE } }],
    getOccupancy: [{ success: true, data: AVAILABLE_TABLES }],
    checkInGuest: [{ success: true, data: { tableId: 't_01' } }],
    getCheckinStatus: [{ success: true, data: { status: 'checked-in' } }],
    addLoyaltyPoints: [{ success: true, data: { loyalty: LOYALTY_AFTER, tierUpgrade: false } }],
    logCommunication: [{ success: true, data: { communication: {} } }],
  })
}

describe('hostVipGuestOrchestration', () => {
  it('happy path returns preferences, before/after loyalty, and validated: true', async () => {
    const result = await hostVipGuestOrchestration(INPUT, happyPathCall())
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.preferences).toEqual(PREFERENCES)
      expect(result.data.loyaltyBefore).toEqual(LOYALTY_BEFORE)
      expect(result.data.loyaltyAfter).toEqual(LOYALTY_AFTER)
      expect(result.data.tierUpgrade).toBe(false)
      expect(result.data.validated).toBe(true)
    }
  })

  it('PREFERENCES_ERROR: getGuestPreferences failure propagates error code', async () => {
    const call = makeMockCall({
      getGuestPreferences: [{ success: false, error: { code: 'DB_ERROR', message: 'store error' } }],
    })
    const result = await hostVipGuestOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('DB_ERROR')
  })

  it('LOYALTY_ERROR: getLoyaltyStatus failure propagates error code (NOT_FOUND)', async () => {
    const call = makeMockCall({
      getGuestPreferences: [{ success: true, data: { preferences: PREFERENCES } }],
      getLoyaltyStatus: [{ success: false, error: { code: 'NOT_FOUND', message: 'no loyalty account' } }],
    })
    const result = await hostVipGuestOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('NOT_FOUND')
  })

  it('OCCUPANCY_ERROR: getOccupancy failure propagates error code', async () => {
    const call = makeMockCall({
      getGuestPreferences: [{ success: true, data: { preferences: PREFERENCES } }],
      getLoyaltyStatus: [{ success: true, data: { loyalty: LOYALTY_BEFORE } }],
      getOccupancy: [{ success: false, error: { code: 'DB_ERROR', message: 'store error' } }],
    })
    const result = await hostVipGuestOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('DB_ERROR')
  })

  it('NO_TABLE_AVAILABLE: no table has status "available"', async () => {
    const call = makeMockCall({
      getGuestPreferences: [{ success: true, data: { preferences: PREFERENCES } }],
      getLoyaltyStatus: [{ success: true, data: { loyalty: LOYALTY_BEFORE } }],
      getOccupancy: [{ success: true, data: NO_AVAILABLE_TABLES }],
    })
    const result = await hostVipGuestOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('NO_TABLE_AVAILABLE')
  })

  it('CHECKIN_FAILED: checkInGuest failure propagates error code', async () => {
    const call = makeMockCall({
      getGuestPreferences: [{ success: true, data: { preferences: PREFERENCES } }],
      getLoyaltyStatus: [{ success: true, data: { loyalty: LOYALTY_BEFORE } }],
      getOccupancy: [{ success: true, data: AVAILABLE_TABLES }],
      checkInGuest: [{ success: false, error: { code: 'ALREADY_CHECKED_IN', message: 'already in' } }],
    })
    const result = await hostVipGuestOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('ALREADY_CHECKED_IN')
  })

  it('no checkOutGuest when checkInGuest fails (no seating to roll back)', async () => {
    const call = makeMockCall({
      getGuestPreferences: [{ success: true, data: { preferences: PREFERENCES } }],
      getLoyaltyStatus: [{ success: true, data: { loyalty: LOYALTY_BEFORE } }],
      getOccupancy: [{ success: true, data: AVAILABLE_TABLES }],
      checkInGuest: [{ success: false, error: { code: 'ALREADY_CHECKED_IN', message: 'already in' } }],
    })
    await hostVipGuestOrchestration(INPUT, call)
    expect(call).not.toHaveBeenCalledWith('checkOutGuest', expect.anything())
  })

  it('VALIDATION_FAILED: getCheckinStatus reports non-checked-in status → rollback + error', async () => {
    const call = makeMockCall({
      getGuestPreferences: [{ success: true, data: { preferences: PREFERENCES } }],
      getLoyaltyStatus: [{ success: true, data: { loyalty: LOYALTY_BEFORE } }],
      getOccupancy: [{ success: true, data: AVAILABLE_TABLES }],
      checkInGuest: [{ success: true, data: { tableId: 't_01' } }],
      getCheckinStatus: [{ success: true, data: { status: 'pending' } }],  // inconsistent!
    })
    const result = await hostVipGuestOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('rollback calls checkOutGuest with { reservationId } on validation failure', async () => {
    const call = makeMockCall({
      getGuestPreferences: [{ success: true, data: { preferences: PREFERENCES } }],
      getLoyaltyStatus: [{ success: true, data: { loyalty: LOYALTY_BEFORE } }],
      getOccupancy: [{ success: true, data: AVAILABLE_TABLES }],
      checkInGuest: [{ success: true, data: { tableId: 't_01' } }],
      getCheckinStatus: [{ success: false, data: undefined }],
    })
    await hostVipGuestOrchestration(INPUT, call)
    expect(call).toHaveBeenCalledWith('checkOutGuest', { reservationId: INPUT.reservationId })
  })

  it('no addLoyaltyPoints or logCommunication when validation fails', async () => {
    const call = makeMockCall({
      getGuestPreferences: [{ success: true, data: { preferences: PREFERENCES } }],
      getLoyaltyStatus: [{ success: true, data: { loyalty: LOYALTY_BEFORE } }],
      getOccupancy: [{ success: true, data: AVAILABLE_TABLES }],
      checkInGuest: [{ success: true, data: { tableId: 't_01' } }],
      getCheckinStatus: [{ success: false, data: undefined }],
    })
    await hostVipGuestOrchestration(INPUT, call)
    expect(call).not.toHaveBeenCalledWith('addLoyaltyPoints', expect.anything())
    expect(call).not.toHaveBeenCalledWith('logCommunication', expect.anything())
  })

  it('LOYALTY_AWARD_FAILED: addLoyaltyPoints failure propagates error code', async () => {
    const call = makeMockCall({
      getGuestPreferences: [{ success: true, data: { preferences: PREFERENCES } }],
      getLoyaltyStatus: [{ success: true, data: { loyalty: LOYALTY_BEFORE } }],
      getOccupancy: [{ success: true, data: AVAILABLE_TABLES }],
      checkInGuest: [{ success: true, data: { tableId: 't_01' } }],
      getCheckinStatus: [{ success: true, data: { status: 'checked-in' } }],
      addLoyaltyPoints: [{ success: false, error: { code: 'NOT_FOUND', message: 'no loyalty account' } }],
    })
    const result = await hostVipGuestOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('NOT_FOUND')
  })

  it('LOG_FAILED: logCommunication failure propagates error code', async () => {
    const call = makeMockCall({
      getGuestPreferences: [{ success: true, data: { preferences: PREFERENCES } }],
      getLoyaltyStatus: [{ success: true, data: { loyalty: LOYALTY_BEFORE } }],
      getOccupancy: [{ success: true, data: AVAILABLE_TABLES }],
      checkInGuest: [{ success: true, data: { tableId: 't_01' } }],
      getCheckinStatus: [{ success: true, data: { status: 'checked-in' } }],
      addLoyaltyPoints: [{ success: true, data: { loyalty: LOYALTY_AFTER, tierUpgrade: false } }],
      logCommunication: [{ success: false, error: { code: 'VALIDATION_ERROR', message: 'bad input' } }],
    })
    const result = await hostVipGuestOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('VALIDATION_ERROR')
  })

  it('addLoyaltyPoints is called with guestId, pointsToAward, and visitNote as reason', async () => {
    const call = happyPathCall()
    await hostVipGuestOrchestration(INPUT, call)
    expect(call).toHaveBeenCalledWith('addLoyaltyPoints', {
      guestId: INPUT.guestId,
      points: INPUT.pointsToAward,
      reason: INPUT.visitNote,
    })
  })

  it('logCommunication is called with guestId, type note, and visitNote as body', async () => {
    const call = happyPathCall()
    await hostVipGuestOrchestration(INPUT, call)
    expect(call).toHaveBeenCalledWith('logCommunication', {
      guestId: INPUT.guestId,
      type: 'note',
      subject: 'VIP visit hosted',
      body: INPUT.visitNote,
    })
  })

  it('calls happen in order: preferences, loyalty, occupancy, check-in, status, award, log', async () => {
    const sequence: string[] = []
    const call = vi.fn(async (name: string) => {
      sequence.push(name)
      switch (name) {
        case 'getGuestPreferences': return { success: true, data: { preferences: PREFERENCES } }
        case 'getLoyaltyStatus': return { success: true, data: { loyalty: LOYALTY_BEFORE } }
        case 'getOccupancy': return { success: true, data: AVAILABLE_TABLES }
        case 'checkInGuest': return { success: true, data: { tableId: 't_01' } }
        case 'getCheckinStatus': return { success: true, data: { status: 'checked-in' } }
        case 'addLoyaltyPoints': return { success: true, data: { loyalty: LOYALTY_AFTER, tierUpgrade: false } }
        case 'logCommunication': return { success: true, data: { communication: {} } }
        default: return { success: true }
      }
    })
    await hostVipGuestOrchestration(INPUT, call)
    expect(sequence).toEqual([
      'getGuestPreferences',
      'getLoyaltyStatus',
      'getOccupancy',
      'checkInGuest',
      'getCheckinStatus',
      'addLoyaltyPoints',
      'logCommunication',
    ])
  })
})
