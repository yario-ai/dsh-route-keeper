import { describe, expect, it } from 'vitest'
import { createCooldowns, markModelFailed, isModelInCooldown, clearModelCooldown, cooldownPredicate, formatRemaining } from '../lib/cooldown.js'

const policy = { baseMs: 60_000, maxMs: 6 * 60 * 60_000 }
const route = { provider: 'p', model: 'm' }

describe('cooldown', () => {
  it('marks a route into cooldown with bounded exponential backoff', () => {
    const c = createCooldowns()
    markModelFailed(c, route, 0, undefined, policy)
    const entry = c.get('p/m')!
    expect(entry.until).toBe(60_000)
    expect(entry.attempts).toBe(1)
    markModelFailed(c, route, 0, undefined, policy)
    expect(c.get('p/m')!.until).toBe(60_000 * 4)
    expect(c.get('p/m')!.attempts).toBe(2)
  })

  it('floors cooldown by provider Retry-After (never shorter)', () => {
    const c = createCooldowns()
    markModelFailed(c, route, 0, 300_000, policy)
    expect(c.get('p/m')!.until).toBe(300_000)
  })

  it('caps at maxMs', () => {
    const c = createCooldowns()
    for (let i = 0; i < 20; i++) markModelFailed(c, route, 0, undefined, policy)
    expect(c.get('p/m')!.until).toBeLessThanOrEqual(policy.maxMs)
  })

  it('isModelInCooldown respects expiry', () => {
    const c = createCooldowns()
    markModelFailed(c, route, 0, undefined, policy)
    expect(isModelInCooldown(c, route, 59_999)).toBe(true)
    expect(isModelInCooldown(c, route, 60_000)).toBe(false)
  })

  it('clears cooldown and builds predicate', () => {
    const c = createCooldowns()
    markModelFailed(c, route, 0, undefined, policy)
    clearModelCooldown(c, route)
    expect(isModelInCooldown(c, route, 0)).toBe(false)
    const pred = cooldownPredicate(c, 0)
    expect(pred(route)).toBe(false)
  })

  it('formats remaining cooldown', () => {
    expect(formatRemaining(0)).toBe('0s')
    expect(formatRemaining(12_000)).toBe('12s')
    expect(formatRemaining(3 * 60_000 + 12_000)).toBe('3m12s')
  })
})
