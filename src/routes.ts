import type { CooldownMap } from './cooldown.js'
import { isModelInCooldown } from './cooldown.js'
import type { RoleConfig, Route } from './types.js'

/**
 * Resolve the first allowed, available, not-in-cooldown fallback for a role.
 * `routeAllowed`/`routeAvailable` are injected by the host wiring so this stays
 * pure and unit-testable (allowlist ∩ durable policy ∩ egress ∩ cooldown).
 */
export function resolveFallbackTarget(
  role: RoleConfig,
  cooldowns: CooldownMap | undefined,
  now: number,
  routeAllowed: (route: Route) => boolean,
  routeAvailable: (route: Route) => boolean,
  exclude?: Route,
): Route | undefined {
  for (const route of role.fallbacks) {
    if (exclude && route.provider === exclude.provider && route.model === exclude.model) continue
    if (!routeAllowed(route)) continue
    if (isModelInCooldown(cooldowns, route, now)) continue
    if (!routeAvailable(route)) continue
    return route
  }
  return undefined
}

/** Resolve the role's primary (sticky) route, if configured. */
export function resolvePrimary(role: RoleConfig): Route | undefined {
  return role.primary ?? undefined
}

/** Whether a route is explicitly protected from downgrade for this role. */
export function isNoDowngrade(role: RoleConfig, route: Route): boolean {
  return role.noDowngradeRoutes.some((r) => r.provider === route.provider && r.model === route.model)
}
