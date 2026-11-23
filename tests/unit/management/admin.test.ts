// @vitest-environment node
// The admin surface: /api/admin/* and the admin.* operations. Access is admin
// only (and denials are audited), "who created this record?" is answerable by
// an agent, and revocations really disconnect.
import { describe, it, expect, beforeEach, vi } from 'vitest'
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

async function get(path: string) {
  const mod = await import(`@/app/api/admin/${path.split('?')[0]}/route`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { NextRequest } = await import('next/server') as any
  return mod.GET(new NextRequest(`http://localhost/api/admin/${path}`))
}

async function call(name: string, params: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import('@/app/api/call/route')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await POST(new Request('http://localhost/api/call', { method: 'POST', body: JSON.stringify({ name, params }), headers }) as any)).json()
}

describe('access control', () => {
  it.each(['audit', 'audit/verify', 'audit/export', 'metrics', 'sessions', 'clients', 'health', 'users'])(
    'GET /api/admin/%s is 403 for non-admins and 401 signed out', async (path) => {
      expect((await get(path)).status).toBe(401)
      await signIn('u_carol') // support
      expect((await get(path)).status).toBe(403)
      await signIn('u_bob') // admin
      expect((await get(path)).status).toBe(200)
    })

  it('a denied admin request is itself in the audit trail', async () => {
    await signIn('u_alice')
    await get('audit')
    const { queryAudit } = await import('@/lib/audit')
    const [e] = (await queryAudit({ category: 'admin', outcome: 'denied' })).events
    expect(e).toMatchObject({ action: 'admin.audit_query', errorCode: 'FORBIDDEN', actor: { userId: 'u_alice' } })
  })

  it('admin.* operations are not available to non-admins', async () => {
    await signIn('u_carol')
    const r = await call('getEntityHistory', { type: 'reservation', id: 'x' })
    expect(r.error.code).toBe('FORBIDDEN')
  })
})

describe('"who created this reservation?" — asked by an admin\'s agent', () => {
  it('getEntityHistory names the agent that created it and through which surface', async () => {
    await signIn('u_alice')
    const booked = await call('book', { date: '2026-07-07', time: '18:00', partySize: 2, name: 'Dana' }, { 'x-navwebmcp-channel': 'webmcp', 'x-navwebmcp-agent': 'Gemini' })
    const resId = booked.data.reservation.id

    await signIn('u_bob')
    const h = await call('getEntityHistory', { type: 'reservation', id: resId }, { 'x-navwebmcp-channel': 'webmcp' })
    expect(h.success).toBe(true)
    expect(h.data.createdBy).toMatchObject({ actorType: 'agent', userId: 'u_alice', channel: 'webmcp', agentName: 'Gemini', action: 'createReservation' })
    expect(h.data.createdBy.auditId).toBe(booked.data.reservation.createdBy.auditId)
    // The admin's own lookup isn't mistaken for an event ON the reservation.
    expect(h.data.events.every((e: { action: string }) => e.action !== 'getEntityHistory')).toBe(true)
  })

  it('queryAudit filters by actor type over the API', async () => {
    await signIn('u_alice')
    await call('getWaitTime', {}, { 'x-navwebmcp-channel': 'ui' })
    await call('getWaitTime', {}, { 'x-navwebmcp-channel': 'webmcp' })
    await signIn('u_bob')
    const body = await (await get('audit?actorType=agent&action=getWaitTime')).json()
    expect(body.data.events).toHaveLength(1)
    expect(body.data.events[0].channel).toBe('webmcp')
  })

  it('getUsageMetrics reports the human/agent split', async () => {
    await signIn('u_alice')
    await call('getWaitTime', {}, { 'x-navwebmcp-channel': 'ui' })
    await call('getWaitTime', {}, { 'x-navwebmcp-channel': 'webmcp' })
    await signIn('u_bob')
    const m = await call('getUsageMetrics', {})
    expect(m.data.byActorType.agent.calls).toBeGreaterThanOrEqual(1)
    expect(m.data.byActorType.human.calls).toBeGreaterThanOrEqual(1)
  })
})

