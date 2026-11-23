// @vitest-environment node
// Contract: every operation's success `data` matches its declared outputSchema,
// with no undeclared fields (the published JSON Schema says additionalProperties:
// false). MCP rejects a non-conforming structuredContent outright, so this is
// the safety net for that surface.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { adminCtx } from '@/tests/helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let registry: any[]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let schema: any
let today: string
let yesterday: string
let tomorrow: string
let bugId: string

beforeEach(async () => {
  await import('@/lib/operations/index')
  registry = (await import('@/lib/operations/registry')).registry
  schema = await import('@/lib/schema')
  const seed = await import('@/lib/seed/store')
  today = seed.today()
  yesterday = seed.daysAgo(1)
  const d = new Date(`${today}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  tomorrow = d.toISOString().slice(0, 10)
  // Bug reports only enter the store through POST /api/bug-report, not an op —
  // seed one through the same submit path so the support.bugs ops have data.
  const { submitBugReport } = await import('@/lib/bugreport/submit')
  const { BUG_REPORT_FIXTURE } = await import('@/tests/fixtures/bugReport')
  const r = await submitBugReport({ id: 'u_alice', role: 'customer', displayName: 'Alice' }, JSON.stringify(BUG_REPORT_FIXTURE))
  if (!r.ok) throw new Error(r.message)
  bugId = r.report.id

  // admin.* ops: install the management service (server entry points do this)
  // and give it an audit event, a session, an agent client and some metrics.
  await import('@/lib/management/service')
  const { auditOperation } = await import('@/lib/audit')
  const { recordSession, recordClient, touch } = await import('@/lib/management/sessions')
  const { recordCallMetrics } = await import('@/lib/telemetry/metrics')
  const agent = { type: 'agent' as const, userId: 'u_alice', role: 'customer' as const, assurance: 'verified' as const, agent: { clientId: 'c_contract', name: 'Claude' } }
  const meta = { requestId: 'req_c', callId: 'call_c', channel: 'mcp' as const }
  await auditOperation({ operation: 'createReservation', input: { slotId: 'x' }, success: true, output: { reservation: { id: 'res_contract' } }, actor: agent, meta, durationMs: 3 })
  await recordSession({ sid: 's_contract', userId: 'u_alice', role: 'customer', startedAt: new Date().toISOString() })
  await touch('s_contract')
  await recordClient({ clientId: 'c_contract', userId: 'u_alice', role: 'customer', kind: 'connected', createdAt: new Date().toISOString() })
  await recordCallMetrics({ operation: 'createReservation', permission: 'write', success: true, actor: agent, meta, durationMs: 3, startedAt: Date.now() })
})

afterEach(() => {
  stopFakePage?.()
  stopFakePage = undefined
})

let stopFakePage: (() => void) | undefined

/** A stand-in browser tab for the ui_* ops: publishes one table component to the
 *  relay as adminCtx's user and answers relayed commands, like lib/ui-relay/client.ts. */
async function startFakePage() {
  const { z } = await import('zod')
  const { UiComponentRegistry } = await import('@/lib/ui-components/registry')
  const { tableStateSchema } = await import('@/lib/ui-components/kinds')
  const relay = await import('@/lib/ui-relay/store')
  const reg = new UiComponentRegistry()
  let state: Record<string, unknown> = { filters: {}, sort: [] }
  reg.register({
    id: 'demo.table', kind: 'table', title: 'Demo',
    schema: tableStateSchema({ status: z.enum(['open', 'done']).optional().describe('Status') }, ['title'] as const) as never,
    getState: () => state, setState: (s) => { state = s },
    actions: { reset: { description: 'Reset', run: (_a, set) => set({ filters: {}, sort: [] }) } },
    getView: () => ({ total: 3, shown: 3 }),
  })
  const publish = () => relay.putSnapshot(adminCtx.userId, { tabId: 'tab_test', activeTab: 'tasks', visible: true, focusedAt: Date.now(), components: reg.list() })
  await publish()
  const timer = setInterval(async () => {
    for (const cmd of await relay.claimCommands(adminCtx.userId, 'tab_test')) {
      await relay.putResult(adminCtx.userId, cmd.cmdId, await reg.applyCommand(cmd))
      await publish()
    }
  }, 10)
  return () => clearInterval(timer)
}

type Args = Record<string, unknown>
/** One or more happy-path calls per op. `setup` runs other ops first, in the same fresh store. */
type Case = { args: () => Args; setup?: [string, () => Args][] }

const CASES: Record<string, Case[]> = {
  // navigation & meta
  explore: [
    { args: () => ({}) },
    { args: () => ({ path: 'reservation' }) },
    { args: () => ({ path: 'reservation.*' }) },
    { args: () => ({ path: ['reservation.booking', 'finance.*', 'nope'] }) },
  ],
  search: [{ args: () => ({ pattern: 'reservation' }) }],
  describe_tool: [
    { args: () => ({ name: 'getGuest' }) },
    { args: () => ({ name: ['getGuest', 'noSuchTool'] }) },
  ],
  invoke: [
    { args: () => ({ name: 'getGuest', args: { guestId: 'g_001' } }) },
    { args: () => ({ calls: [{ name: 'getGuest', args: { guestId: 'g_001' } }, { name: 'getGuest', args: { guestId: 'missing' } }] }) },
  ],
  load_tools: [{ args: () => ({ names: ['getGuest', 'explore', 'noSuchTool'] }) }],
  unload_tools: [{ args: () => ({ names: ['getGuest'] }) }],
  getContext: [{ args: () => ({}) }],
  getCapabilities: [{ args: () => ({}) }],
  // UI components — served by startFakePage() below
  ui_list: [{ args: () => ({}) }, { args: () => ({ kind: 'table' }) }],
  ui_get_state: [{ args: () => ({ componentId: 'demo.table' }) }],
  ui_set_state: [{ args: () => ({ componentId: 'demo.table', patch: { filters: { status: 'open' } } }) }],
  ui_action: [{ args: () => ({ componentId: 'demo.table', action: 'reset' }) }],
  // reservation
  searchAvailability: [{ args: () => ({ date: tomorrow, partySize: 2 }) }],
  createReservation: [{ args: () => ({ slotId: `slot_${tomorrow}_1800`, name: 'Dana', partySize: 2 }) }],
  cancelReservation: [{
    setup: [['createReservation', () => ({ slotId: `slot_${tomorrow}_1800`, name: 'Dana', partySize: 2 })]],
    args: () => ({ reservationId: '$last.reservation.id', confirm: true }),
  }],
  listReservations: [{ args: () => ({}) }],
  getReservation: [{
    setup: [['createReservation', () => ({ slotId: `slot_${tomorrow}_1800`, name: 'Dana', partySize: 2 })]],
    args: () => ({ reservationId: '$last.reservation.id' }),
  }],
  listAllReservations: [{ args: () => ({}) }],
  cancelAnyReservation: [{ args: () => ({ reservationId: 'res_002', confirm: true }) }],
  book: [{ args: () => ({ date: tomorrow, time: '18:00', partySize: 2, name: 'Dana' }) }],
  // CRM
  searchGuests: [{ args: () => ({ query: 'a' }) }],
  getGuest: [{ args: () => ({ guestId: 'g_001' }) }],
  createGuest: [{ args: () => ({ name: 'Dana R', email: 'dana@example.com', phone: '+1-555-0999' }) }],
  updateGuest: [{ args: () => ({ guestId: 'g_001', phone: '+1-555-1111' }) }],
  getGuestPreferences: [{ args: () => ({ guestId: 'g_001' }) }, { args: () => ({ guestId: 'g_004' }) }],
  updateGuestPreferences: [{ args: () => ({ guestId: 'g_004', specialNotes: 'Likes jazz' }) }],
  getLoyaltyStatus: [{ args: () => ({ guestId: 'g_001' }) }],
  addLoyaltyPoints: [{ args: () => ({ guestId: 'g_004', points: 5000, reason: 'Anniversary dinner' }) }],
  listCommunications: [{ args: () => ({ guestId: 'g_001' }) }],
  logCommunication: [{ args: () => ({ guestId: 'g_001', type: 'note', subject: 'Hi', body: 'Called back' }) }],
  // front office
  checkInGuest: [{ args: () => ({ reservationId: 'res_003', tableId: 't_03' }) }],
  getCheckinStatus: [{ args: () => ({ reservationId: 'res_001' }) }, { args: () => ({ reservationId: 'res_003' }) }],
  checkOutGuest: [{ args: () => ({ reservationId: 'res_001', confirm: true }) }],
  getBillSummary: [
    { args: () => ({ reservationId: 'res_001' }) },
    { setup: [['checkOutGuest', () => ({ reservationId: 'res_001', confirm: true })]], args: () => ({ reservationId: 'res_001' }) },
  ],
  getOccupancy: [{ args: () => ({}) }],
  getWaitTime: [{ args: () => ({ partySize: 2 }) }, { args: () => ({ partySize: 20 }) }],
  listFrontDeskReservations: [{ args: () => ({}) }],
  listShiftNotes: [{ args: () => ({}) }],
  addShiftNote: [{ args: () => ({ note: 'POS ok', author: 'carol' }) }],
  seatGuest: [{ args: () => ({ reservationId: 'res_003' }) }],
  hostVipGuest: [{ args: () => ({ reservationId: 'res_003', guestId: 'g_003', pointsToAward: 100, visitNote: 'Anniversary' }) }],
  // tasks
  createTask: [{ args: () => ({ title: 'Fix lamp', department: 'maintenance', priority: 'low', reservationId: 'res_002' }) }],
  updateTask: [{ args: () => ({ taskId: 'task_001', status: 'in_progress' }) }],
  searchTasks: [{ args: () => ({ department: 'housekeeping' }) }],
  deleteTask: [{ args: () => ({ taskId: 'task_003', confirm: true }) }],
  getMyTasks: [{ args: () => ({}) }],
  completeTask: [{ args: () => ({ taskId: 'task_002' }) }],
  // housekeeping
  getTableCleaningStatus: [{ args: () => ({}) }],
  updateTableStatus: [{ args: () => ({ tableId: 't_01', status: 'dirty', updatedBy: 'staff_maria' }) }],
  getTodaySchedule: [{ args: () => ({}) }],
  markScheduleItemDone: [{ args: () => ({ scheduleId: 'sched_002' }) }],
  listInspections: [{ args: () => ({}) }],
  logInspection: [{ args: () => ({ tableId: 't_01', inspector: 'admin_paula', result: 'pass', notes: 'Clean' }) }],
  // finance
  getDailyRevenueSummary: [{ args: () => ({ date: yesterday }) }],
  getWeeklyRevenueSummary: [{ args: () => ({ weekStartDate: yesterday }) }],
  getPaymentRecord: [{ args: () => ({ paymentId: 'pay_001' }) }],
  listPayments: [{ args: () => ({ date: yesterday }) }, { args: () => ({ date: today, method: 'cash' }) }],
  issueRefund: [{ args: () => ({ paymentId: 'pay_001', reason: 'Cold food', amount: 10, confirm: true }) }],
  applyNoShowFee: [{ args: () => ({ reservationId: 'res_002', feeAmount: 25, reason: 'Did not show up', confirm: true }) }],
  logManualAdjustment: [{ args: () => ({ amount: -15, reason: 'Comp dessert', reasonCode: 'COMP' }) }],
  // support
  listBugReports: [{ args: () => ({}) }, { args: () => ({ status: 'open' }) }],
  getBugReport: [{ args: () => ({ id: bugId }) }],
  updateBugReportStatus: [{ args: () => ({ id: bugId, status: 'triaged' }) }],
  // admin / management (data seeded in beforeEach)
  queryAudit: [{ args: () => ({}) }, { args: () => ({ actorType: 'agent', limit: 5 }) }],
  getEntityHistory: [{ args: () => ({ type: 'reservation', id: 'res_contract' }) }, { args: () => ({ type: 'guest', id: 'g_none' }) }],
  verifyAuditChain: [{ args: () => ({}) }],
  getUsageMetrics: [{ args: () => ({}) }],
  listUserSessions: [{ args: () => ({}) }, { args: () => ({ connectedOnly: true }) }],
  listAgentClients: [{ args: () => ({}) }],
  revokeAgentClient: [{ args: () => ({ clientId: 'c_contract', confirm: true }) }],
  revokeSession: [{ args: () => ({ sessionId: 's_contract', confirm: true }) }],
}

/** Resolve "$last.a.b" placeholders against the previous step's data. */
function resolve(args: Args, last: unknown): Args {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => {
    if (typeof v === 'string' && v.startsWith('$last.')) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return [k, v.slice(6).split('.').reduce((o: any, p) => o?.[p], last)]
    }
    return [k, v]
  }))
}

async function run(name: string, args: Args) {
  const op = registry.find((o) => o.name === name)
  const input = schema.inputObject(op.inputSchema).parse(args)
  return op.handler(input, adminCtx)
}

describe('every operation has a contract case', () => {
  it('CASES covers the whole registry (add a case when you add an op)', () => {
    expect(Object.keys(CASES).sort()).toEqual(registry.map((o) => o.name).sort())
  })

  it('every operation declares an object outputSchema shape', () => {
    for (const op of registry) {
      expect(op.outputSchema, op.name).toBeTypeOf('object')
    }
  })
})

describe('success data matches outputSchema exactly', () => {
  for (const [name, cases] of Object.entries(CASES)) {
    cases.forEach((c, i) => {
      it(`${name} #${i + 1}`, async () => {
        let last: unknown
        if (name.startsWith('ui_')) stopFakePage = await startFakePage()
        for (const [setupOp, setupArgs] of c.setup ?? []) {
          const r = await run(setupOp, setupArgs())
          expect(r.success, `setup ${setupOp}: ${JSON.stringify(r.error)}`).toBe(true)
          last = r.data
        }
        const result = await run(name, resolve(c.args(), last))
        expect(result.success, JSON.stringify(result.error)).toBe(true)

        const op = registry.find((o) => o.name === name)
        const wire = JSON.parse(JSON.stringify(result.data))
        const parsed = schema.outputObject(op.outputSchema).safeParse(wire)
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
        // Zod strips undeclared keys, so any difference here is a field the schema doesn't declare.
        expect(parsed.data).toEqual(wire)
      })
    })
  }
})
