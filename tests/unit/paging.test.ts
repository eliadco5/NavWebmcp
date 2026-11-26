// @vitest-environment node
// Optional pagination and field selection (NavWebMcp 2.7.0). A list call
// without limit/cursor/fields answers exactly as before; with limit it answers
// one page and a signed nextCursor bound to (caller, operation, filters); with
// fields it keeps only those item properties (and the id).
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server'
import { Client } from '@modelcontextprotocol/client'
import { adminCtx, customerCtx, supportCtx } from '@/tests/helpers'
import type { Actor, OperationContext } from '@/lib/operations/types'

beforeAll(async () => {
  await import('@/lib/operations/index')
}, 60_000)

const PAGED = [
  'listAllReservations', 'listReservations', 'listFrontDeskReservations', 'listPayments', 'listCommunications',
  'listInspections', 'listShiftNotes', 'listBugReports', 'searchTasks', 'searchGuests', 'searchAvailability',
  'getMyTasks', 'getTodaySchedule', 'getEntityHistory', 'listUserSessions', 'listAgentClients', 'getCreditLedgers',
]

async function setup() {
  // setup.ts resets modules before each test: load the registry again.
  await import('@/lib/operations/index')
  const { execute } = await import('@/lib/operations/execute')
  const { registry } = await import('@/lib/operations/registry')
  const { tasksStore } = await import('@/lib/seed/tasks')
  return { execute, registry, tasks: tasksStore() }
}

const agent = (ctx: OperationContext, clientId = 'c_agent'): OperationContext => ({
  ...ctx,
  actor: { type: 'agent', userId: ctx.userId, role: ctx.role, assurance: 'verified', agent: { clientId } } satisfies Actor,
})

/** Every page of a list, following nextCursor. */
async function allPages(execute: any, name: string, args: Record<string, unknown>, ctx: OperationContext, key: string) {
  const pages: any[] = []
  let cursor: string | undefined
  do {
    const r = await execute(name, { ...args, ...(cursor ? { cursor } : {}) }, ctx) as any
    expect(r.success, JSON.stringify(r.error)).toBe(true)
    pages.push(r.data)
    cursor = r.data.nextCursor
    expect(pages.length).toBeLessThan(50)
  } while (cursor)
  return { pages, items: pages.flatMap((p) => p[key]) }
}

describe('which operations page', () => {
  it('the 17 list operations, and only those', async () => {
    const { registry } = await setup()
    expect(registry.filter((o: any) => o.listInfo).map((o: any) => o.name).sort()).toEqual([...PAGED].sort())
  })

  it('each publishes limit, cursor, fields and nextCursor; queryAudit keeps its own beforeSeq paging', async () => {
    const { registry } = await setup()
    for (const op of registry.filter((o: any) => o.listInfo)) {
      expect(Object.keys(op.inputSchema), op.name).toEqual(expect.arrayContaining(['limit', 'cursor', 'fields']))
      expect(op.outputSchema.nextCursor, op.name).toBeDefined()
    }
    const audit = registry.find((o: any) => o.name === 'queryAudit') as any
    expect(audit.inputSchema.cursor).toBeUndefined()
  })
})

describe('schema cost', () => {
  it('describe_tool of every list op stays within one 4 KB credit size unit', async () => {
    const { execute, registry } = await setup()
    const { bytesOf } = await import('@/lib/credits/policy')
    for (const op of registry.filter((o: any) => o.listInfo)) {
      const r = await execute('describe_tool', { name: op.name }, adminCtx)
      expect(bytesOf(r), op.name).toBeLessThan(4096)
    }
  })
})

