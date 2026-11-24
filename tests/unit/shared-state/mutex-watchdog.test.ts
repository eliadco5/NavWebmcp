// @vitest-environment node
// One request that never finishes must not wedge every later request: the
// state lock's watchdog hands the lock on (lib/shared-state/mutex.ts). Found by
// scripts/credits-stress.mjs: a malformed MCP body hung inside the lock and
// made /api/call unreachable for everyone on the instance.
import { describe, it, expect, afterEach } from 'vitest'

afterEach(() => { delete process.env.STATE_LOCK_MAX_MS })

describe('withStateLock watchdog', () => {
  it('a request that never settles releases the lock after STATE_LOCK_MAX_MS', async () => {
    process.env.STATE_LOCK_MAX_MS = '200'
    const { withStateLock } = await import('@/lib/shared-state/mutex')
    void withStateLock(() => new Promise(() => {})) // hangs forever
    const t0 = Date.now()
    const v = await withStateLock(async () => 'next')
    expect(v).toBe('next')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150)
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('normal requests still run strictly one at a time', async () => {
    const { withStateLock } = await import('@/lib/shared-state/mutex')
    let inside = 0
    let maxInside = 0
    await Promise.all(Array.from({ length: 20 }, () => withStateLock(async () => {
      inside++
      maxInside = Math.max(maxInside, inside)
      await new Promise((r) => setTimeout(r, 2))
      inside--
    })))
    expect(maxInside).toBe(1)
  })

  it('a rejected request does not block the next', async () => {
    const { withStateLock } = await import('@/lib/shared-state/mutex')
    await expect(withStateLock(async () => { throw new Error('x') })).rejects.toThrow('x')
    expect(await withStateLock(async () => 1)).toBe(1)
  })

  it('isStateLockHeld is false once the watchdog has moved on', async () => {
    process.env.STATE_LOCK_MAX_MS = '100'
    const { withStateLock, isStateLockHeld } = await import('@/lib/shared-state/mutex')
    let heldLater: boolean | undefined
    void withStateLock(async () => {
      await new Promise((r) => setTimeout(r, 300))
      heldLater = isStateLockHeld()
    })
    await withStateLock(async () => undefined)
    await new Promise((r) => setTimeout(r, 300))
    expect(heldLater).toBe(false)
  })
})
