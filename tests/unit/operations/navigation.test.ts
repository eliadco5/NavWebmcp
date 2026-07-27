// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { adminCtx, supportCtx, customerCtx } from '@/tests/helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let registry: any[]
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
let getContext: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getCapabilities: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getLoaded: any

beforeEach(async () => {
  await import('@/lib/operations/index')
  const mods = await Promise.all([
    import('@/lib/operations/registry'),
    import('@/lib/operations/explore'),
    import('@/lib/operations/search'),
    import('@/lib/operations/describeTool'),
    import('@/lib/operations/invoke'),
    import('@/lib/operations/loadTools'),
    import('@/lib/operations/unloadTools'),
    import('@/lib/operations/getContext'),
    import('@/lib/operations/getCapabilities'),
    import('@/lib/loadedTools'),
  ])
  registry = mods[0].registry
  explore = mods[1].explore
  search = mods[2].search
  describeTool = mods[3].describeTool
  invoke = mods[4].invoke
  loadTools = mods[5].loadTools
  unloadTools = mods[6].unloadTools
  getContext = mods[7].getContext
  getCapabilities = mods[8].getCapabilities
  getLoaded = mods[9].getLoaded
})

// ── explore ───────────────────────────────────────────────────────────────────

describe('explore', () => {
  it('no path returns platformManifest shape with app, description, modules', async () => {
    const result = await explore.handler({}, adminCtx)
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty('app')
    expect(result.data).toHaveProperty('description')
    expect(Array.isArray(result.data.modules)).toBe(true)
  })

  it('no path, customer role — modules does NOT include finance (admin-only ops)', async () => {
    const result = await explore.handler({}, customerCtx)
    expect(result.success).toBe(true)
    const modulePaths = result.data.modules.map((m: { path: string }) => m.path)
    expect(modulePaths).not.toContain('finance')
  })

  it('no path, admin role — modules includes all top-level visible modules', async () => {
    const result = await explore.handler({}, adminCtx)
    expect(result.success).toBe(true)
    const modulePaths = result.data.modules.map((m: { path: string }) => m.path)
    expect(modulePaths).toContain('reservation')
    expect(modulePaths).toContain('crm')
    expect(modulePaths).toContain('frontoffice')
    expect(modulePaths).toContain('finance')
  })

  it('path: "reservation" returns ExploreNode with path, title, submodules, functions', async () => {
    const result = await explore.handler({ path: 'reservation' }, adminCtx)
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty('path', 'reservation')
    expect(result.data).toHaveProperty('title')
    expect(Array.isArray(result.data.submodules)).toBe(true)
    expect(Array.isArray(result.data.functions)).toBe(true)
  })

  it('path: "reservation" submodules includes reservation.booking and reservation.availability', async () => {
    const result = await explore.handler({ path: 'reservation' }, adminCtx)
    const subPaths = result.data.submodules.map((s: { path: string }) => s.path)
    expect(subPaths).toContain('reservation.booking')
    expect(subPaths).toContain('reservation.availability')
  })

  it('path: "reservation.booking" functions array contains createReservation and cancelReservation', async () => {
    const result = await explore.handler({ path: 'reservation.booking' }, adminCtx)
    const fnNames = result.data.functions.map((f: { name: string }) => f.name)
    expect(fnNames).toContain('createReservation')
    expect(fnNames).toContain('cancelReservation')
  })

  it('path: "reservation.booking", customer role — functions present (customer can see these)', async () => {
    const result = await explore.handler({ path: 'reservation.booking' }, customerCtx)
    expect(result.success).toBe(true)
    expect(result.data.functions.length).toBeGreaterThan(0)
  })

  it('path: "nonexistent" returns NOT_FOUND', async () => {
    const result = await explore.handler({ path: 'nonexistent' }, adminCtx)
    expect(result.success).toBe(false)
    expect((result as any).error.code).toBe('NOT_FOUND')
  })

  it('path: "reservation.*" wildcard returns nodes array', async () => {
    const result = await explore.handler({ path: 'reservation.*' }, adminCtx)
    expect(result.success).toBe(true)
    expect(Array.isArray(result.data.nodes)).toBe(true)
    expect(result.data.nodes.length).toBeGreaterThan(0)
  })

  it('path: "*" returns nodes covering all modules', async () => {
    const result = await explore.handler({ path: '*' }, adminCtx)
    expect(result.success).toBe(true)
    expect(Array.isArray(result.data.nodes)).toBe(true)
    expect(result.data.nodes.length).toBeGreaterThan(5)
  })

  it('path: array ["reservation.booking","reservation.search"] returns results array of length 2', async () => {
    const result = await explore.handler({ path: ['reservation.booking', 'reservation.search'] }, adminCtx)
    expect(result.success).toBe(true)
    expect(Array.isArray(result.data.results)).toBe(true)
    expect(result.data.results.length).toBe(2)
  })

  it('path: array with nonexistent entry has error field on that entry', async () => {
    const result = await explore.handler({ path: ['reservation.booking', 'nonexistent'] }, adminCtx)
    expect(result.success).toBe(true)
    const results = result.data.results
    const bad = results.find((r: any) => r.path === 'nonexistent')
    expect(bad).toBeDefined()
    expect(bad.error).toBeDefined()
  })

  it('path: "finance" with customer role returns node with empty functions', async () => {
    const result = await explore.handler({ path: 'finance' }, customerCtx)
    // finance module exists in MODULE_DEFS so getNode returns it, but no customer-visible ops
    expect(result.success).toBe(true)
    expect(result.data.path).toBe('finance')
    expect(result.data.functions.length).toBe(0)
  })

  it('path: "reservation.booking" with support role — functions appear', async () => {
    const result = await explore.handler({ path: 'reservation.booking' }, supportCtx)
    expect(result.success).toBe(true)
    expect(result.data.functions.length).toBeGreaterThan(0)
  })

  it('array path with wildcard entry', async () => {
    const result = await explore.handler({ path: ['reservation.*', 'reservation.booking'] }, adminCtx)
    expect(result.success).toBe(true)
    expect(Array.isArray(result.data.results)).toBe(true)
    expect(result.data.results.length).toBe(2)
  })
})