describe('without paging fields nothing changes', () => {
  it('the full list comes back, with no nextCursor', async () => {
    const { execute, tasks } = await setup()
    const r = await execute('searchTasks', {}, supportCtx) as any
    expect(r.success).toBe(true)
    expect(r.data.tasks).toHaveLength(tasks.size)
    expect(r.data.total).toBe(tasks.size)
    expect(r.data.nextCursor).toBeUndefined()
  })

  it('the answer equals the handler\'s own', async () => {
    const { execute, registry } = await setup()
    const op = registry.find((o: any) => o.name === 'listAllReservations') as any
    const direct = await op.handler({}, adminCtx)
    const r = await execute('listAllReservations', {}, adminCtx) as any
    expect(r.data).toEqual(direct.data)
  })

  it('getCreditLedgers keeps its default of 50 rows', async () => {
    const { registry } = await setup()
    const op = registry.find((o: any) => o.name === 'getCreditLedgers') as any
    expect(op.listInfo.defaultLimit).toBe(50)
  })
})

describe('limit and cursor', () => {
  it('walking every page gives the full list once, in order', async () => {
    const { execute } = await setup()
    const full = (await execute('searchTasks', { sortBy: 'title' }, supportCtx) as any).data.tasks
    const { pages, items } = await allPages(execute, 'searchTasks', { sortBy: 'title', limit: 2 }, supportCtx, 'tasks')
    expect(items).toEqual(full)
    expect(pages.length).toBe(Math.ceil(full.length / 2))
    // total counts every match, not the page.
    for (const p of pages) expect(p.total).toBe(full.length)
    expect(pages.at(-1).nextCursor).toBeUndefined()
  })

  it('the next call may omit limit: the cursor remembers it', async () => {
    const { execute } = await setup()
    const first = await execute('searchTasks', { limit: 2 }, supportCtx) as any
    const second = await execute('searchTasks', { cursor: first.data.nextCursor }, supportCtx) as any
    expect(second.success).toBe(true)
    expect(second.data.tasks).toHaveLength(2)
    expect(second.data.tasks[0].taskId).not.toBe(first.data.tasks[0].taskId)
  })

  it('a limit larger than the list returns it all, with no cursor', async () => {
    const { execute, tasks } = await setup()
    const r = await execute('searchTasks', { limit: 200 }, supportCtx) as any
    expect(r.data.tasks).toHaveLength(tasks.size)
    expect(r.data.nextCursor).toBeUndefined()
  })

  it('limit is 1..200', async () => {
    const { execute } = await setup()
    for (const limit of [0, 201, 1.5]) {
      const r = await execute('searchTasks', { limit }, supportCtx) as any
      expect(r.error.code, String(limit)).toBe('INVALID_INPUT')
    }
  })

  it('an item removed before the cursor neither repeats nor skips one', async () => {
    const { execute, tasks } = await setup()
    const full = (await execute('searchTasks', {}, supportCtx) as any).data.tasks.map((t: any) => t.taskId)
    const first = await execute('searchTasks', { limit: 2 }, supportCtx) as any
    tasks.delete(full[0])
    const second = await execute('searchTasks', { cursor: first.data.nextCursor }, supportCtx) as any
    expect(second.data.tasks.map((t: any) => t.taskId)).toEqual(full.slice(2, 4))
  })

  it('when the last item returned is gone, the page still starts right after it', async () => {
    const { execute, tasks } = await setup()
    const full = (await execute('searchTasks', {}, supportCtx) as any).data.tasks.map((t: any) => t.taskId)
    const first = await execute('searchTasks', { limit: 2 }, supportCtx) as any
    tasks.delete(full[1])
    const second = await execute('searchTasks', { cursor: first.data.nextCursor }, supportCtx) as any
    expect(second.data.tasks.map((t: any) => t.taskId)).toEqual(full.slice(2, 4))
  })

  it('an item added before the cursor does not repeat one', async () => {
    const { execute } = await setup()
    const first = await execute('listAllReservations', { limit: 2 }, supportCtx) as any
    const seen = first.data.reservations.map((r: any) => r.id)
    const { store } = await import('@/lib/store')
    const slot = store.searchAvailability('2026-08-08', 2)[0]
    await execute('createReservation', { slotId: slot.id, name: 'Late Add', partySize: 2 }, adminCtx)
    const second = await execute('listAllReservations', { cursor: first.data.nextCursor }, supportCtx) as any
    expect(second.success, JSON.stringify(second.error)).toBe(true)
    for (const r of second.data.reservations) expect(seen).not.toContain(r.id)
  })
})

