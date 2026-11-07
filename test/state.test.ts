import { describe, expect, it } from 'vitest'
import { createAgentState, recordTerminalFailure, resetFailureCounters, failuresInWindow, reserveHalfOpen, releaseHalfOpen } from '../lib/state.js'

describe('state', () => {
  it('creates a fresh root state', () => {
    const s = createAgentState('s1', 'root')
    expect(s.role).toBe('root')
    expect(s.cooldowns.size).toBe(0)
    expect(s.firstFailureAt).toBeUndefined()
  })

  it('records and resets terminal failures', () => {
    const s = createAgentState('s1', 'child')
    recordTerminalFailure(s, 1000)
    recordTerminalFailure(s, 2000)
    expect(s.consecutiveFailures).toBe(2)
    expect(failuresInWindow(s, 2500, 1000)).toBe(1)
    resetFailureCounters(s)
    expect(s.consecutiveFailures).toBe(0)
    expect(s.failureWindow.length).toBe(0)
    expect(s.firstFailureAt).toBeUndefined()
  })

  it('reserves and releases half-open', () => {
    const s = createAgentState('s1', 'root')
    reserveHalfOpen(s, { provider: 'p', model: 'm' }, 5)
    expect(s.halfOpen).toEqual({ route: { provider: 'p', model: 'm' }, reservedAt: 5 })
    releaseHalfOpen(s)
    expect(s.halfOpen).toBeUndefined()
  })
})