// ── search ────────────────────────────────────────────────────────────────────

describe('search', () => {
  it('pattern: "reservation" with admin returns success and functions includes createReservation', async () => {
    const result = await search.handler({ pattern: 'reservation' }, adminCtx)
    expect(result.success).toBe(true)
    const names = result.data.functions.map((f: any) => f.name)
    expect(names).toContain('createReservation')
  })

  it('pattern: "**/*cancel*" with admin returns cancelReservation and cancelAnyReservation', async () => {
    const result = await search.handler({ pattern: '**/*cancel*' }, adminCtx)
    const names = result.data.functions.map((f: any) => f.name)
    expect(names).toContain('cancelReservation')
    expect(names).toContain('cancelAnyReservation')
  })

  it('pattern: "finance/**" with admin returns non-empty functions all from finance module', async () => {
    const result = await search.handler({ pattern: 'finance/**' }, adminCtx)
    expect(result.data.functions.length).toBeGreaterThan(0)
    for (const fn of result.data.functions) {
      expect(fn.module).toMatch(/^finance/)
    }
  })

  it('pattern: "finance/**" with customer returns empty functions', async () => {
    const result = await search.handler({ pattern: 'finance/**' }, customerCtx)
    expect(result.data.functions).toHaveLength(0)
  })

  it('pattern: "nonexistent_xyz_abc_12345" returns empty functions and modules', async () => {
    const result = await search.handler({ pattern: 'nonexistent_xyz_abc_12345' }, adminCtx)
    expect(result.data.functions).toHaveLength(0)
    expect(result.data.modules).toHaveLength(0)
  })

  it('pattern: "" (empty) fails validation at invoke layer', async () => {
    // The search inputSchema has z.string().min(1), which is validated by invoke
    const result = await invoke.handler({ name: 'search', args: { pattern: '' } }, adminCtx)
    expect(result.success).toBe(true)
    const inner = result.data as any
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('INVALID_ARGS')
  })

  it('pattern: "crm/**" with support returns non-empty functions', async () => {
    const result = await search.handler({ pattern: 'crm/**' }, supportCtx)
    expect(result.data.functions.length).toBeGreaterThan(0)
  })

  it('pattern: "crm/guests/**" with customer returns empty functions (guests are support/admin only)', async () => {
    const result = await search.handler({ pattern: 'crm/guests/**' }, customerCtx)
    expect(result.data.functions).toHaveLength(0)
  })

  it('always-on ops never appear in search results', async () => {
    const result = await search.handler({ pattern: '**' }, adminCtx)
    const names = result.data.functions.map((f: any) => f.name)
    const alwaysOnNames = ['explore', 'search', 'invoke', 'describe_tool', 'load_tools', 'unload_tools', 'getContext', 'getCapabilities']
    for (const n of alwaysOnNames) {
      expect(names).not.toContain(n)
    }
  })

  it('each function result has module and path fields', async () => {
    const result = await search.handler({ pattern: 'reservation' }, adminCtx)
    expect(result.data.functions.length).toBeGreaterThan(0)
    for (const fn of result.data.functions) {
      expect(fn).toHaveProperty('module')
      expect(fn).toHaveProperty('path')
    }
  })
})

