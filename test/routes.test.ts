import { describe, expect, it } from 'vitest'
import { resolveFallbackTarget, resolvePrimary, isNoDowngrade } from '../lib/routes.js'
import { createCooldowns, markModelFailed } from '../lib/cooldown.js'
import type { RoleConfig } from '../lib/types.js'

const role: RoleConfig = {
  primary: { provider: 'openai-codex', model: 'gpt-6.1-sol' },
  fallbacks: [
    { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    { provider: 'deepseek', model: 'deepseek-v4-pro' },
  ],
  allowHosts: ['opencode-go', 'deepseek'],
  noDowngradeRoutes: [{ provider: 'openai-codex', model: 'gpt-6.1-sol' }],
}

const allow = (_: { provider: string; model: string }) => true
const available = (_: { provider: string; model: string }) => true

describe('routes', () => {
  it('resolves primary', () => {
    expect(resolvePrimary(role)).toEqual({ provider: 'openai-codex', model: 'gpt-6.1-sol' })
  })

  it('resolves first allowed available fallback in order', () => {
    const target = resolveFallbackTarget(role, undefined, 0, allow, available)
    expect(target).toEqual({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  })

  it('skips cooldown and not-allowed and not-available and excluded', () => {
    const c = createCooldowns()
    markModelFailed(c, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, 0, undefined, { baseMs: 60_000, maxMs: 60_000 })
    const target = resolveFallbackTarget(
      role,
      c,
      0,
      (r) => r.provider === 'deepseek',
      (r) => r.provider !== 'deepseek' ? false : true,
    )
    // first fallback cooldown'd, second allowed+available
    expect(target).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' })
  })

  it('respects exclude', () => {
    const target = resolveFallbackTarget(role, undefined, 0, allow, available, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
    expect(target).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' })
  })

  it('returns undefined when nothing fits', () => {
    expect(resolveFallbackTarget(role, undefined, 0, () => false, available)).toBeUndefined()
  })

  it('detects no-downgrade routes', () => {
    expect(isNoDowngrade(role, { provider: 'openai-codex', model: 'gpt-6.1-sol' })).toBe(true)
    expect(isNoDowngrade(role, { provider: 'deepseek', model: 'deepseek-v4-pro' })).toBe(false)
  })
})
