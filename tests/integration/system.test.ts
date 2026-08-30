// @vitest-environment node
// End-to-end flows testing multiple operations together
import { describe, it, expect, beforeEach } from 'vitest'
import { adminCtx, supportCtx, customerCtx } from '@/tests/helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let explore: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let search: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let describeTool: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let invoke: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loadTools: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let unloadTools: any
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
let getLoaded: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let issueToken: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let verifyCredentials: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let userForToken: any

/** Today + N days as YYYY-MM-DD */
function futureDate(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().split('T')[0]
}

/** Pick first available slot for partySize within next 7 days */
async function pickSlot(partySize = 2) {
  for (let i = 1; i < 7; i++) {
    const date = futureDate(i)
    const r = await searchAvailability.handler({ date, partySize }, customerCtx)
    if (r.success && r.data.slots.length > 0) return r.data.slots[0]
  }
  return null
}

/** Pick two distinct slots on the same date */
async function pickTwoSlots(partySize = 2): Promise<[any, any] | null> {
  for (let i = 1; i < 7; i++) {
    const date = futureDate(i)
    const r = await searchAvailability.handler({ date, partySize }, customerCtx)
    if (r.success && r.data.slots.length >= 2) return [r.data.slots[0], r.data.slots[1]]
  }
  return null
}

beforeEach(async () => {
  await import('@/lib/operations/index')
  const mods = await Promise.all([
    import('@/lib/operations/explore'),
    import('@/lib/operations/search'),
    import('@/lib/operations/describeTool'),
    import('@/lib/operations/invoke'),
    import('@/lib/operations/loadTools'),
    import('@/lib/operations/unloadTools'),
    import('@/lib/operations/searchAvailability'),
    import('@/lib/operations/createReservation'),
    import('@/lib/operations/cancelReservation'),
    import('@/lib/operations/listReservations'),
    import('@/lib/operations/getReservation'),
    import('@/lib/loadedTools'),
    import('@/lib/auth'),
    import('@/lib/auth-tokens'),
  ])
  explore = mods[0].explore
  search = mods[1].search
  describeTool = mods[2].describeTool
  invoke = mods[3].invoke
  loadTools = mods[4].loadTools
  unloadTools = mods[5].unloadTools
  searchAvailability = mods[6].searchAvailability
  createReservation = mods[7].createReservation
  cancelReservation = mods[8].cancelReservation
  listReservations = mods[9].listReservations
  getReservation = mods[10].getReservation
  getLoaded = mods[11].getLoaded
  verifyCredentials = mods[12].verifyCredentials
  issueToken = mods[13].issueToken
  userForToken = mods[13].userForToken
})

// ── Flow 1: Full booking flow ─────────────────────────────────────────────────

