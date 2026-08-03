// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { seatGuestOrchestration } from '@/lib/core/seatGuest'
import type { SeatGuestInput } from '@/lib/core/seatGuest'

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

const AVAILABLE_TABLES = { tables: [{ tableId: 't_01', status: 'available' }, { tableId: 't_02', status: 'occupied' }] }
const NO_AVAILABLE_TABLES = { tables: [{ tableId: 't_02', status: 'occupied' }] }
const TABLES_AFTER_SEAT = { tables: [{ tableId: 't_01', status: 'occupied' }, { tableId: 't_02', status: 'occupied' }] }

const CHECKIN_INFO = {
  reservationId: 'res_test_1',
  tableId: 't_01',
  guestName: 'Alice',
  partySize: 2,
  seatedAt: '2026-08-01T18:00:00Z',
}

const INPUT: SeatGuestInput = { reservationId: 'res_test_1' }

function happyPathCall() {
  return makeMockCall({
    getOccupancy: [
      { success: true, data: AVAILABLE_TABLES },     // step 1: confirm a table is free
      { success: true, data: TABLES_AFTER_SEAT },     // step 3 recheck: table now occupied
    ],
    checkInGuest: [{ success: true, data: CHECKIN_INFO }],
    getCheckinStatus: [{ success: true, data: { status: 'checked-in' } }],
  })
}

describe('seatGuestOrchestration', () => {
  it('happy path returns { checkin, validated: true }', async () => {
    const result = await seatGuestOrchestration(INPUT, happyPathCall())
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.checkin).toEqual(CHECKIN_INFO)
      expect(result.data.validated).toBe(true)
    }
  })

  it('OCCUPANCY_ERROR: getOccupancy failure propagates error code', async () => {
    const call = makeMockCall({
      getOccupancy: [{ success: false, error: { code: 'DB_ERROR', message: 'store error' } }],
    })
    const result = await seatGuestOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('DB_ERROR')
  })

  it('NO_TABLE_AVAILABLE: no table has status "available"', async () => {
    const call = makeMockCall({
      getOccupancy: [{ success: true, data: NO_AVAILABLE_TABLES }],
    })
    const result = await seatGuestOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('NO_TABLE_AVAILABLE')
  })

  it('NO_TABLE_AVAILABLE: requested tableId is not available', async () => {
    const call = makeMockCall({
      getOccupancy: [{ success: true, data: AVAILABLE_TABLES }],
    })
    const result = await seatGuestOrchestration({ ...INPUT, tableId: 't_02' }, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('NO_TABLE_AVAILABLE')
  })

  it('CHECKIN_FAILED: checkInGuest failure propagates error code', async () => {
    const call = makeMockCall({
      getOccupancy: [{ success: true, data: AVAILABLE_TABLES }],
      checkInGuest: [{ success: false, error: { code: 'ALREADY_CHECKED_IN', message: 'already in' } }],
    })
    const result = await seatGuestOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('ALREADY_CHECKED_IN')
  })

  it('no checkOutGuest when checkInGuest fails (no seating to roll back)', async () => {
    const call = makeMockCall({
      getOccupancy: [{ success: true, data: AVAILABLE_TABLES }],
      checkInGuest: [{ success: false, error: { code: 'ALREADY_CHECKED_IN', message: 'already in' } }],
    })
    await seatGuestOrchestration(INPUT, call)
    expect(call).not.toHaveBeenCalledWith('checkOutGuest', expect.anything())
  })

  it('VALIDATION_FAILED: table still not occupied in recheck → rollback + error', async () => {
    const call = makeMockCall({
      getOccupancy: [
        { success: true, data: AVAILABLE_TABLES },
        { success: true, data: AVAILABLE_TABLES },   // recheck: t_01 still "available" — seating didn't stick
      ],
      checkInGuest: [{ success: true, data: CHECKIN_INFO }],
      getCheckinStatus: [{ success: true, data: { status: 'checked-in' } }],
    })
    const result = await seatGuestOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('VALIDATION_FAILED: getCheckinStatus reports non-checked-in status → rollback + error', async () => {
    const call = makeMockCall({
      getOccupancy: [
        { success: true, data: AVAILABLE_TABLES },
        { success: true, data: TABLES_AFTER_SEAT },
      ],
      checkInGuest: [{ success: true, data: CHECKIN_INFO }],
      getCheckinStatus: [{ success: true, data: { status: 'pending' } }],  // inconsistent!
    })
    const result = await seatGuestOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('rollback calls checkOutGuest with { reservationId }', async () => {
    const call = makeMockCall({
      getOccupancy: [
        { success: true, data: AVAILABLE_TABLES },
        { success: true, data: AVAILABLE_TABLES },   // still not occupied → triggers rollback
      ],
      checkInGuest: [{ success: true, data: CHECKIN_INFO }],
      getCheckinStatus: [{ success: true, data: { status: 'checked-in' } }],
    })
    await seatGuestOrchestration(INPUT, call)
    expect(call).toHaveBeenCalledWith('checkOutGuest', { reservationId: INPUT.reservationId })
  })

  it('checkInGuest is called with reservationId and tableId from input', async () => {
    const call = happyPathCall()
    await seatGuestOrchestration({ reservationId: 'res_test_1', tableId: 't_01' }, call)
    expect(call).toHaveBeenCalledWith('checkInGuest', {
      reservationId: 'res_test_1',
      tableId: 't_01',
    })
  })

  it('getCheckinStatus is called with reservationId from input', async () => {
    const call = happyPathCall()
    await seatGuestOrchestration(INPUT, call)
    expect(call).toHaveBeenCalledWith('getCheckinStatus', { reservationId: INPUT.reservationId })
  })

  it('checkInGuest is not called before getOccupancy resolves', async () => {
    const sequence: string[] = []
    const call = vi.fn(async (name: string, _params: Record<string, unknown>) => {
      sequence.push(name)
      if (name === 'getOccupancy') {
        return sequence.filter((n) => n === 'getOccupancy').length === 1
          ? { success: true, data: AVAILABLE_TABLES }
          : { success: true, data: TABLES_AFTER_SEAT }
      }
      if (name === 'checkInGuest') return { success: true, data: CHECKIN_INFO }
      if (name === 'getCheckinStatus') return { success: true, data: { status: 'checked-in' } }
      return { success: true }
    })
    await seatGuestOrchestration(INPUT, call)
    const firstOccupancy = sequence.indexOf('getOccupancy')
    const checkInIdx = sequence.indexOf('checkInGuest')
    const statusIdx = sequence.indexOf('getCheckinStatus')
    expect(firstOccupancy).toBeLessThan(checkInIdx)
    expect(checkInIdx).toBeLessThan(statusIdx)
  })
})
