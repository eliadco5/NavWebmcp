// @vitest-environment node
// Dependent batches (NavWebMcp 2.2.0): { "$ref": "<i>.data.<path>" } inside
// invoke({ calls }). Chains, diamonds, failed dependencies, bad and forward refs,
// read/write ordering, nesting, fan-out, and idempotency on resolved args.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { customerCtx, supportCtx } from '@/tests/helpers'

const DATE = '2026-07-07'

async function setup() {
  await import('@/lib/operations/index')
  const exec = await import('@/lib/operations/execute')
  const { store } = await import('@/lib/store')
  return { ...exec, store }
}

beforeAll(async () => {
  await import('@/lib/operations/index')
}, 60_000)

afterEach(() => vi.restoreAllMocks())

const bookingBatch = (name: string, time = '18:00') => [
  { name: 'searchAvailability', args: { date: DATE, partySize: 2, time } },
  { name: 'createReservation', args: { slotId: { $ref: '0.data.slots[0].id' }, name, partySize: 2 } },
  { name: 'getReservation', args: { reservationId: { $ref: '1.data.reservation.id' } } },
]

describe('refs module', () => {
  it('parses indexes, keys and [n] steps, and rejects anything else', async () => {
    const { parseRef } = await import('@/lib/operations/refs')
    expect(parseRef('0.data.slots[0].id')).toEqual({ call: 0, steps: [{ key: 'data' }, { key: 'slots' }, { index: 0 }, { key: 'id' }] })
    expect(parseRef('3')).toEqual({ call: 3, steps: [] })
    for (const bad of ['', 'data.x', '0.', '0..a', '0.slots[?time==1]', '0.slots[*]', '0.a | b', 'x0', '-1.a', 5]) {
      expect(parseRef(bad), String(bad)).toBeNull()
    }
  })

  it('only { $ref } with no other key is a ref', async () => {
    const { isRef, findRefs } = await import('@/lib/operations/refs')
    expect(isRef({ $ref: '0' })).toBe(true)
    expect(isRef({ $ref: '0', x: 1 })).toBe(false)
    expect(findRefs({ a: [{ b: { $ref: '0.data.x' } }], c: 'd' })).toEqual([{ at: ['a', 0, 'b'], raw: '0.data.x' }])
  })
})

describe('searchAvailability time', () => {
  it('narrows to the slot at that time', async () => {
    const { execute } = await setup()
    const r = await execute('searchAvailability', { date: DATE, partySize: 2, time: '18:00' }, customerCtx) as any
    expect(r.success).toBe(true)
    expect(r.data.slots.length).toBe(1)
    expect(r.data.slots[0].time).toBe('18:00')
    const none = await execute('searchAvailability', { date: DATE, partySize: 2, time: '03:00' }, customerCtx) as any
    expect(none.data).toMatchObject({ slots: [], count: 0, message: expect.stringContaining('at 03:00') })
    const bad = await execute('searchAvailability', { date: DATE, partySize: 2, time: '6pm' }, customerCtx) as any
    expect(bad.error.code).toBe('INVALID_INPUT')
  })
})

describe('chains', () => {
  it('the booking flow runs as one batch and books the requested slot', async () => {
    const { execute, store } = await setup()
    const r = await execute('invoke', { calls: bookingBatch('Ref Chain') }, customerCtx) as any
    expect(r.success).toBe(true)
    const [search, create, read] = r.data.results
    expect(search.success && create.success && read.success).toBe(true)
    expect(create.data.reservation.slotId).toBe(search.data.slots[0].id)
    expect(store.getSlot(create.data.reservation.slotId)!.time).toBe('18:00')
    expect(read.data.reservation.id).toBe(create.data.reservation.id)
  })

  it('a ref can sit anywhere inside the args, and the resolved value can be any JSON', async () => {
    const { execute } = await setup()
    const r = await execute('invoke', { calls: [
      { name: 'getContext', args: {} },
      { name: 'searchAvailability', args: { date: { $ref: '0.data.today' }, partySize: 2 } },
    ] }, customerCtx) as any
    expect(r.data.results[1].success).toBe(true)
  })

  it('diamond: two calls use one result, and a third uses both', async () => {
    const { execute } = await setup()
    const r = await execute('invoke', { calls: [
      { name: 'searchAvailability', args: { date: DATE, partySize: 2, time: '12:00' } },
      { name: 'getWaitTime', args: { partySize: { $ref: '0.data.slots[0].capacity' } } },
      { name: 'searchAvailability', args: { date: { $ref: '0.data.slots[0].date' }, partySize: 2 } },
      { name: 'searchAvailability', args: { date: { $ref: '2.data.slots[0].date' }, partySize: 1, time: { $ref: '0.data.slots[0].time' } } },
    ] }, customerCtx) as any
    expect(r.data.results.map((x: any) => x.success)).toEqual([true, true, true, true])
    expect(r.data.results[3].data.slots[0].time).toBe('12:00')
  })
})