describe('a cursor only continues its own query', () => {
  async function firstCursor(ctx: OperationContext = supportCtx, args: Record<string, unknown> = {}) {
    const { execute } = await setup()
    const r = await execute('searchTasks', { ...args, limit: 1 }, ctx) as any
    expect(r.data.nextCursor).toMatch(/^p1\./)
    return r.data.nextCursor as string
  }

  const expectBadCursor = (r: any, message: RegExp) => {
    expect(r.success).toBe(false)
    expect(r.error.code).toBe('INVALID_INPUT')
    expect(r.error.details[0].path).toBe('cursor')
    expect(r.error.message).toMatch(message)
  }

  it('a tampered cursor', async () => {
    const { execute } = await setup()
    const c = await firstCursor()
    const [v, body, mac] = c.split('.')
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString())
    const forged = Buffer.from(JSON.stringify({ ...decoded, i: 0, a: 'task_001' })).toString('base64url')
    expectBadCursor(await execute('searchTasks', { cursor: `${v}.${forged}.${mac}` }, supportCtx), /Not a cursor/)
    expectBadCursor(await execute('searchTasks', { cursor: 'garbage' }, supportCtx), /Not a cursor/)
    expectBadCursor(await execute('searchTasks', { cursor: `${c}x` }, supportCtx), /Not a cursor/)
  })

  it('other filters', async () => {
    const { execute } = await setup()
    const c = await firstCursor(supportCtx, { department: 'housekeeping' })
    expectBadCursor(await execute('searchTasks', { cursor: c }, supportCtx), /other filters/)
    expectBadCursor(await execute('searchTasks', { cursor: c, department: 'maintenance' }, supportCtx), /other filters/)
    const same = await execute('searchTasks', { cursor: c, department: 'housekeeping' }, supportCtx) as any
    expect(same.success).toBe(true)
  })

  it('another user, another agent client, another operation', async () => {
    const { execute } = await setup()
    const c = await firstCursor()
    expectBadCursor(await execute('searchTasks', { cursor: c }, adminCtx), /another caller/)
    const ca = await firstCursor(agent(supportCtx, 'c_one'))
    expectBadCursor(await execute('searchTasks', { cursor: ca }, agent(supportCtx, 'c_two')), /another caller/)
    expectBadCursor(await execute('listAllReservations', { cursor: c }, supportCtx), /another caller or operation/)
  })

  it('a confirmation token is not a cursor', async () => {
    const { execute } = await setup()
    const r = await execute('deleteTask', { taskId: 'task_003' }, agent(adminCtx)) as any
    expect(r.error.code).toBe('CONFIRMATION_REQUIRED')
    expectBadCursor(await execute('searchTasks', { cursor: r.error.confirmation.token }, adminCtx), /Not a cursor/)
  })

  it('a bad cursor on a nested call fails only that call', async () => {
    const { execute } = await setup()
    const r = await execute('invoke', { calls: [
      { name: 'searchTasks', args: { cursor: 'garbage' } },
      { name: 'searchTasks', args: { limit: 1 } },
    ] }, supportCtx) as any
    expect(r.success).toBe(true)
    expect(r.data.results[0].success).toBe(false)
    expect(r.data.results[1].success).toBe(true)
    expect(r.data.results[1].data.nextCursor).toBeDefined()
  })
})

describe('fields', () => {
  it('keeps only the named properties, plus the id', async () => {
    const { execute } = await setup()
    const r = await execute('searchTasks', { fields: ['title', 'status'] }, supportCtx) as any
    expect(r.success).toBe(true)
    for (const t of r.data.tasks) expect(Object.keys(t).sort()).toEqual(['status', 'taskId', 'title'])
    // Not paged: every task, no cursor.
    expect(r.data.nextCursor).toBeUndefined()
  })

  it('works with limit and cursor', async () => {
    const { execute } = await setup()
    const { items } = await allPages(execute, 'searchTasks', { limit: 2, fields: ['title'] }, supportCtx, 'tasks')
    for (const t of items) expect(Object.keys(t).sort()).toEqual(['taskId', 'title'])
  })

  it('may change between pages (the cursor binds filters, not the projection)', async () => {
    const { execute } = await setup()
    const first = await execute('searchTasks', { limit: 1, fields: ['title'] }, supportCtx) as any
    const second = await execute('searchTasks', { cursor: first.data.nextCursor }, supportCtx) as any
    expect(second.success).toBe(true)
    expect(Object.keys(second.data.tasks[0])).toContain('department')
  })

  it('an unknown property is INVALID_INPUT', async () => {
    const { execute } = await setup()
    const r = await execute('searchTasks', { fields: ['title', 'nope'] }, supportCtx) as any
    expect(r.error.code).toBe('INVALID_INPUT')
    expect(r.error.details[0].path).toMatch(/^fields/)
  })
})