describe('revocation', () => {
  it('revokeAgentClient disconnects that agent only, and is audited', async () => {
    const { issueToken, newClientId } = await import('@/lib/auth-tokens')
    const { getUserById } = await import('@/lib/auth')
    const { authenticateAgentToken } = await import('@/lib/management/auth')
    const alice = getUserById('u_alice')!
    const a = newClientId(), b = newClientId()
    const ta = issueToken(alice, { clientId: a }), tb = issueToken(alice, { clientId: b })
    await authenticateAgentToken(ta) // first use registers the clients
    await authenticateAgentToken(tb)

    await signIn('u_bob')
    const r = await call('revokeAgentClient', { clientId: a, confirm: true })
    expect(r.data).toEqual({ clientId: a, revoked: true })
    expect(await authenticateAgentToken(ta)).toBeNull()
    expect(await authenticateAgentToken(tb)).not.toBeNull()

    const { queryAudit } = await import('@/lib/audit')
    expect((await queryAudit({ action: 'admin.agent_client_revoked' })).events[0]).toMatchObject({ actor: { userId: 'u_bob' }, target: { type: 'agentClient', id: a } })
  })

  it('revoking a logged-out session still disconnects the agents it authorised', async () => {
    const { issueToken } = await import('@/lib/auth-tokens')
    const { getUserById } = await import('@/lib/auth')
    const { authenticateAgentToken, endSession, startSession } = await import('@/lib/management/auth')
    const alice = getUserById('u_alice')!
    await startSession('s_old', alice)
    const token = issueToken(alice, { sid: 's_old' })
    await endSession('s_old', 'logout', 'u_alice')
    expect(await authenticateAgentToken(token)).not.toBeNull() // logout keeps agents

    await signIn('u_bob')
    const r = await call('revokeSession', { sessionId: 's_old', confirm: true })
    expect(r.data).toEqual({ sessionId: 's_old', revoked: true })
    expect(await authenticateAgentToken(token)).toBeNull()
  })

  it('unknown ids are NOT_FOUND', async () => {
    await signIn('u_bob')
    expect((await call('revokeAgentClient', { clientId: 'c_nope', confirm: true })).error.code).toBe('NOT_FOUND')
  })
})

describe('export', () => {
  it('CSV is oldest first, defuses formula injection, and the export is audited', async () => {
    const { auditOperation } = await import('@/lib/audit')
    const actor: Actor = { type: 'agent', userId: 'u_alice', role: 'customer', assurance: 'verified', agent: { clientId: 'c_1', name: '=HYPERLINK("x")' } }
    await auditOperation({ operation: 'getWaitTime', input: {}, success: true, actor, meta: { requestId: 'r', callId: 'c1', channel: 'mcp' } })
    await auditOperation({ operation: 'getOccupancy', input: {}, success: true, actor, meta: { requestId: 'r', callId: 'c2', channel: 'mcp' } })
    await signIn('u_bob')
    const res = await get('audit/export?format=csv&category=operation')
    expect(res.headers.get('content-type')).toContain('text/csv')
    const lines = (await res.text()).trim().split('\n')
    expect(lines[0].startsWith('seq,ts,category,action')).toBe(true)
    expect(lines[1]).toContain('getWaitTime')
    expect(lines[2]).toContain('getOccupancy')
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`)
    const { queryAudit } = await import('@/lib/audit')
    expect((await queryAudit({ action: 'admin.audit_export' })).events[0].output).toMatchObject({ format: 'csv', events: 2 })
  })
})

describe('health', () => {
  it('warns when running without durable storage or an export sink', async () => {
    await signIn('u_bob')
    const h = await (await get('health')).json()
    expect(h.data.audit.durable).toBe(false)
    expect(h.data.warnings.join(' ')).toMatch(/REDIS_URL is not set/)
    expect(h.data.warnings.join(' ')).toMatch(/No audit export sink/)
  })
})
