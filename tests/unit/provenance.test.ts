// @vitest-environment node
// "Who created this reservation?" answered on the record itself, and tied to
// the audit event that has the full story.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { adminCtx, customerCtx } from '@/tests/helpers'
import type { Actor } from '@/lib/operations/types'

const { jar } = vi.hoisted(() => ({ jar: new Map<string, string>() }))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value) },
    delete: (name: string) => { jar.delete(name) },
  }),
}))

beforeEach(async () => {
  jar.clear()
  await import('@/lib/operations/index')
})

const BOOK = { date: '2026-07-07', time: '18:00', partySize: 2, name: 'Dana' }

async function callAs(userId: string, name: string, params: unknown, headers: Record<string, string> = {}) {
  const { createSession, newSessionId } = await import('@/lib/auth-tokens')
  const { getUserById, SESSION_COOKIE } = await import('@/lib/auth')
  jar.set(SESSION_COOKIE, createSession(getUserById(userId)!, newSessionId()))
  const { POST } = await import('@/app/api/call/route')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await POST(new Request('http://localhost/api/call', { method: 'POST', body: JSON.stringify({ name, params }), headers }) as any)).json()
}

describe('stamp()', () => {
  it('describes a human, an agent and the system', async () => {
    const { stamp, describeProvenance } = await import('@/lib/provenance')
    const agent: Actor = { type: 'agent', userId: 'u_alice', role: 'customer', assurance: 'verified', agent: { clientId: 'c_1', name: 'Claude' } }
    const p = stamp({ ...customerCtx, actor: agent, meta: { requestId: 'r1', callId: 'call1', channel: 'mcp' } })
    expect(p).toMatchObject({ actorType: 'agent', userId: 'u_alice', channel: 'mcp', agentClientId: 'c_1', agentName: 'Claude', auditId: 'call1' })
    expect(describeProvenance(p, () => 'Alice')).toBe('Alice · via Claude (MCP)')
    expect(describeProvenance(stamp(customerCtx))).toBe('System')
  })
})

describe('records carry who created them', () => {
  it('a reservation booked by clicking says human; one booked by the in-page agent says agent', async () => {
    const byHand = await callAs('u_alice', 'book', BOOK, { 'x-navwebmcp-channel': 'ui' })
    const byAgent = await callAs('u_alice', 'book', { ...BOOK, time: '20:00' }, { 'x-navwebmcp-channel': 'webmcp', 'x-navwebmcp-agent': 'Gemini' })
    expect(byHand.data.reservation.createdBy).toMatchObject({ actorType: 'human', userId: 'u_alice', channel: 'ui' })
    expect(byAgent.data.reservation.createdBy).toMatchObject({ actorType: 'agent', userId: 'u_alice', channel: 'webmcp', agentName: 'Gemini' })

    // And it survives a later read: the stamp is on the stored record.
    const { store } = await import('@/lib/store')
    expect(store.getReservationById(byAgent.data.reservation.id)?.createdBy?.actorType).toBe('agent')
  })

  it("the stamp's auditId is the audit event for that exact change", async () => {
    const res = await callAs('u_alice', 'book', BOOK)
    const { queryAudit } = await import('@/lib/audit')
    const { events } = await queryAudit({ action: 'createReservation', outcome: 'success' })
    expect(events[0].id).toBe(res.data.reservation.createdBy.auditId)
    expect(events[0].target).toEqual({ type: 'reservation', id: res.data.reservation.id })
  })

  it('updates record who last changed a record, separately from who created it', async () => {
    const { execute } = await import('@/lib/operations/execute')
    const created = await execute('createTask', { title: 'Fix lamp', department: 'maintenance', priority: 'low' }, adminCtx)
    const taskId = (created as { data: { task: { taskId: string } } }).data.task.taskId
    const agent: Actor = { type: 'agent', userId: 'u_bob', role: 'admin', assurance: 'verified', agent: { clientId: 'c_9' } }
    const updated = await execute('updateTask', { taskId, status: 'in_progress' }, { ...adminCtx, actor: agent })
    const task = (updated as { data: { task: { createdBy: { actorType: string }; lastModifiedBy: { actorType: string; agentClientId: string } } } }).data.task
    expect(task.createdBy.actorType).toBe('system')
    expect(task.lastModifiedBy).toMatchObject({ actorType: 'agent', agentClientId: 'c_9' })
  })

  it("a shift note's typed-in author can't hide who actually wrote it", async () => {
    const res = await callAs('u_carol', 'addShiftNote', { note: 'Table 4 wobbly', author: 'Bob' })
    expect(res.data).toMatchObject({ author: 'Bob', createdBy: { userId: 'u_carol', actorType: 'human' } })
  })
})
