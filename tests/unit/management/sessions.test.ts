// @vitest-environment node
// Human sessions and agent clients: identity, revocation, and liveness.
// Runs on the in-memory fallback (no REDIS_URL), like the rest of the suite.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { jar } = vi.hoisted(() => ({ jar: new Map<string, string>() }))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value) },
    delete: (name: string) => { jar.delete(name) },
  }),
}))

beforeEach(() => {
  jar.clear()
  delete process.env.DEMO_MODE
})

async function alice() {
  return (await import('@/lib/auth')).getUserById('u_alice')!
}

function cookieStore() {
  return {
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value) },
    delete: (name: string) => { jar.delete(name) },
  }
}

describe('session and token claims', () => {
  it('a session cookie carries its session id; a role switch can keep it', async () => {
    const { createSession, sessionForCookie, newSessionId } = await import('@/lib/auth-tokens')
    const sid = newSessionId()
    const user = await alice()
    expect(sessionForCookie(createSession(user, sid))?.sid).toBe(sid)
    const switched = sessionForCookie(createSession({ ...user, role: 'admin' }, sid))
    expect(switched).toMatchObject({ sid, user: { role: 'admin' } })
  })

  it('tokens of two agent clients of the same user differ and name their client', async () => {
    const { issueToken, claimsForToken, newClientId } = await import('@/lib/auth-tokens')
    const user = await alice()
    const a = newClientId()
    const b = newClientId()
    const ta = issueToken(user, { clientId: a, sid: 's_x' })
    const tb = issueToken(user, { clientId: b, sid: 's_x' })
    expect(ta).not.toBe(tb)
    expect(claimsForToken(ta)).toMatchObject({ clientId: a, sid: 's_x', user: { id: 'u_alice' } })
    expect(claimsForToken(tb)?.clientId).toBe(b)
  })

  it('the per-session default client is stable for that session and role', async () => {
    const { issueToken, claimsForToken } = await import('@/lib/auth-tokens')
    const user = await alice()
    expect(issueToken(user, { sid: 's_one' })).toBe(issueToken(user, { sid: 's_one' }))
    expect(claimsForToken(issueToken(user, { sid: 's_one' }))?.clientId)
      .not.toBe(claimsForToken(issueToken(user, { sid: 's_two' }))?.clientId)
  })
})

describe('authenticateSession', () => {
  it('a logged-out session is rejected even with a validly signed cookie, and the cookie is cleared', async () => {
    const { createSession, newSessionId } = await import('@/lib/auth-tokens')
    const { SESSION_COOKIE } = await import('@/lib/constants')
    const { authenticateSession, endSession } = await import('@/lib/management/auth')
    const sid = newSessionId()
    jar.set(SESSION_COOKIE, createSession(await alice(), sid))

    expect((await authenticateSession(cookieStore())).user?.id).toBe('u_alice')
    await endSession(sid, 'logout', 'u_alice')
    const after = await authenticateSession(cookieStore())
    expect(after.user).toBeNull()
    expect(after).toMatchObject({ reason: 'SESSION_ENDED' })
    expect(jar.has(SESSION_COOKIE)).toBe(false)
  })

  it('records the session with request info and lists it as connected', async () => {
    const { createSession, newSessionId } = await import('@/lib/auth-tokens')
    const { SESSION_COOKIE } = await import('@/lib/constants')
    const { authenticateSession } = await import('@/lib/management/auth')
    const { listSessions } = await import('@/lib/management/sessions')
    const sid = newSessionId()
    jar.set(SESSION_COOKIE, createSession(await alice(), sid))
    await authenticateSession(cookieStore(), { ip: '203.0.113.7', userAgent: 'Firefox' })
    const [s] = await listSessions({ userId: 'u_alice' })
    expect(s).toMatchObject({ sid, userId: 'u_alice', ip: '203.0.113.7', userAgent: 'Firefox', connected: true })
  })

  it('a revocation is not downgraded by a later logout', async () => {
    const { endSession } = await import('@/lib/management/auth')
    const { getEnd } = await import('@/lib/management/sessions')
    await endSession('s_abc', 'revoked', 'u_bob')
    await endSession('s_abc', 'logout', 'u_alice')
    expect(await getEnd('s_abc')).toMatchObject({ reason: 'revoked', by: 'u_bob' })
  })
})

