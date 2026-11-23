// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'
import crypto from 'node:crypto'
import { runAuditSinks, webhookSink, otlpLogsSink, type AuditSink } from '@/lib/audit/sinks'
import { link } from '@/lib/audit/chain'
import type { AuditEvent } from '@/lib/audit/types'

const event: AuditEvent = link({
  v: 1, id: 'e1', ts: '2026-11-23T10:00:00.000Z', category: 'operation', action: 'createReservation',
  outcome: 'success', channel: 'mcp', target: { type: 'reservation', id: 'res_9' },
  actor: { type: 'agent', userId: 'u_alice', role: 'customer', assurance: 'verified', agent: { clientId: 'c_1', name: 'Claude' } },
}, { seq: 0, hash: '' })

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.AUDIT_WEBHOOK_URL
  delete process.env.AUDIT_WEBHOOK_SECRET
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
})

describe('audit sinks', () => {
  it('a failing sink is reported, never thrown, and later sinks still run', async () => {
    const ran: string[] = []
    const bad: AuditSink = { name: 'bad', enabled: () => true, send: async () => { throw new Error('down') } }
    const good: AuditSink = { name: 'good', enabled: () => true, send: async () => { ran.push('good') } }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await runAuditSinks([event], [bad, good])).toEqual([
      { sink: 'bad', ok: false, error: 'down' },
      { sink: 'good', ok: true },
    ])
    expect(ran).toEqual(['good'])
    warn.mockRestore()
  })

  it('built-in sinks are off unless configured', () => {
    expect(webhookSink.enabled()).toBe(false)
    expect(otlpLogsSink.enabled()).toBe(false)
  })

  it('the webhook signs its body', async () => {
    process.env.AUDIT_WEBHOOK_URL = 'https://siem.example/ingest'
    process.env.AUDIT_WEBHOOK_SECRET = 's3cret'
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    await webhookSink.send([event])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://siem.example/ingest')
    const sig = (init.headers as Record<string, string>)['x-navwebmcp-signature']
    expect(sig).toBe(crypto.createHmac('sha256', 's3cret').update(init.body as string).digest('hex'))
  })

  it('OTLP logs carry actor type, agent and target as attributes', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.example/'
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await otlpLogsSink.send([event])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://otel.example/v1/logs')
    const attrs = JSON.parse(init.body as string).resourceLogs[0].scopeLogs[0].logRecords[0].attributes
    const get = (k: string) => attrs.find((a: { key: string }) => a.key === k)?.value
    expect(get('navwebmcp.actor.type')).toEqual({ stringValue: 'agent' })
    expect(get('gen_ai.agent.name')).toEqual({ stringValue: 'Claude' })
    expect(get('navwebmcp.target.id')).toEqual({ stringValue: 'res_9' })
  })
})
