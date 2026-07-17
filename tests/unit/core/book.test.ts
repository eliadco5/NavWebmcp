// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { bookOrchestration } from '@/lib/core/book'
import type { BookInput } from '@/lib/core/book'

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

const SLOT = {
  id: 'slot_test_1',
  date: '2026-08-01',
  time: '18:00',
  capacity: 4,
  available: true,
}

const RESERVATION = {
  id: 'res_test_1',
  slotId: 'slot_test_1',
  name: 'Alice',
  partySize: 2,
  date: '2026-08-01',
  time: '18:00',
  createdAt: '2026-08-01T00:00:00Z',
  userId: 'u_alice',
}

const INPUT: BookInput = { date: '2026-08-01', time: '18:00', partySize: 2, name: 'Alice' }

function happyPathCall() {
  return makeMockCall({
    searchAvailability: [
      { success: true, data: { slots: [SLOT] } },        // step 1: find slot
      { success: true, data: { slots: [] } },             // step 3 recheck: slot gone
    ],
    createReservation: [{ success: true, data: { reservation: RESERVATION } }],
    getReservation:    [{ success: true, data: { reservation: RESERVATION } }],
  })
}

describe('bookOrchestration', () => {
  it('happy path returns { reservation, validated: true }', async () => {
    const result = await bookOrchestration(INPUT, happyPathCall())
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.reservation).toEqual(RESERVATION)
      expect(result.data.validated).toBe(true)
    }
  })

  it('AVAILABILITY_ERROR: searchAvailability failure propagates error code', async () => {
    const call = makeMockCall({
      searchAvailability: [{ success: false, error: { code: 'DB_ERROR', message: 'store error' } }],
    })
    const result = await bookOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('DB_ERROR')
  })

  it('NO_AVAILABILITY: empty slot list', async () => {
    const call = makeMockCall({
      searchAvailability: [{ success: true, data: { slots: [] } }],
    })
    const result = await bookOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('NO_AVAILABILITY')
  })

  it('NO_AVAILABILITY: slots exist but none match requested time', async () => {
    const call = makeMockCall({
      searchAvailability: [{ success: true, data: { slots: [{ ...SLOT, time: '12:00' }] } }],
    })
    const result = await bookOrchestration({ ...INPUT, time: '18:00' }, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('NO_AVAILABILITY')
  })

  it('CREATE_FAILED: createReservation failure propagates error code', async () => {
    const call = makeMockCall({
      searchAvailability: [{ success: true, data: { slots: [SLOT] } }],
      createReservation:  [{ success: false, error: { code: 'SLOT_UNAVAILABLE', message: 'taken' } }],
    })
    const result = await bookOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('SLOT_UNAVAILABLE')
  })

  it('no cancelReservation when createReservation fails (no reservation to roll back)', async () => {
    const call = makeMockCall({
      searchAvailability: [{ success: true, data: { slots: [SLOT] } }],
      createReservation:  [{ success: false, error: { code: 'SLOT_UNAVAILABLE', message: 'taken' } }],
    })
    await bookOrchestration(INPUT, call)
    expect(call).not.toHaveBeenCalledWith('cancelReservation', expect.anything())
  })

  it('VALIDATION_FAILED: slot still open in recheck → rollback + error', async () => {
    const call = makeMockCall({
      searchAvailability: [
        { success: true, data: { slots: [SLOT] } },      // step 1
        { success: true, data: { slots: [SLOT] } },      // step 3 recheck — slot still open!
      ],
      createReservation: [{ success: true, data: { reservation: RESERVATION } }],
      getReservation:    [{ success: true, data: { reservation: RESERVATION } }],
    })
    const result = await bookOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('VALIDATION_FAILED: reservation not found in verify → rollback + error', async () => {
    const call = makeMockCall({
      searchAvailability: [
        { success: true, data: { slots: [SLOT] } },
        { success: true, data: { slots: [] } },          // slot gone ✓
      ],
      createReservation: [{ success: true, data: { reservation: RESERVATION } }],
      getReservation:    [{ success: false, data: undefined }],  // reservation missing!
    })
    const result = await bookOrchestration(INPUT, call)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('rollback calls cancelReservation with { reservationId, confirm: true }', async () => {
    const call = makeMockCall({
      searchAvailability: [
        { success: true, data: { slots: [SLOT] } },
        { success: true, data: { slots: [SLOT] } },      // slot still open → triggers rollback
      ],
      createReservation: [{ success: true, data: { reservation: RESERVATION } }],
      getReservation:    [{ success: true, data: { reservation: RESERVATION } }],
    })
    await bookOrchestration(INPUT, call)
    expect(call).toHaveBeenCalledWith('cancelReservation', {
      reservationId: RESERVATION.id,
      confirm: true,
    })
  })

  it('createReservation is called with slotId from availability result (not from input)', async () => {
    const call = happyPathCall()
    await bookOrchestration(INPUT, call)
    expect(call).toHaveBeenCalledWith('createReservation', {
      slotId: SLOT.id,
      name: INPUT.name,
      partySize: INPUT.partySize,
    })
  })

  it('getReservation is called with reservationId from create result', async () => {
    const call = happyPathCall()
    await bookOrchestration(INPUT, call)
    expect(call).toHaveBeenCalledWith('getReservation', { reservationId: RESERVATION.id })
  })

  it('validate step reuses same date and partySize as initial availability check', async () => {
    const call = happyPathCall()
    await bookOrchestration(INPUT, call)
    const availCalls = call.mock.calls.filter(([name]) => name === 'searchAvailability')
    expect(availCalls).toHaveLength(2)
    expect(availCalls[0][1]).toEqual({ date: INPUT.date, partySize: INPUT.partySize })
    expect(availCalls[1][1]).toEqual({ date: INPUT.date, partySize: INPUT.partySize })
  })

  it('createReservation is not called before searchAvailability resolves', async () => {
    const sequence: string[] = []
    const call = vi.fn(async (name: string, _params: Record<string, unknown>) => {
      sequence.push(name)
      if (name === 'searchAvailability') {
        return sequence.filter((n) => n === 'searchAvailability').length === 1
          ? { success: true, data: { slots: [SLOT] } }
          : { success: true, data: { slots: [] } }
      }
      if (name === 'createReservation') return { success: true, data: { reservation: RESERVATION } }
      if (name === 'getReservation')    return { success: true, data: { reservation: RESERVATION } }
      return { success: true }
    })
    await bookOrchestration(INPUT, call)
    const firstAvail  = sequence.indexOf('searchAvailability')
    const createIdx   = sequence.indexOf('createReservation')
    const getResIdx   = sequence.indexOf('getReservation')
    expect(firstAvail).toBeLessThan(createIdx)
    expect(createIdx).toBeLessThan(getResIdx)
  })
})