// ── describe_tool ─────────────────────────────────────────────────────────────

describe('describe_tool', () => {
  it('name: "searchAvailability" returns inputSchema with date and partySize', async () => {
    const result = await describeTool.handler({ name: 'searchAvailability' }, customerCtx)
    expect(result.success).toBe(true)
    const schema = result.data.inputSchema as any
    expect(schema.properties).toHaveProperty('date')
    expect(schema.properties).toHaveProperty('partySize')
  })

  it('name: "nonexistent" returns error UNKNOWN_TOOL', async () => {
    const result = await describeTool.handler({ name: 'nonexistent' }, adminCtx)
    expect(result.success).toBe(true)
    expect(result.data.error).toBe('UNKNOWN_TOOL')
  })

  it('name: "listAllReservations" with customer role returns FORBIDDEN', async () => {
    const result = await describeTool.handler({ name: 'listAllReservations' }, customerCtx)
    expect(result.success).toBe(true)
    expect(result.data.error).toBe('FORBIDDEN')
  })

  it('name: array ["searchAvailability","createReservation"] returns tools array of length 2', async () => {
    const result = await describeTool.handler({ name: ['searchAvailability', 'createReservation'] }, adminCtx)
    expect(result.success).toBe(true)
    expect(Array.isArray(result.data.tools)).toBe(true)
    expect(result.data.tools.length).toBe(2)
  })

  it('name: array with nonexistent — one valid, one error entry', async () => {
    const result = await describeTool.handler({ name: ['searchAvailability', 'nonexistent'] }, adminCtx)
    expect(result.success).toBe(true)
    const tools = result.data.tools
    const valid = tools.find((t: any) => t.name === 'searchAvailability')
    const bad = tools.find((t: any) => t.name === 'nonexistent')
    expect(valid.inputSchema).toBeDefined()
    expect(bad.error).toBe('UNKNOWN_TOOL')
  })

  it('returned schema has requiresConfirmation field', async () => {
    const result = await describeTool.handler({ name: 'createReservation' }, adminCtx)
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty('requiresConfirmation')
  })

  it('returned schema has parallelSafe field', async () => {
    const result = await describeTool.handler({ name: 'searchAvailability' }, adminCtx)
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty('parallelSafe')
  })

  it('cancelReservation has requiresConfirmation === true', async () => {
    const result = await describeTool.handler({ name: 'cancelReservation' }, adminCtx)
    expect(result.success).toBe(true)
    expect(result.data.requiresConfirmation).toBe(true)
  })
})

// ── invoke ────────────────────────────────────────────────────────────────────