describe('failures', () => {
  it('a failed dependency skips the call with DEPENDENCY_FAILED, and so on downstream', async () => {
    const { execute, store } = await setup()
    const before = store.getAllReservations().length
    const r = await execute('invoke', { calls: [
      { name: 'searchAvailability', args: { date: DATE, partySize: 2, time: '18:00' } },
      { name: 'createReservation', args: { slotId: 'slot_missing', name: 'Ref Fail', partySize: 2 } },
      { name: 'getReservation', args: { reservationId: { $ref: '1.data.reservation.id' } } },
      { name: 'getReservation', args: { reservationId: { $ref: '2.data.reservation.id' } } },
    ] }, customerCtx) as any
    const [, create, read, read2] = r.data.results
    expect(create.error.code).toBe('NOT_FOUND')
    expect(read.error).toMatchObject({ code: 'DEPENDENCY_FAILED', retryable: false })
    expect(read.error.message).toMatch(/call 1 failed \(NOT_FOUND\)/)
    expect(read.error.details).toEqual([{ path: 'calls.2.args.reservationId', message: expect.stringContaining('1.data.reservation.id') }])
    expect(read2.error.code).toBe('DEPENDENCY_FAILED')
    expect(store.getAllReservations().length).toBe(before)
  })

  it('a path that does not resolve (empty list, missing key) is DEPENDENCY_FAILED; nothing is written', async () => {
    const { execute, store } = await setup()
    const before = store.getAllReservations().length
    const r = await execute('invoke', { calls: bookingBatch('Ref Empty', '03:00') }, customerCtx) as any
    const [search, create] = r.data.results
    expect(search.data.slots).toEqual([])
    expect(create.error.code).toBe('DEPENDENCY_FAILED')
    expect(create.error.message).toMatch(/slots\[0\].*0 item/)
    const missing = await execute('invoke', { calls: [
      { name: 'getContext', args: {} },
      { name: 'getWaitTime', args: { partySize: { $ref: '0.data.nope' } } },
    ] }, customerCtx) as any
    expect(missing.data.results[1].error.code).toBe('DEPENDENCY_FAILED')
    expect(store.getAllReservations().length).toBe(before)
  })

  it('forward, self and malformed refs are INVALID_INPUT for the whole batch, before anything runs', async () => {
    const { execute, getOpByName } = await setup()
    const spy = vi.spyOn(getOpByName().get('getContext')!, 'handler')
    const r = await execute('invoke', { calls: [
      { name: 'getContext', args: {} },
      { name: 'getWaitTime', args: { partySize: { $ref: '1.data.x' } } },
      { name: 'getWaitTime', args: { partySize: { $ref: '5.data.x' } } },
      { name: 'getWaitTime', args: { partySize: { $ref: '0.data.slots[?x==1]' } } },
    ] }, customerCtx) as any
    expect(r.success).toBe(false)
    expect(r.error.code).toBe('INVALID_INPUT')
    expect(r.error.details.map((d: any) => d.path)).toEqual(['calls.1.args.partySize', 'calls.2.args.partySize', 'calls.3.args.partySize'])
    expect(spy).not.toHaveBeenCalled()
  })

  it('a ref in the single-call form is INVALID_INPUT', async () => {
    const { execute } = await setup()
    const r = await execute('invoke', { name: 'getWaitTime', args: { partySize: { $ref: '0.data.x' } } }, customerCtx) as any
    expect(r.error).toMatchObject({ code: 'INVALID_INPUT', details: [{ path: 'args.partySize' }] })
  })
})

