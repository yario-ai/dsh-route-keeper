import { describe, expect, it } from 'vitest'
import { decideSameRouteRetry, computeBackoffMs, retryBudgetExhausted, terminalFallbackDue } from '../lib/retry.js'
import { createAgentState, recordTerminalFailure, resetFailureCounters } from '../lib/state.js'

const base = {
  maxRetries: 2,
  backoffInitialMs: 1000,
  backoffMaxMs: 10000,
  jitterRatio: 0,
  maxFailureElapsedMs: 0,
  firstFailureAt: 0,
  now: 0,
  failure: { code: 'SERVER', message: 'boom' },
  random: () => 0.5,
}

describe('decideSameRouteRetry', () => {
  it('retries while attempts remain (maxRetries=N ⇒ 1+N attempts)', () => {
    // attempt 1 with maxRetries 2 → retry
    expect(decideSameRouteRetry({ ...base, attempt: 1 }).kind).toBe('retry')
    // attempt 2 → retry
    expect(decideSameRouteRetry({ ...base, attempt: 2 }).kind).toBe('retry')
    // attempt 3 (== 1+2) → fallback
    expect(decideSameRouteRetry({ ...base, attempt: 3 }).kind).toBe('fallback')
    // attempt 4 → fallback
    expect(decideSameRouteRetry({ ...base, attempt: 4 }).kind).toBe('fallback')
  })

  it('quota falls back immediately without retry', () => {
    const d = decideSameRouteRetry({ ...base, attempt: 1, failure: { code: 'QUOTA', message: 'q' } })
    expect(d.kind).toBe('fallback')
  })

  it('permanent/unknown is terminal', () => {
    expect(decideSameRouteRetry({ ...base, failure: { code: 'AUTH', message: 'a' } }).kind).toBe('terminal')
    expect(decideSameRouteRetry({ ...base, failure: { code: 'NOPE', message: 'a' } }).kind).toBe('terminal')
  })

  it('ignores non-positive / NaN Retry-After (uses local backoff)', () => {
    for (const v of [0, -1, NaN, Number.POSITIVE_INFINITY, '100']) {
      const d = decideSameRouteRetry({ ...base, attempt: 1, failure: { code: 'RATE_LIMIT', message: 'r', providerRetryAfterMs: v as never } })
      expect(d.kind).toBe('retry')
    }
  })

  it('floors local backoff with a valid Retry-After', () => {
    // local backoff attempt 1 = 1000ms; provider says 3000ms → delay 3000ms
    const d = decideSameRouteRetry({ ...base, attempt: 1, failure: { code: 'RATE_LIMIT', message: 'r', providerRetryAfterMs: 3000 } })
    expect(d).toEqual({ kind: 'retry', delayMs: 3000 })
  })

  it('falls back when Retry-After exceeds the permitted max wait (never shorter)', () => {
    const d = decideSameRouteRetry({ ...base, attempt: 1, failure: { code: 'RATE_LIMIT', message: 'r', providerRetryAfterMs: 20000 } })
    expect(d.kind).toBe('fallback')
  })

  it('falls back when Retry-After exceeds the remaining elapsed budget (never shorter)', () => {
    const d = decideSameRouteRetry({
      ...base,
      attempt: 1,
      maxFailureElapsedMs: 5000,
      firstFailureAt: 1000,
      now: 2000,
      failure: { code: 'RATE_LIMIT', message: 'r', providerRetryAfterMs: 4000 },
    })
    // remaining = 5000 - 1000 = 4000; provider says 4000 which is NOT > 4000, so retry at 4000
    expect(d.kind).toBe('retry')
    const d2 = decideSameRouteRetry({
      ...base,
      attempt: 1,
      maxFailureElapsedMs: 5000,
      firstFailureAt: 1000,
      now: 2000,
      failure: { code: 'RATE_LIMIT', message: 'r', providerRetryAfterMs: 4001 },
    })
    expect(d2.kind).toBe('fallback')
  })

  it('clamps local backoff (no provider mandate) to remaining budget', () => {
    const d = decideSameRouteRetry({
      ...base,
      attempt: 1,
      maxFailureElapsedMs: 500,
      firstFailureAt: 0,
      now: 0,
    })
    expect(d).toEqual({ kind: 'retry', delayMs: 500 })
  })

  it('jitter stays within [1-jitterRatio, 1+jitterRatio] of exponential', () => {
    for (let i = 0; i < 100; i++) {
      const random = Math.random()
      const delay = computeBackoffMs(1, 1000, 10000, 0.2, () => random)
      expect(delay).toBeGreaterThanOrEqual(1000 * (1 - 0.2))
      expect(delay).toBeLessThanOrEqual(1000 * (1 + 0.2))
    }
  })
})