describe('invoke', () => {
  it('single call {name:"getContext"} returns success with booking page data', async () => {
    const result = await invoke.handler({ name: 'getContext', args: {} }, customerCtx)
    expect(result.success).toBe(true)
    const inner = result.data as any
    expect(inner.success).toBe(true)
    expect(inner.data.page).toBe('booking')
  })

  it('batch {calls:[getContext, getCapabilities]} returns {results} of length 2', async () => {
    const result = await invoke.handler({
      calls: [
        { name: 'getContext', args: {} },
        { name: 'getCapabilities', args: {} },
      ],
    }, adminCtx)
    expect(result.success).toBe(true)
    expect(Array.isArray(result.data.results)).toBe(true)
    expect(result.data.results.length).toBe(2)
  })

  it('neither name nor calls provided returns INVALID_ARGS', async () => {
    const result = await invoke.handler({}, adminCtx)
    expect(result.success).toBe(false)
    expect((result as any).error.code).toBe('INVALID_ARGS')
  })

  it('{name:"nonexistent"} returns UNKNOWN_TOOL inside data', async () => {
    const result = await invoke.handler({ name: 'nonexistent' }, adminCtx)
    expect(result.success).toBe(true)
    const inner = result.data as any
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('UNKNOWN_TOOL')
  })

  it('{name:"listAllReservations"} with customer role returns FORBIDDEN inside data', async () => {
    const result = await invoke.handler({ name: 'listAllReservations', args: {} }, customerCtx)
    expect(result.success).toBe(true)
    const inner = result.data as any
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('FORBIDDEN')
  })

  it('invalid args wrong type returns INVALID_ARGS inside data', async () => {
    const result = await invoke.handler({ name: 'searchAvailability', args: { date: 123, partySize: 'bad' } }, adminCtx)
    expect(result.success).toBe(true)
    const inner = result.data as any
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('INVALID_ARGS')
  })

  it('batch with only reads — all run successfully', async () => {
    const result = await invoke.handler({
      calls: [
        { name: 'getContext', args: {} },
        { name: 'listReservations', args: {} },
      ],
    }, customerCtx)
    expect(result.success).toBe(true)
    const r = result.data.results as any[]
    expect(r.every((x) => x.success)).toBe(true)
  })

  it('searchAvailability with valid args succeeds for customer', async () => {
    // Use a date within the seeded window (today + 1)
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const date = tomorrow.toISOString().split('T')[0]
    const result = await invoke.handler({ name: 'searchAvailability', args: { date, partySize: 2 } }, customerCtx)
    expect(result.success).toBe(true)
    const inner = result.data as any
    expect(inner.success).toBe(true)
  })

  it('searchAvailability bad date format returns INVALID_ARGS', async () => {
    const result = await invoke.handler({ name: 'searchAvailability', args: { date: 'bad-date', partySize: 2 } }, customerCtx)
    expect(result.success).toBe(true)
    const inner = result.data as any
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('INVALID_ARGS')
  })

  it('searchAvailability partySize 0 returns INVALID_ARGS', async () => {
    const result = await invoke.handler({ name: 'searchAvailability', args: { date: '2026-07-15', partySize: 0 } }, customerCtx)
    expect(result.success).toBe(true)
    const inner = result.data as any
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('INVALID_ARGS')
  })

  it('batch result array length matches calls array length', async () => {
    const calls = [
      { name: 'getContext', args: {} },
      { name: 'getCapabilities', args: {} },
      { name: 'listReservations', args: {} },
    ]
    const result = await invoke.handler({ calls }, adminCtx)
    expect(result.success).toBe(true)
    expect(result.data.results.length).toBe(3)
  })

  it('getCapabilities with admin returns 8-char hex capabilityHash', async () => {
    const result = await invoke.handler({ name: 'getCapabilities', args: {} }, adminCtx)
    expect(result.success).toBe(true)
    const inner = result.data as any
    expect(inner.success).toBe(true)
    expect(inner.data.capabilityHash).toMatch(/^[0-9a-f]{8}$/)
  })
})

// ── load_tools / unload_tools ─────────────────────────────────────────────────

describe('load_tools and unload_tools', () => {
  it('load_tools searchAvailability with customer token returns LOADED', async () => {
    const result = await loadTools.handler({ names: ['searchAvailability'] }, customerCtx)
    expect(result.success).toBe(true)
    const r = result.data.results[0]
    expect(r.status).toBe('LOADED')
  })

  it('load_tools explore (alwaysOn) returns NO_OP', async () => {
    const result = await loadTools.handler({ names: ['explore'] }, adminCtx)
    expect(result.success).toBe(true)
    const r = result.data.results[0]
    expect(r.status).toBe('NO_OP')
  })

  it('load_tools nonexistent returns UNKNOWN_TOOL', async () => {
    const result = await loadTools.handler({ names: ['nonexistent_xyz'] }, adminCtx)
    expect(result.success).toBe(true)
    expect(result.data.results[0].status).toBe('UNKNOWN_TOOL')
  })

  it('load_tools listAllReservations with customer returns FORBIDDEN', async () => {
    const result = await loadTools.handler({ names: ['listAllReservations'] }, customerCtx)
    expect(result.success).toBe(true)
    expect(result.data.results[0].status).toBe('FORBIDDEN')
  })

  it('after load_tools, getLoaded contains the loaded name', async () => {
    await loadTools.handler({ names: ['searchAvailability'] }, customerCtx)
    const loaded = getLoaded(customerCtx.token)
    expect(loaded.has('searchAvailability')).toBe(true)
  })

  it('unload_tools returns success with removed array', async () => {
    await loadTools.handler({ names: ['searchAvailability'] }, customerCtx)
    const result = await unloadTools.handler({ names: ['searchAvailability'] }, customerCtx)
    expect(result.success).toBe(true)
    expect(result.data.removed).toContain('searchAvailability')
  })

  it('load_tools with empty names array fails Zod validation via invoke', async () => {
    const result = await invoke.handler({ name: 'load_tools', args: { names: [] } }, adminCtx)
    expect(result.success).toBe(true)
    const inner = result.data as any
    expect(inner.success).toBe(false)
    expect(inner.error.code).toBe('INVALID_ARGS')
  })

  it('load then unload round trip: loaded then unloaded', async () => {
    await loadTools.handler({ names: ['createReservation'] }, adminCtx)
    expect(getLoaded(adminCtx.token).has('createReservation')).toBe(true)
    await unloadTools.handler({ names: ['createReservation'] }, adminCtx)
    expect(getLoaded(adminCtx.token).has('createReservation')).toBe(false)
  })
})