describe('ordering', () => {
  /** Record when each op's handler starts and ends. */
  async function trace(names: string[], delayMs: Record<string, number> = {}) {
    const { getOpByName } = await setup()
    const log: string[] = []
    for (const n of names) {
      const op = getOpByName().get(n)!
      const orig = op.handler
      vi.spyOn(op, 'handler').mockImplementation((async (input: any, ctx: any) => {
        log.push(`start ${n}`)
        await new Promise((r) => setTimeout(r, delayMs[n] ?? 0))
        const out = await orig(input, ctx)
        log.push(`end ${n}`)
        return out
      }) as any)
    }
    return log
  }

  it('without refs, a batch behaves as before: reads first, then writes in order', async () => {
    const log = await trace(['getWaitTime', 'createTask', 'updateTask'], { getWaitTime: 20 })
    const { execute } = await setup()
    await execute('invoke', { calls: [
      { name: 'createTask', args: { title: 'Order A', department: 'Housekeeping', priority: 'low' } },
      { name: 'getWaitTime', args: { partySize: 2 } },
      { name: 'updateTask', args: { taskId: 'task_001', status: 'in_progress' } },
    ] }, supportCtx)
    expect(log).toEqual(['start getWaitTime', 'end getWaitTime', 'start createTask', 'end createTask', 'start updateTask', 'end updateTask'])
  })

  it('with refs: independent reads first, writes in order, and a read after the write it refers to', async () => {
    const log = await trace(['getWaitTime', 'createTask', 'searchTasks', 'updateTask'], { getWaitTime: 20 })
    const { execute } = await setup()
    const r = await execute('invoke', { calls: [
      { name: 'createTask', args: { title: 'Order B', department: 'Housekeeping', priority: 'low' } },
      { name: 'searchTasks', args: { department: { $ref: '0.data.task.department' } } },
      { name: 'getWaitTime', args: { partySize: 2 } },
      { name: 'updateTask', args: { taskId: { $ref: '0.data.task.taskId' }, status: 'in_progress' } },
    ] }, supportCtx) as any
    expect(r.data.results.map((x: any) => x.success)).toEqual([true, true, true, true])
    const at = (e: string) => log.indexOf(e)
    expect(at('end getWaitTime')).toBeLessThan(at('start createTask'))
    expect(at('end createTask')).toBeLessThan(at('start searchTasks'))
    expect(at('end createTask')).toBeLessThan(at('start updateTask'))
    expect(r.data.results[1].data.tasks.some((t: any) => t.taskId === r.data.results[0].data.task.taskId)).toBe(true)
  })

  it('refs inside a nested invoke belong to that inner batch', async () => {
    const { execute } = await setup()
    const r = await execute('invoke', { calls: [
      { name: 'getContext', args: {} },
      { name: 'invoke', args: { calls: [
        { name: 'searchAvailability', args: { date: DATE, partySize: 2, time: '14:00' } },
        { name: 'getWaitTime', args: { partySize: { $ref: '0.data.slots[0].capacity' } } },
      ] } },
    ] }, customerCtx) as any
    const inner = r.data.results[1].data.results
    expect(inner.map((x: any) => x.success)).toEqual([true, true])
  })
})

describe('limits and idempotency', () => {
  it('skipped calls do not count toward fan-out; a 50-call chain runs', async () => {
    const { execute } = await setup()
    const calls = [{ name: 'getContext', args: {} }, ...Array.from({ length: 49 }, (_, i) => (
      { name: 'searchAvailability', args: { date: { $ref: `${i}.data.${i === 0 ? 'today' : 'slots[0].date'}` }, partySize: 1 } }
    ))]
    const r = await execute('invoke', { calls }, customerCtx) as any
    expect(r.data.results.every((x: any) => x.success)).toBe(true)
  })

  it('a keyed write fed by a $ref replays when the batch is retried', async () => {
    const { execute, store } = await setup()
    const calls = bookingBatch('Ref Idem', '20:00')
    ;(calls[1].args as any).idempotencyKey = 'ref-idem'
    const first = await execute('invoke', { calls }, customerCtx) as any
    expect(first.data.results[1].success).toBe(true)
    // The slot is taken now, so the retried search finds nothing at 20:00 …
    const again = await execute('invoke', { calls: [
      { name: 'searchAvailability', args: { date: DATE, partySize: 2 } },
      { name: 'createReservation', args: { slotId: first.data.results[1].data.reservation.slotId, name: 'Ref Idem', partySize: 2, idempotencyKey: 'ref-idem' } },
    ] }, customerCtx) as any
    // … but the keyed create with the same resolved args is a replay, not a second booking.
    expect(again.data.results[1]).toMatchObject({ success: true, idempotency: { replayed: true } })
    expect(store.getAllReservations().filter((x) => x.name === 'Ref Idem' && x.status !== 'cancelled')).toHaveLength(1)
  })
})
