// @vitest-environment node
// End to end through the real surfaces: every call and every auth event lands
// in the SOC2 trail with who / how / which record, and the activity feed only
// shows a user their own calls.
import { describe, it, expect, beforeEach, vi } from 'vitest'

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
  delete process.env.REDIS_URL
  await import('@/lib/operations/index')
})

async function signIn(userId: string) {
  const { createSession, newSessionId } = await import('@/lib/auth-tokens')
  const { getUserById, SESSION_COOKIE } = await import('@/lib/auth')
  const sid = newSessionId()
  jar.set(SESSION_COOKIE, createSession(getUserById(userId)!, sid))
  return sid
}

async function call(name: string, params: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import('@/app/api/call/route')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return POST(new Request('http://localhost/api/call', { method: 'POST', body: JSON.stringify({ name, params }), headers }) as any)
}

async function trail(q = {}) {
  return (await (await import('@/lib/audit')).queryAudit(q)).events
}

describe('who created this reservation?', () => {
  it('a human booking and an in-page agent booking are told apart, by record', async () => {
    const sid = await signIn('u_alice')
    const BOOK = { date: '2026-07-07', time: '18:00', partySize: 2, name: 'Dana' }
    await call('book', BOOK, { 'x-navwebmcp-channel': 'ui' })
    await call('book', { ...BOOK, time: '20:00' }, { 'x-navwebmcp-channel': 'webmcp', 'x-navwebmcp-agent': 'Gemini' })

    const creates = await trail({ action: 'createReservation', outcome: 'success' })
    expect(creates).toHaveLength(2)
    const [agentMade, humanMade] = creates // newest first
    expect(humanMade).toMatchObject({ actor: { type: 'human', userId: 'u_alice', sessionId: sid }, channel: 'ui', target: { type: 'reservation' } })
    expect(agentMade).toMatchObject({ actor: { type: 'agent', agent: { name: 'Gemini' } }, channel: 'webmcp', target: { type: 'reservation' } })
    expect(humanMade.target!.id).not.toBe(agentMade.target!.id)

    // And by record id, the history of one reservation:
    const history = await trail({ targetType: 'reservation', targetId: agentMade.target!.id })
    expect(history.every((e) => e.actor.type === 'agent')).toBe(true)
    // The nested create is linked to the composite that caused it.
    const parent = (await trail({ requestId: agentMade.requestId })).find((e) => e.action === 'book')!
    expect(agentMade.parentCallId).toBe(parent.callId)
  })

  it('records denials as "denied", not just "failure"', async () => {
    await signIn('u_alice')
    await call('issueRefund', { paymentId: 'pay_001', reason: 'x', confirm: true })
    const [e] = await trail({ action: 'issueRefund' })
    expect(e).toMatchObject({ outcome: 'denied', errorCode: 'FORBIDDEN' })
  })

  it('stores no personal data from guest records', async () => {
    await signIn('u_bob')
    await call('createGuest', { name: 'Dana', email: 'dana@example.com', phone: '+1 555 0100' })
    const [e] = await trail({ action: 'createGuest' })
    expect(JSON.stringify(e)).not.toContain('dana@example.com')
    expect(JSON.stringify(e)).not.toContain('555 0100')
    expect(e.target).toMatchObject({ type: 'guest' })
  })

  it('the whole trail verifies', async () => {
    await signIn('u_alice')
    await call('getWaitTime', {})
    await call('nope', {})
    expect((await (await import('@/lib/audit')).verifyAuditChain()).ok).toBe(true)
  })
})

describe('auth events', () => {
  async function login(username: string, password: string) {
    const { POST } = await import('@/app/api/login/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return POST(new Request('http://localhost/api/login', { method: 'POST', body: JSON.stringify({ username, password }), headers: { 'x-forwarded-for': '203.0.113.9' } }) as any)
  }

  it('records failed and successful sign-ins, logout and role switch', async () => {
    await login('alice', 'wrong')
    const ok = await (await login('alice', 'password')).json()
    expect(ok.success).toBe(true)

    const { POST: switchRole } = await import('@/app/api/switch-role/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await switchRole(new Request('http://localhost/api/switch-role', { method: 'POST', body: JSON.stringify({ role: 'admin' }) }) as any)
    const { POST: logout } = await import('@/app/api/logout/route')
    await logout(new Request('http://localhost/api/logout', { method: 'POST' }))

    const events = (await trail({ category: 'auth' })).reverse()
    expect(events.map((e) => `${e.action}:${e.outcome}`)).toEqual([
      'auth.login:denied', 'auth.login:success', 'auth.role_switch:success', 'auth.logout:success',
    ])
    expect(events[0]).toMatchObject({ ip: '203.0.113.9', errorCode: 'INVALID_CREDENTIALS' })
    expect(JSON.stringify(events[0])).not.toContain('wrong') // the attempted password is never stored
    expect(events[2].output).toEqual({ fromRole: 'customer', toRole: 'admin' })
  })
})

describe('in-page ui_* reports', () => {
  async function report(body: unknown) {
    const { POST } = await import('@/app/api/audit/report/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return POST(new Request('http://localhost/api/audit/report', { method: 'POST', body: JSON.stringify(body) }) as any)
  }

  it('records an in-page UI write as a client-reported agent action', async () => {
    await signIn('u_alice')
    const res = await report({ operation: 'ui_set_state', input: { componentId: 'tasks.search', patch: { q: 'x' } }, success: true })
    expect(res.status).toBe(200)
    const [e] = await trail({ action: 'ui_set_state' })
    expect(e).toMatchObject({ reportedBy: 'client', actor: { type: 'agent', assurance: 'asserted' }, channel: 'webmcp' })
  })

  it('refuses reports of operations that run on the server', async () => {
    await signIn('u_alice')
    expect((await report({ operation: 'createReservation', input: {}, success: true })).status).toBe(400)
    expect(await trail({ action: 'createReservation' })).toHaveLength(0)
  })
})

describe('GET /api/audit (activity feed)', () => {
  it('shows a non-admin only the bare fact of other users\' calls', async () => {
    await signIn('u_bob')
    await call('getGuest', { guestId: 'g_001' })
    await signIn('u_alice')
    await call('getWaitTime', {})

    const { GET } = await import('@/app/api/audit/route')
    const feed = await (await GET()).json()
    const mine = feed.find((e: { operation: string }) => e.operation === 'getWaitTime')
    const bobs = feed.find((e: { operation: string }) => e.operation === 'getGuest')
    expect(mine.redacted).toBeUndefined()
    expect(mine.output).toBeDefined()
    expect(bobs).toMatchObject({ redacted: true, input: {} })
    expect(bobs.output).toBeUndefined()
  })
})
