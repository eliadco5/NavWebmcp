// @vitest-environment node
// execute() is the one path every operation call takes. These pin down what
// the audit trail must be able to answer: who acted (human / agent / system),
// on whose behalf, through which channel, and how nested calls relate.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { customerCtx } from '@/tests/helpers'

const { jar } = vi.hoisted(() => ({ jar: new Map<string, string>() }))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value) },
  }),
}))

const BOOK = { date: '2026-07-07', time: '19:00', partySize: 2, name: 'Dana' }

async function entries() {
  return (await import('@/lib/auditlog')).auditLog.getEntries()
}

beforeEach(async () => {
  jar.clear()
  await import('@/lib/operations/index')
})

describe('execute()', () => {
  it('labels an unlabelled context as a system actor on the internal channel', async () => {
    const { execute } = await import('@/lib/operations/execute')
    await execute('getWaitTime', {}, customerCtx)
    const [e] = await entries()
    expect(e).toMatchObject({
      operation: 'getWaitTime', userId: 'u_alice', role: 'customer',
      actorType: 'system', channel: 'internal', source: 'agent',
    })
    expect(e.callId).toBeTruthy()
    expect(e.parentCallId).toBeUndefined()
    expect(typeof e.durationMs).toBe('number')
  })

  it('nested calls inherit the actor, share the requestId and link to their parent', async () => {
    const { execute, requestMeta } = await import('@/lib/operations/execute')
    const actor = { type: 'human' as const, userId: 'u_alice', role: 'customer' as const, assurance: 'asserted' as const }
    await execute('book', BOOK, { ...customerCtx, actor, meta: requestMeta('ui') })
    const all = await entries()
    const parent = all.find((e) => e.operation === 'book')!
    const children = all.filter((e) => e.parentCallId === parent.callId)
    expect(children.length).toBeGreaterThan(0)
    for (const c of children) {
      expect(c).toMatchObject({ actorType: 'human', channel: 'ui', userId: 'u_alice', requestId: parent.requestId })
    }
  })

  it('audits denials and validation failures with their error code', async () => {
    const { execute } = await import('@/lib/operations/execute')
    await execute('issueRefund', { paymentId: 'pay_001', reason: 'x', confirm: true }, customerCtx)
    await execute('nope', {}, customerCtx)
    await execute('searchAvailability', { date: '07/07/2026', partySize: 2 }, customerCtx)
    const codes = (await entries()).map((e) => e.errorCode)
    expect(codes).toEqual(['INVALID_ARGS', 'UNKNOWN_TOOL', 'FORBIDDEN'])
  })
})

describe('POST /api/call actor classification', () => {
  async function post(body: unknown, headers: Record<string, string> = {}) {
    const { createSession } = await import('@/lib/auth-tokens')
    const { getUserById, SESSION_COOKIE } = await import('@/lib/auth')
    jar.set(SESSION_COOKIE, createSession(getUserById('u_alice')!))
    const { POST } = await import('@/app/api/call/route')
    const req = new Request('http://localhost/api/call', { method: 'POST', body: JSON.stringify(body), headers })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return POST(req as any)
  }

  it('a plain UI call is a human on the ui channel', async () => {
    await post({ name: 'getWaitTime', params: {} }, { 'x-navwebmcp-channel': 'ui' })
    expect((await entries())[0]).toMatchObject({ actorType: 'human', channel: 'ui', assurance: 'asserted', source: 'ui' })
  })

  it('the in-page WebMCP agent is an agent on the webmcp channel', async () => {
    await post({ name: 'getWaitTime', params: {} }, { 'x-navwebmcp-channel': 'webmcp', 'x-navwebmcp-agent': 'Gemini in Chrome' })
    expect((await entries())[0]).toMatchObject({
      actorType: 'agent', channel: 'webmcp', source: 'agent',
      agent: { clientId: 'webmcp:in-page', name: 'Gemini in Chrome' },
    })
  })

  it('keeps 404 for unknown ops and 403 for RBAC, both audited', async () => {
    expect((await post({ name: 'nope', params: {} })).status).toBe(404)
    expect((await post({ name: 'issueRefund', params: { paymentId: 'pay_001', reason: 'x', confirm: true } })).status).toBe(403)
    expect((await entries()).slice(0, 2).map((e) => e.errorCode)).toEqual(['FORBIDDEN', 'NOT_FOUND'])
  })

  it("a handler's own NOT_FOUND stays a 200 Result", async () => {
    const res = await post({ name: 'getReservation', params: { reservationId: 'res_missing' } })
    expect(res.status).toBe(200)
  })
})
