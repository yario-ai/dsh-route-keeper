import type { Failure, FallbackClass } from './types.js'

const PERMANENT_CODES = new Set([
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'NO_ADAPTER',
  'UNKNOWN_MODEL',
  'UNSUPPORTED_REASONING_EFFORT',
  'CONTEXT_WINDOW_EXCEEDED',
  'IMAGE_OFFLOAD_REQUIRED',
  'MALFORMED_RESPONSE',
  'UNSUPPORTED_OPTION',
  'INVALID_ARGS',
  'INVALID_PREPARED_CALL',
  'DUPLICATE_ADAPTER',
  'REGISTRATION_DISPOSED',
])

const QUOTA_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA'])
const RATE_CODES = new Set(['RATE_LIMIT'])
const TRANSIENT_CODES = new Set(['SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'])

/** Classify a host failure code. Route on code only, never on message text. */
export function classifyFailure(failure: Failure | undefined): FallbackClass {
  if (!failure) return 'unknown'
  const code = failure.code
  if (RATE_CODES.has(code)) return 'transient-rate'
  if (QUOTA_CODES.has(code)) return 'quota-reset'
  if (TRANSIENT_CODES.has(code)) return 'server-transport'
  if (PERMANENT_CODES.has(code)) return 'permanent'
  return 'unknown'
}

/** Whether this class is eligible for same-route retry (zero-output only). */
export function isRetryableClass(kind: FallbackClass): boolean {
  return kind === 'transient-rate' || kind === 'server-transport'
}

/** Whether this class is eligible for cross-route fallback at all. */
export function isFallbackEligible(kind: FallbackClass): boolean {
  return kind === 'transient-rate' || kind === 'quota-reset' || kind === 'server-transport'
}