describe('Flow 1 — Full booking flow', () => {
  it('1. explore() sees reservation module', async () => {
    const result = await explore.handler({}, customerCtx)
    expect(result.success).toBe(true)
    const modulePaths = result.data.modules.map((m: any) => m.path)
    expect(modulePaths).toContain('reservation')
  })

  it('2. searchAvailability returns available slots', async () => {
    const date = futureDate(1)
    const result = await searchAvailability.handler({ date, partySize: 2 }, customerCtx)
    expect(result.success).toBe(true)
    expect(result.data.slots.length).toBeGreaterThan(0)
  })

  it('3. createReservation with slotId creates reservation', async () => {
    const slot = await pickSlot(2)
    expect(slot).not.toBeNull()
    const result = await createReservation.handler({ slotId: slot.id, name: 'Flow Test', partySize: 2 }, customerCtx)
    expect(result.success).toBe(true)
    expect(result.data.reservation).toBeDefined()
  })

  it('4. getReservation returns same data as created', async () => {
    const slot = await pickSlot(2)
    const created = await createReservation.handler({ slotId: slot.id, name: 'Flow Test 4', partySize: 2 }, customerCtx)
    const fetched = await getReservation.handler({ reservationId: created.data.reservation.id }, customerCtx)
    expect(fetched.success).toBe(true)
    expect(fetched.data.reservation.id).toBe(created.data.reservation.id)
    expect(fetched.data.reservation.name).toBe('Flow Test 4')
  })

  it('5. listReservations includes the new reservation', async () => {
    const slot = await pickSlot(2)
    const created = await createReservation.handler({ slotId: slot.id, name: 'Flow Test 5', partySize: 2 }, customerCtx)
    const list = await listReservations.handler({}, customerCtx)
    const ids = list.data.reservations.map((r: any) => r.id)
    expect(ids).toContain(created.data.reservation.id)
  })

  it('6. cancelReservation with confirm:true cancels it', async () => {
    const slot = await pickSlot(2)
    const created = await createReservation.handler({ slotId: slot.id, name: 'Flow Test 6', partySize: 2 }, customerCtx)
    const cancelled = await cancelReservation.handler({ reservationId: created.data.reservation.id, confirm: true }, customerCtx)
    expect(cancelled.success).toBe(true)
    expect(cancelled.data.cancelled).toBe(true)
  })

  it('7. searchAvailability after cancel — slot is available again', async () => {
    const date = futureDate(1)
    const before = await searchAvailability.handler({ date, partySize: 2 }, customerCtx)
    const slot = before.data.slots[0]
    const created = await createReservation.handler({ slotId: slot.id, name: 'Flow 7', partySize: 2 }, customerCtx)
    await cancelReservation.handler({ reservationId: created.data.reservation.id, confirm: true }, customerCtx)
    const after = await searchAvailability.handler({ date, partySize: 2 }, customerCtx)
    expect(after.data.count).toBe(before.data.count)
  })

  it('8. listReservations is empty after cancel', async () => {
    const slot = await pickSlot(2)
    const created = await createReservation.handler({ slotId: slot.id, name: 'Flow 8', partySize: 2 }, customerCtx)
    await cancelReservation.handler({ reservationId: created.data.reservation.id, confirm: true }, customerCtx)
    const list = await listReservations.handler({}, customerCtx)
    expect(list.data.count).toBe(0)
  })
})

// ── Flow 2: Concurrent booking ────────────────────────────────────────────────

describe('Flow 2 — Concurrent booking', () => {
  it('two concurrent createReservation for same slot: exactly one succeeds', async () => {
    const slot = await pickSlot(2)
    expect(slot).not.toBeNull()
    const [r1, r2] = await Promise.all([
      createReservation.handler({ slotId: slot.id, name: 'Alice', partySize: 2 }, customerCtx),
      createReservation.handler({ slotId: slot.id, name: 'Bob', partySize: 2 }, adminCtx),
    ])
    const successes = [r1, r2].filter((r) => r.success).length
    expect(successes).toBe(1)
  })

  it('the failing concurrent booking returns SLOT_UNAVAILABLE', async () => {
    const slot = await pickSlot(2)
    const [r1, r2] = await Promise.all([
      createReservation.handler({ slotId: slot.id, name: 'Alice', partySize: 2 }, customerCtx),
      createReservation.handler({ slotId: slot.id, name: 'Bob', partySize: 2 }, adminCtx),
    ])
    const failure = [r1, r2].find((r) => !r.success)
    expect(failure).toBeDefined()
    expect(failure.error.code).toBe('SLOT_UNAVAILABLE')
  })

  it('only one reservation exists for the slot after concurrent attempt', async () => {
    const slot = await pickSlot(2)
    await Promise.all([
      createReservation.handler({ slotId: slot.id, name: 'Alice', partySize: 2 }, customerCtx),
      createReservation.handler({ slotId: slot.id, name: 'Bob', partySize: 2 }, adminCtx),
    ])
    // The slot should now be unavailable
    const after = await searchAvailability.handler({ date: slot.date, partySize: 2 }, customerCtx)
    const ids = after.data.slots.map((s: any) => s.id)
    expect(ids).not.toContain(slot.id)
  })
})

// ── Flow 3: Progressive discovery via search ──────────────────────────────────