describe('retryBudgetExhausted', () => {
  it('detects elapsed budget exhaustion at re-check boundary', () => {
    expect(retryBudgetExhausted(0, 5000, 5000)).toBe(true)
    expect(retryBudgetExhausted(0, 4999, 5000)).toBe(false)
    expect(retryBudgetExhausted(0, 5000, 0)).toBe(false)
  })
})

describe('terminalFallbackDue', () => {
  const budget = (over: Partial<{ consecutiveFailures: number; failureWindowMs: number; failureThreshold: number; condition: 'any' | 'all' }> = {}) => ({
    consecutiveFailures: 0,
    failureWindowMs: 0,
    failureThreshold: 2,
    condition: 'any' as const,
    ...over,
  })

  it('disabled (all thresholds zero) never accelerates fallback', () => {
    const s = createAgentState('s1', 'root')
    recordTerminalFailure(s, 1000)
    expect(terminalFallbackDue(s, budget(), 1000)).toBe(false)
  })

  it('consecutive-failures threshold triggers immediate fallback', () => {
    const s = createAgentState('s1', 'root')
    expect(terminalFallbackDue(s, budget({ consecutiveFailures: 2 }), 1000)).toBe(false)
    recordTerminalFailure(s, 1000)
    recordTerminalFailure(s, 2000)
    expect(terminalFallbackDue(s, budget({ consecutiveFailures: 2 }), 2000)).toBe(true)
  })

  it('window/threshold counts only failures inside the rolling window', () => {
    const s = createAgentState('s1', 'root')
    recordTerminalFailure(s, 1000)
    recordTerminalFailure(s, 5000)
    expect(terminalFallbackDue(s, budget({ failureWindowMs: 1000, failureThreshold: 2 }), 6000)).toBe(false) // only the 5000 one is in window
    expect(terminalFallbackDue(s, budget({ failureWindowMs: 5000, failureThreshold: 2 }), 6000)).toBe(true) // both in window
  })

  it('condition all requires every configured condition to hold', () => {
    const s = createAgentState('s1', 'root')
    recordTerminalFailure(s, 1000)
    recordTerminalFailure(s, 2000)
    // consecutive ok (2>=2), window fails (only t=2000 within [1500,2000]) → all = false
    expect(terminalFallbackDue(s, budget({ consecutiveFailures: 2, failureWindowMs: 500, failureThreshold: 2, condition: 'all' }), 2000)).toBe(false)
    // both ok → all = true
    expect(terminalFallbackDue(s, budget({ consecutiveFailures: 2, failureWindowMs: 5000, failureThreshold: 2, condition: 'all' }), 2000)).toBe(true)
  })

  it('reset clears the episode so fallback acceleration restarts', () => {
    const s = createAgentState('s1', 'root')
    recordTerminalFailure(s, 1000)
    recordTerminalFailure(s, 2000)
    expect(terminalFallbackDue(s, budget({ consecutiveFailures: 2 }), 2000)).toBe(true)
    resetFailureCounters(s)
    expect(terminalFallbackDue(s, budget({ consecutiveFailures: 2 }), 2000)).toBe(false)
  })
})
