import { describe, expect, it } from 'vitest'
import { Config } from '../lib/config.js'

const base = {
  enabled: true,
  roles: {
    root: { primary: { provider: 'p', model: 'm' }, fallbacks: [], allowHosts: ['p'], noDowngradeRoutes: [] },
    child: { primary: null, fallbacks: [], allowHosts: [], noDowngradeRoutes: [] },
  },
  sticky: { minResidenceMs: 1000 },
  cooldown: { baseMs: 100, maxMs: 1000 },
  budget: {},
  jev: { enabled: false },
  pin: null,
}

describe('config bounds', () => {
  it('rejects non-integer budgets (finite integer caps only)', () => {
    expect(() => Config({ ...base, budget: { maxRetries: 1.5 } })).toThrow()
    expect(() => Config({ ...base, budget: { maxFallbackHops: 1.5 } })).toThrow()
    expect(() => Config({ ...base, budget: { backoffInitialMs: 0.5 } })).toThrow()
    expect(() => Config({ ...base, budget: { failureThreshold: 2.5 } })).toThrow()
  })

  it('rejects budgets beyond their finite ceilings', () => {
    expect(() => Config({ ...base, budget: { maxRetries: 101 } })).toThrow()
    expect(() => Config({ ...base, budget: { maxFallbackHops: 11 } })).toThrow()
    expect(() => Config({ ...base, budget: { maxAutoContinue: 21 } })).toThrow()
  })

  it('rejects Jev byte caps beyond 256 KiB', () => {
    expect(() => Config({ ...base, jev: { enabled: true, maxResponseBytes: 256 * 1024 + 1 } })).toThrow()
    expect(() => Config({ ...base, jev: { enabled: true, maxPromptChars: 256 * 1024 + 1 } })).toThrow()
  })

  it('rejects negative budgets and out-of-range jitter', () => {
    expect(() => Config({ ...base, budget: { maxRetries: -1 } })).toThrow()
    expect(() => Config({ ...base, budget: { jitterRatio: 1.5 } })).toThrow()
    expect(() => Config({ ...base, budget: { jitterRatio: -0.1 } })).toThrow()
  })

  it('accepts a valid full configuration and fills defaults', () => {
    const out = Config(base)
    expect(out.budget.maxRetries).toBe(2)
    expect(out.budget.maxFallbackHops).toBe(1)
    expect(out.budget.condition).toBe('any')
    expect(out.jev.enabled).toBe(false)
  })
})