describe('Flow 3 — Progressive discovery via search', () => {
  it('1. search("reservation") returns reservation functions', async () => {
    const result = await search.handler({ pattern: 'reservation' }, customerCtx)
    expect(result.success).toBe(true)
    expect(result.data.functions.length).toBeGreaterThan(0)
    const names = result.data.functions.map((f: any) => f.name)
    expect(names.some((n: string) => n.toLowerCase().includes('reservation') || n.toLowerCase().includes('availability'))).toBe(true)
  })

  it('2. describe_tool on discovered function name returns inputSchema', async () => {
    const searchResult = await search.handler({ pattern: 'reservation' }, customerCtx)
    const fn = searchResult.data.functions[0]
    expect(fn).toBeDefined()
    const desc = await describeTool.handler({ name: fn.name }, customerCtx)
    expect(desc.success).toBe(true)
    expect(desc.data.inputSchema).toBeDefined()
  })

  it('3. invoke searchAvailability discovered via search succeeds', async () => {
    // Discover via search
    const searchResult = await search.handler({ pattern: 'searchAvailability' }, customerCtx)
    const fn = searchResult.data.functions.find((f: any) => f.name === 'searchAvailability')
    expect(fn).toBeDefined()

    // Get schema
    const desc = await describeTool.handler({ name: fn.name }, customerCtx)
    expect(desc.data.inputSchema.properties).toHaveProperty('date')
    expect(desc.data.inputSchema.properties).toHaveProperty('partySize')

    // Invoke with discovered params
    const date = futureDate(1)
    const result = await invoke.handler({ name: fn.name, args: { date, partySize: 2 } }, customerCtx)
    expect(result.success).toBe(true)
    const inner = result.data as any
    expect(inner.success).toBe(true)
  })
})

// ── Flow 4: load_tools session ────────────────────────────────────────────────

describe('Flow 4 — load_tools session', () => {
  it('1. load_tools with two names succeeds', async () => {
    const result = await loadTools.handler({ names: ['searchAvailability', 'createReservation'] }, adminCtx)
    expect(result.success).toBe(true)
    const statuses = result.data.results.map((r: any) => r.status)
    expect(statuses.every((s: string) => s === 'LOADED')).toBe(true)
  })

  it('2. getLoaded contains both names after load_tools', async () => {
    await loadTools.handler({ names: ['searchAvailability', 'createReservation'] }, adminCtx)
    const loaded = getLoaded(adminCtx.token)
    expect(loaded.has('searchAvailability')).toBe(true)
    expect(loaded.has('createReservation')).toBe(true)
  })

  it('3. after unload_tools searchAvailability, only createReservation remains', async () => {
    await loadTools.handler({ names: ['searchAvailability', 'createReservation'] }, adminCtx)
    await unloadTools.handler({ names: ['searchAvailability'] }, adminCtx)
    const loaded = getLoaded(adminCtx.token)
    expect(loaded.has('searchAvailability')).toBe(false)
    expect(loaded.has('createReservation')).toBe(true)
  })
})

// ── Flow 5: Role upgrade ──────────────────────────────────────────────────────
//
// There is no updateUserRole anymore — mutating a module-level USERS constant
// in place cannot work once state has to survive across serverless instances.
// /api/switch-role instead re-signs the caller's own session/token with a new
// role baked into the payload (see lib/auth-tokens.ts). A consequence worth
// testing explicitly: because tokens are stateless snapshots, not references
// to a mutable user record, a token issued BEFORE a role change keeps carrying
// its original role for its own lifetime — there is no server-side revocation.

describe('Flow 5 — Role upgrade (re-mint, not mutate)', () => {
  it('1. issue token for alice (customer) — token is valid', async () => {
    const user = verifyCredentials('alice', 'password')
    expect(user).not.toBeNull()
    const token = issueToken(user)
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(0)
    const found = userForToken(token)
    expect(found).not.toBeNull()
    expect(found.id).toBe('u_alice')
    expect(found.role).toBe('customer')
  })

  it('2. "role upgrade" re-mints a new token carrying role: admin for the same userId', async () => {
    const user = verifyCredentials('alice', 'password')
    const upgraded = issueToken({ ...user, role: 'admin' })
    const found = userForToken(upgraded)
    expect(found).not.toBeNull()
    expect(found.id).toBe('u_alice')
    expect(found.role).toBe('admin')
  })

  it('3. the ORIGINAL customer token is unaffected by the upgrade — still valid, still customer', async () => {
    const user = verifyCredentials('alice', 'password')
    const originalToken = issueToken(user)
    expect(userForToken(originalToken).role).toBe('customer')

    // "Upgrade" — mints an independent token, does not touch the original.
    issueToken({ ...user, role: 'admin' })

    const found = userForToken(originalToken)
    expect(found).not.toBeNull()
    expect(found.role).toBe('customer')
  })
})
