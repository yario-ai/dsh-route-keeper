import { createCooldowns } from './cooldown.js'
import type { RecoveryLatch, Role, Route, RouteAgentState } from './types.js'

export function createAgentState(sessionId: string, role: Role): RouteAgentState {
  return {
    sessionId,
    role,
    parentSessionId: undefined,
    resident: undefined,
    primary: undefined,
    isFallback: false,
    managedRoutes: [],
    assignedSource: undefined,
    fallbackHops: 0,
    cooldowns: createCooldowns(),
    halfOpen: undefined,
    halfOpenRequestObserved: false,
    pin: undefined,
    residenceSince: 0,
    recoveryLatch: undefined,
    ownedSelectionSeq: undefined,
    ownedSelection: undefined,
    predecessorSelection: undefined,
    manualGeneration: 0,
    configGeneration: 0,
    consecutiveFailures: 0,
    failureWindow: [],
    firstFailureAt: undefined,
    autoContinueCount: 0,
    currentTask: undefined,
  }
}

export function setRecoveryLatch(state: RouteAgentState, latch: RecoveryLatch): void {
  state.recoveryLatch = latch
}

export function clearRecoveryLatch(state: RouteAgentState): void {
  state.recoveryLatch = undefined
}

export function reserveHalfOpen(state: RouteAgentState, route: Route, now: number): void {
  state.halfOpen = { route, reservedAt: now }
  state.halfOpenRequestObserved = false
}

export function releaseHalfOpen(state: RouteAgentState): void {
  state.halfOpen = undefined
  state.halfOpenRequestObserved = false
}

/** Record a terminal failure at route-keeper's layer and update counters. */
export function recordTerminalFailure(state: RouteAgentState, now: number): void {
  state.consecutiveFailures += 1
  state.failureWindow.push(now)
}

/** Reset transient failure counters on a success. */
export function resetFailureCounters(state: RouteAgentState): void {
  state.consecutiveFailures = 0
  state.failureWindow = []
  state.firstFailureAt = undefined
}

/** Count terminal failures within a rolling window. */
export function failuresInWindow(state: RouteAgentState, now: number, windowMs: number): number {
  const cutoff = now - windowMs
  return state.failureWindow.filter((t) => t >= cutoff).length
}
