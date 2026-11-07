import type { Failure, RouteAgentState } from './types.js'
import { classifyFailure, isFallbackEligible, isRetryableClass } from './classify.js'

export type RetryDecision =
  | { kind: 'retry'; delayMs: number }
  | { kind: 'fallback' }
  | { kind: 'terminal' }

export interface RetryInput {
  attempt: number
  maxRetries: number
  backoffInitialMs: number
  backoffMaxMs: number
  jitterRatio: number
  maxFailureElapsedMs: number
  firstFailureAt: number
  now: number
  failure: Failure | undefined
  random: () => number
}

/** Bounded exponential backoff with symmetric jitter, matching host retry shape. */
export function computeBackoffMs(
  attempt: number,
  initialMs: number,
  maxMs: number,
  jitterRatio: number,
  random: () => number,
): number {
  const exponent = Math.min(attempt - 1, 30)
  const exponential = Math.min(initialMs * 2 ** exponent, maxMs)
  const jitter = 1 - jitterRatio + 2 * jitterRatio * random()
  return Math.min(exponential * jitter, maxMs)
}

/**
 * Decide same-route retry vs cross-route fallback vs terminal for one managed
 * zero-output failure. `attempt` is 1-based (the original is attempt 1).
 * `maxRetries = N` ⇒ at most 1+N attempts (attempts 1..1+N), so attempt ≥ 1+N
 * exhausts the budget and falls back.
 *
 * Retry-After is honored strictly: a valid positive finite provider delay
 * floors the local backoff and is never shortened. If it exceeds the permitted
 * max wait or the remaining elapsed budget, the decision is fallback/terminal,
 * never an early request.
 */
export function decideSameRouteRetry(input: RetryInput): RetryDecision {
  const { attempt, maxRetries, maxFailureElapsedMs, firstFailureAt, now, failure } = input
  const failureClass = classifyFailure(failure)
  if (!isRetryableClass(failureClass)) {
    return isFallbackEligible(failureClass) ? { kind: 'fallback' } : { kind: 'terminal' }
  }
  const totalAttempts = 1 + maxRetries
  const elapsed = maxFailureElapsedMs > 0 ? now - firstFailureAt : 0
  if (maxFailureElapsedMs > 0 && elapsed >= maxFailureElapsedMs) return { kind: 'fallback' }
  if (attempt >= totalAttempts) return { kind: 'fallback' }

  const localBackoff = computeBackoffMs(attempt, input.backoffInitialMs, input.backoffMaxMs, input.jitterRatio, input.random)
  const providerDelay = validRetryAfter(failure?.providerRetryAfterMs)
  const remaining = maxFailureElapsedMs > 0 ? maxFailureElapsedMs - elapsed : Number.POSITIVE_INFINITY

  if (providerDelay !== undefined) {
    // Never retry earlier than the provider mandates.
    if (providerDelay > input.backoffMaxMs) return { kind: 'fallback' }
    if (providerDelay > remaining) return { kind: 'fallback' }
    const local = Math.min(localBackoff, remaining)
    return { kind: 'retry', delayMs: Math.max(local, providerDelay) }
  }

  const delayMs = Math.min(localBackoff, Math.max(0, remaining))
  return { kind: 'retry', delayMs }
}

/** Whether the elapsed budget is already exhausted at a re-check boundary. */
export function retryBudgetExhausted(firstFailureAt: number, now: number, maxFailureElapsedMs: number): boolean {
  return maxFailureElapsedMs > 0 && now - firstFailureAt >= maxFailureElapsedMs
}

function validRetryAfter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Whether a terminal failure triggers cross-route fallback by window/count/condition. */
export function terminalFallbackDue(
  state: RouteAgentState,
  budget: { consecutiveFailures: number; failureWindowMs: number; failureThreshold: number; condition: 'any' | 'all' },
  now: number,
): boolean {
  const conditions: boolean[] = []
  if (budget.consecutiveFailures > 0) conditions.push(state.consecutiveFailures >= budget.consecutiveFailures)
  if (budget.failureWindowMs > 0) {
    const count = state.failureWindow.filter((t) => now - t <= budget.failureWindowMs).length
    conditions.push(count >= budget.failureThreshold)
  }
  if (conditions.length === 0) return false
  return budget.condition === 'all' ? conditions.every(Boolean) : conditions.some(Boolean)
}
