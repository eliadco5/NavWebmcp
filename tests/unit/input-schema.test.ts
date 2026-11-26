// @vitest-environment node
// Guards on how every operation's input/output schema is built and enforced.
// See the "Input schema audit" in the 1.1.0 CHANGELOG entry for why each exists.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { adminCtx } from '@/tests/helpers'

// The jar is hoisted so the /api/call test can put a signed-in session in it —
// login is required, so a cookie-less call would stop at 401 before validation.
const { jar } = vi.hoisted(() => ({ jar: new Map<string, string>() }))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value) },
  }),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let registry: any[]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let schema: any
beforeEach(async () => {
  await import('@/lib/operations/index')
  registry = (await import('@/lib/operations/registry')).registry
  schema = await import('@/lib/schema')
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walk(node: any, path: string, visit: (n: any, p: string) => void) {
  if (!node || typeof node !== 'object') return
  visit(node, path)
  for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k}`, visit)
}

describe('published JSON Schemas', () => {
  // Since the MCP SDK v2 (2.4.0), MCP publishes toJsonSchema()'s output itself, so
  // the two surfaces can't drift; tests/unit/mcp-adapter.test.ts checks tools/list.

  it('no schema contains a $ref', () => {
    for (const op of registry) {
      for (const [kind, s] of [['input', schema.inputObject(op.inputSchema)], ['output', schema.outputObject(op.outputSchema)]]) {
        const json = schema.toJsonSchema(s)
        walk(json, '', (n, p) => expect(n.$ref, `${op.name} ${kind}${p}`).toBeUndefined())
      }
    }
  })

  it('every input field has a description', () => {
    for (const op of registry) {
      const json = schema.toJsonSchema(schema.inputObject(op.inputSchema))
      for (const [field, def] of Object.entries(json.properties ?? {})) {
        expect((def as { description?: string }).description, `${op.name}.${field}`).toBeTruthy()
      }
    }
  })

  it('every input string is bounded (maxLength, pattern, format or enum)', () => {
    const unbounded: string[] = []
    for (const op of registry) {
      walk(schema.toJsonSchema(schema.inputObject(op.inputSchema)), op.name, (n, p) => {
        if (n.type === 'string' && n.maxLength === undefined && !n.pattern && !n.format && !n.enum) unbounded.push(p)
      })
    }
    expect(unbounded).toEqual([])
  })

  it('every input object rejects additional properties', () => {
    for (const op of registry) {
      walk(schema.toJsonSchema(schema.inputObject(op.inputSchema)), op.name, (n, p) => {
        if (n.type === 'object' && n.properties) expect(n.additionalProperties, p).toBe(false)
      })
    }
  })
})

describe('unknown input keys are rejected, not silently dropped', () => {
  // "specialNote" is a typo of the real optional field "specialNotes".
  const typo = { guestId: 'g_001', specialNote: 'Window seat please' }

  it('inputObject()', () => {
    const op = registry.find((o) => o.name === 'updateGuestPreferences')
    const r = schema.inputObject(op.inputSchema).safeParse(typo)
    expect(r.success).toBe(false)
    expect(r.error.issues[0].code).toBe('unrecognized_keys')
  })

  it('dispatch (invoke / composites)', async () => {
    const { runOne } = await import('@/lib/operations/dispatch')
    const r = await runOne('updateGuestPreferences', typo, adminCtx)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.code).toBe('INVALID_INPUT')
      expect(r.error.message).toMatch(/specialNote/)
    }
  })

  it('POST /api/call (UI and in-page agent)', async () => {
    const { createSession } = await import('@/lib/auth-tokens')
    const { getUserById, SESSION_COOKIE } = await import('@/lib/auth')
    jar.set(SESSION_COOKIE, createSession(getUserById('u_bob')!))
    const { POST } = await import('@/app/api/call/route')
    const req = new Request('http://localhost/api/call', {
      method: 'POST',
      body: JSON.stringify({ name: 'updateGuestPreferences', params: typo }),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await (await POST(req as any)).json()
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('INVALID_INPUT')
  })

  it('nothing was written by the rejected calls', async () => {
    const { runOne } = await import('@/lib/operations/dispatch')
    await runOne('updateGuestPreferences', typo, adminCtx)
    const r = await runOne('getGuestPreferences', { guestId: 'g_001' }, adminCtx)
    expect(r.success && (r.data as { preferences: { specialNotes: string } }).preferences.specialNotes)
      .toBe('Prefers quiet seating away from the bar')
  })
})

describe('tightened fields', () => {
  it.each([
    ['getDailyRevenueSummary', 'a non-ISO date', { date: '2026/07/07' }],
    ['listPayments', 'a non-ISO date', { date: 'yesterday' }],
    ['getWeeklyRevenueSummary', 'a non-ISO date', { weekStartDate: '07-07-2026' }],
    ['book', 'a non-HH:MM time', { date: '2026-07-07', time: '6pm', partySize: 2, name: 'Dana' }],
    ['getGuest', 'an empty id', { guestId: '' }],
    ['issueRefund', 'an amount over the cap', { paymentId: 'pay_001', reason: 'Cold food', amount: 1_000_000, confirm: true }],
    ['logCommunication', 'a body over 2000 chars', { guestId: 'g_001', type: 'note', subject: 'x', body: 'y'.repeat(2001) }],
  ])('%s rejects %s', (name, _why, args) => {
    const op = registry.find((o) => o.name === name)
    expect(schema.inputObject(op.inputSchema).safeParse(args).success).toBe(false)
  })

  it('confirm: false still reaches the handler and returns CONFIRMATION_REQUIRED', async () => {
    const { runOne } = await import('@/lib/operations/dispatch')
    const r = await runOne('deleteTask', { taskId: 'task_003', confirm: false }, adminCtx)
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.code).toBe('CONFIRMATION_REQUIRED')
  })
})
