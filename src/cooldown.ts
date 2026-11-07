/**
 * dsh-route-keeper — bounded cooldown state machine.
 *
 * Adapted from `dsh-shift-router/src/failover.ts` (MIT), which is itself ported
 * from pi-shift-router (https://github.com/green-dalii/pi-shift-router).
 * Copyright (c) 2026 green-dalii and dsh-shift-router contributors.
 *
 * Changes: removed tier-specific selection; added a `providerRetryAfterMs` floor;
 * classification lives in `./classify.js`. All functions are pure and clock-injected.
 */
import type { CooldownEntry, Route } from './types.js'
import { routeKey } from './types.js'

export type CooldownMap = Map<string, CooldownEntry>

export interface CooldownPolicy {
  baseMs: number
  maxMs: number
}

/** Create an empty cooldown map. */
export function createCooldowns(): CooldownMap {
  return new Map()
}

/**
 * Record a failure and apply bounded exponential backoff:
 * backoff = min(base * 4^(attempts-1), maxMs), floored by the provider's
 * Retry-After when present (never shorter).
 */
export function markModelFailed(
  cooldowns: CooldownMap,
  route: Route,
  now: number,
  providerRetryAfterMs: number | undefined,
  policy: CooldownPolicy,
): void {
  const key = routeKey(route)
  const prev = cooldowns.get(key)
  const attempts = (prev?.attempts ?? 0) + 1
  const backoff = Math.min(policy.baseMs * 4 ** (attempts - 1), policy.maxMs)
  const until = now + Math.max(backoff, providerRetryAfterMs ?? 0)
  cooldowns.set(key, { until, attempts })
}

/** True if the route is currently in cooldown (not yet expired). */
export function isModelInCooldown(cooldowns: CooldownMap | undefined, route: Route, now: number): boolean {
  if (!cooldowns) return false
  const entry = cooldowns.get(routeKey(route))
  return !!entry && entry.until > now
}

/** Remove a route from cooldown (recovery / success). */
export function clearModelCooldown(cooldowns: CooldownMap, route: Route): void {
  cooldowns.delete(routeKey(route))
}

/** Build a predicate skipping routes in cooldown. */
export function cooldownPredicate(
  cooldowns: CooldownMap | undefined,
  now: number,
): (route: Route) => boolean {
  return (route) => isModelInCooldown(cooldowns, route, now)
}

/** Format remaining cooldown for display: "3m12s". */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return '0s'
  const totalSec = Math.ceil(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return m > 0 ? `${m}m${s}s` : `${s}s`
}