describe('authenticateAgentToken', () => {
  it('rejects a revoked client but not other clients of the same user', async () => {
    const { issueToken, newClientId } = await import('@/lib/auth-tokens')
    const { authenticateAgentToken, revokeClient } = await import('@/lib/management/auth')
    const user = await alice()
    const keep = issueToken(user, { clientId: newClientId() })
    const revokeMe = newClientId()
    const gone = issueToken(user, { clientId: revokeMe })
    await revokeClient(revokeMe, 'u_alice')
    expect(await authenticateAgentToken(gone)).toBeNull()
    expect(await authenticateAgentToken(keep)).not.toBeNull()
  })

  it('logging out does not disconnect agents; an admin revoking the session does', async () => {
    const { issueToken } = await import('@/lib/auth-tokens')
    const { authenticateAgentToken, endSession } = await import('@/lib/management/auth')
    const user = await alice()
    const t1 = issueToken(user, { sid: 's_logout' })
    await endSession('s_logout', 'logout', 'u_alice')
    expect(await authenticateAgentToken(t1)).not.toBeNull()

    const t2 = issueToken(user, { sid: 's_revoked' })
    await endSession('s_revoked', 'revoked', 'u_bob')
    expect(await authenticateAgentToken(t2)).toBeNull()
  })

  it('registers the client on first use, with its agent software', async () => {
    const { issueToken } = await import('@/lib/auth-tokens')
    const { authenticateAgentToken } = await import('@/lib/management/auth')
    const { listClients, noteAgentSoftware } = await import('@/lib/management/sessions')
    const claims = await authenticateAgentToken(issueToken(await alice(), { sid: 's_q' }))
    await noteAgentSoftware(claims!.clientId, 'claude-desktop', '1.2.3')
    const [c] = await listClients({ userId: 'u_alice' })
    expect(c).toMatchObject({
      clientId: claims!.clientId, kind: 'default', sid: 's_q',
      agentName: 'claude-desktop', agentVersion: '1.2.3', connected: true,
    })
  })
})

describe('/api/agent-clients', () => {
  async function signIn() {
    const { createSession, newSessionId } = await import('@/lib/auth-tokens')
    const { SESSION_COOKIE } = await import('@/lib/constants')
    jar.set(SESSION_COOKIE, createSession(await alice(), newSessionId()))
  }
  function req(method: string, body?: unknown) {
    return new Request('http://localhost/api/agent-clients', { method, body: body ? JSON.stringify(body) : undefined })
  }

  it('mints a labelled client, lists it, and revokes it', async () => {
    await signIn()
    const route = await import('@/app/api/agent-clients/route')
    const { authenticateAgentToken } = await import('@/lib/management/auth')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = await (await route.POST(req('POST', { label: 'Claude Desktop' }) as any)).json()
    expect(created.success).toBe(true)
    expect(await authenticateAgentToken(created.agentToken)).not.toBeNull()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listed = await (await route.GET(req('GET') as any)).json()
    expect(listed.clients).toEqual([expect.objectContaining({ clientId: created.clientId, label: 'Claude Desktop', kind: 'connected' })])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await route.DELETE(req('DELETE', { clientId: created.clientId }) as any)).status).toBe(200)
    expect(await authenticateAgentToken(created.agentToken)).toBeNull()
  })

  it("can't revoke someone else's client", async () => {
    const { recordClient } = await import('@/lib/management/sessions')
    await recordClient({ clientId: 'c_bobs', userId: 'u_bob', role: 'admin', kind: 'connected', createdAt: new Date().toISOString() })
    await signIn()
    const route = await import('@/app/api/agent-clients/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await route.DELETE(req('DELETE', { clientId: 'c_bobs' }) as any)).status).toBe(404)
  })
})