describe('new filters', () => {
  it('listAllReservations by status and date range', async () => {
    const { execute } = await setup()
    const all = (await execute('listAllReservations', {}, adminCtx) as any).data.reservations
    const pending = (await execute('listAllReservations', { status: 'pending' }, adminCtx) as any).data
    expect(pending.reservations.every((r: any) => r.status === 'pending')).toBe(true)
    expect(pending.count).toBe(all.filter((r: any) => r.status === 'pending').length)
    const dated = all.filter((r: any) => r.date).map((r: any) => r.date).sort()
    if (dated.length) {
      const day = dated[0]
      const one = (await execute('listAllReservations', { from: day, to: day }, adminCtx) as any).data.reservations
      expect(one.length).toBeGreaterThan(0)
      expect(one.every((r: any) => r.date === day)).toBe(true)
    }
  })

  it('listReservations by status', async () => {
    const { execute } = await setup()
    const r = await execute('listReservations', { status: 'cancelled' }, customerCtx) as any
    expect(r.success).toBe(true)
    expect(r.data.reservations.every((x: any) => x.status === 'cancelled')).toBe(true)
  })

  it('listFrontDeskReservations counts before paging', async () => {
    const { execute } = await setup()
    const all = (await execute('listFrontDeskReservations', {}, supportCtx) as any).data
    expect(all.count).toBe(all.reservations.length)
    const one = (await execute('listFrontDeskReservations', { limit: 1 }, supportCtx) as any).data
    expect(one.count).toBe(all.count)
  })
})

describe('MCP', () => {
  let client: Client | undefined
  afterEach(async () => { await client?.close(); client = undefined })

  it('a projected page passes the SDK\'s output check and pages on', async () => {
    await import('@/lib/operations/index')
    const { registerMcpTools, withMcpAuthRole } = await import('@/lib/adapters/mcp')
    const { addLoaded } = await import('@/lib/loadedTools')
    const TOKEN = 'tok_paging'
    addLoaded(TOKEN, ['searchTasks'])
    const server = new McpServer({ name: 't', version: '0' })
    await withMcpAuthRole(async () => { registerMcpTools(server); return new Response() }, () => 'support', () => TOKEN)(new Request('http://x/api/mcp'))
    const [a, b] = InMemoryTransport.createLinkedPair()
    const send = a.send.bind(a)
    a.send = (msg, o) => send(msg, { ...o, authInfo: { token: TOKEN, clientId: 'c_mcp', scopes: [], extra: { userId: 'u_carol', role: 'support' } } })
    await server.connect(b)
    client = new Client({ name: 'paging-client', version: '0' })
    await client.connect(a)

    const first = await client.callTool({ name: 'searchTasks', arguments: { limit: 2, fields: ['title'] } }) as any
    expect(first.isError, JSON.stringify(first.content)).toBeFalsy()
    expect(first.structuredContent.tasks).toHaveLength(2)
    expect(Object.keys(first.structuredContent.tasks[0]).sort()).toEqual(['taskId', 'title'])
    const next = await client.callTool({ name: 'searchTasks', arguments: { cursor: first.structuredContent.nextCursor } }) as any
    expect(next.isError, JSON.stringify(next.content)).toBeFalsy()
    expect(next.structuredContent.tasks[0].taskId).not.toBe(first.structuredContent.tasks[0].taskId)
  })
})
