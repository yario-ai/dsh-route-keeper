import { describe, expect, it } from 'vitest'
import { classifyFailure, isFallbackEligible, isRetryableClass } from '../lib/classify.js'

describe('classifyFailure', () => {
  it('classifies RATE_LIMIT as transient-rate', () => {
    expect(classifyFailure({ code: 'RATE_LIMIT', message: 'x' })).toBe('transient-rate')
  })
  it('classifies QUOTA and ACCOUNT_QUOTA as quota-reset', () => {
    expect(classifyFailure({ code: 'QUOTA', message: 'x' })).toBe('quota-reset')
    expect(classifyFailure({ code: 'ACCOUNT_QUOTA', message: 'x' })).toBe('quota-reset')
  })
  it('classifies server/transport as server-transport', () => {
    for (const code of ['SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']) {
      expect(classifyFailure({ code, message: 'x' })).toBe('server-transport')
    }
  })
  it('classifies permanent codes as permanent', () => {
    for (const code of ['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'NO_ADAPTER', 'UNKNOWN_MODEL', 'CONTEXT_WINDOW_EXCEEDED']) {
      expect(classifyFailure({ code, message: 'x' })).toBe('permanent')
    }
  })
  it('classifies unknown as unknown', () => {
    expect(classifyFailure({ code: 'SOMETHING_ELSE', message: 'x' })).toBe('unknown')
    expect(classifyFailure(undefined)).toBe('unknown')
  })
  it('marks retryable and fallback eligibility', () => {
    expect(isRetryableClass('transient-rate')).toBe(true)
    expect(isRetryableClass('server-transport')).toBe(true)
    expect(isRetryableClass('quota-reset')).toBe(false)
    expect(isFallbackEligible('quota-reset')).toBe(true)
    expect(isFallbackEligible('permanent')).toBe(false)
    expect(isFallbackEligible('unknown')).toBe(false)
  })
})