// ── getContext ────────────────────────────────────────────────────────────────

describe('getContext', () => {
  it('returns page:"booking", authenticated:true, locale:"en-US"', async () => {
    const result = await getContext.handler({}, customerCtx)
    expect(result.success).toBe(true)
    expect(result.data.page).toBe('booking')
    expect(result.data.authenticated).toBe(true)
    expect(result.data.locale).toBe('en-US')
  })

  it('user field is {id:"u_alice", displayName:"Alice"} for customerCtx', async () => {
    const result = await getContext.handler({}, customerCtx)
    expect(result.data.user).toEqual({ id: 'u_alice', displayName: 'Alice' })
  })

  it('user field is {id:"u_bob", displayName:"Bob"} for adminCtx', async () => {
    const result = await getContext.handler({}, adminCtx)
    expect(result.data.user).toEqual({ id: 'u_bob', displayName: 'Bob' })
  })

  it('context with unknown userId returns user: null', async () => {
    const result = await getContext.handler({}, { userId: 'u_unknown', role: 'customer' as const, token: 'tok_x' })
    expect(result.data.user).toBeNull()
  })

  it('returns success: true', async () => {
    const result = await getContext.handler({}, supportCtx)
    expect(result.success).toBe(true)
  })
})

// ── getCapabilities ───────────────────────────────────────────────────────────

describe('getCapabilities', () => {
  it('returns {protocolVersion, capabilityHash, count, tools}', async () => {
    const result = await getCapabilities.handler({}, adminCtx)
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty('protocolVersion')
    expect(result.data).toHaveProperty('capabilityHash')
    expect(result.data).toHaveProperty('count')
    expect(result.data).toHaveProperty('tools')
    expect(result.data).not.toHaveProperty('version')
  })

  it('capabilityHash is an 8-char hex string', async () => {
    const result = await getCapabilities.handler({}, adminCtx)
    expect(result.data.capabilityHash).toMatch(/^[0-9a-f]{8}$/)
  })

  it('protocolVersion is semver and matches PROTOCOL_VERSION', async () => {
    const { PROTOCOL_VERSION } = await import('@/lib/protocol')
    const result = await getCapabilities.handler({}, adminCtx)
    expect(result.data.protocolVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(result.data.protocolVersion).toBe(PROTOCOL_VERSION)
  })

  it('customer sees fewer tools than admin', async () => {
    const [adminResult, customerResult] = await Promise.all([
      getCapabilities.handler({}, adminCtx),
      getCapabilities.handler({}, customerCtx),
    ])
    expect(adminResult.data.count).toBeGreaterThan(customerResult.data.count)
  })

  it('tools array contains expected shape {name, title, permission, roles, requiresConfirmation}', async () => {
    const result = await getCapabilities.handler({}, adminCtx)
    const tool = result.data.tools[0]
    expect(tool).toHaveProperty('name')
    expect(tool).toHaveProperty('title')
    expect(tool).toHaveProperty('permission')
    expect(tool).toHaveProperty('roles')
    expect(tool).toHaveProperty('requiresConfirmation')
  })

  it('count equals tools.length', async () => {
    const result = await getCapabilities.handler({}, adminCtx)
    expect(result.data.count).toBe(result.data.tools.length)
  })
})
