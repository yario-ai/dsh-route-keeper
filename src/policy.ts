import z from 'zod'
import type { Route } from './types.js'

/**
 * Durable parent-Session subagent model-selection allowlist.
 *
 * Registers the same reference-counted projection key that
 * `dsh-tool-subagent` owns (`subagentModelSelectionPolicy`, stateVersion 1) so
 * route-keeper reads the exact durable allowlist the parent recorded — never a
 * separate approximation. Fail closed when no policy is recorded.
 */

const RouteSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict()

export interface SubagentPolicyHandle {
  stateOf(session: { id: string }): Route[] | null
  dispose(): Promise<void>
}

// The registry's precise ProjectionDefinition type is host-internal; matching
// the runtime shape (key/stateVersion/stateSchema/init/apply) is what the
// reference-counted registry requires. `any` keeps this portable across host
// minor versions without duplicating the SessionHeader/SessionEvent generics.
export async function registerSubagentPolicy(registry: any): Promise<SubagentPolicyHandle> {
  const handle = await registry.register({
    key: 'subagentModelSelectionPolicy',
    stateVersion: 1,
    stateSchema: z.array(RouteSchema).min(1).nullable(),
    init: () => null,
    apply: (policy: unknown, event: { type: string; data?: unknown }) => {
      if (policy !== null || event.type !== 'subagent/model-selection-policy') return policy
      const allowedModels = (event.data as { allowedModels?: unknown } | undefined)?.allowedModels
      if (!Array.isArray(allowedModels) || allowedModels.length === 0) {
        throw new Error('subagent/model-selection-policy requires at least one route')
      }
      return allowedModels as Route[]
    },
  })
  return {
    stateOf: (session) => handle.stateOf(session) as Route[] | null,
    dispose: () => handle.dispose(),
  }
}
