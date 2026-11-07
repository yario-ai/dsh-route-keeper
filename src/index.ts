import type { Context } from '@deepseek-ai/cordis'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { createUserMessage, isAgentLoopRequest, type GenerateOptions, type LlmFailure, type LlmRuntime, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent, ModelSelection, RequestErrorAction } from '@deepseek-ai/dsh-agent'

import { Config } from './config.js'
import { decideSameRouteRetry, retryBudgetExhausted, terminalFallbackDue, type RetryDecision } from './retry.js'
import { emittedModelContent, extractUserTaskText } from './attempt.js'
import { resolvePrimary, isNoDowngrade } from './routes.js'
import { createAgentState, setRecoveryLatch, clearRecoveryLatch, recordTerminalFailure, resetFailureCounters, reserveHalfOpen, releaseHalfOpen } from './state.js'
import { markModelFailed, clearModelCooldown, isModelInCooldown } from './cooldown.js'
import { registerSubagentPolicy, type SubagentPolicyHandle } from './policy.js'
import { classifyWithJev } from './jev.js'
import type { AttemptRecord, Failure, Route, RouteAgentState, RouteKeeperConfig, Selection } from './types.js'
import { routeKey, sameRoute, sameSelection } from './types.js'

export const name = 'route-keeper'
export const inject = ['llm', 'agents', 'sessionProjections']
export { Config }

function isManagedFailureCode(code: string | undefined): boolean {
  if (!code) return false
  return code === 'RATE_LIMIT' || code === 'QUOTA' || code === 'ACCOUNT_QUOTA'
    || code === 'SERVER' || code === 'TIMEOUT' || code === 'TRANSPORT' || code === 'EMPTY_RESPONSE'
}

function cancellableDelay(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (!signal) return Promise.resolve(true)
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function continuationNotice(from: Route, to: Route) {
  return createUserMessage({
    content: [{ type: 'text', text: `[route-keeper: provider switch ${from.provider}/${from.model} → ${to.provider}/${to.model}; continuing from committed history]` }],
    source: { kind: 'model-selection', form: 'notice', summary: `route-keeper fallback ${from.provider}/${from.model} → ${to.provider}/${to.model}` },
  })
}

function toModelSelection(route: Route): ModelSelection {
  return { provider: route.provider, model: route.model }
}

function toSelection(selection: Readonly<ModelSelection> | undefined): Selection | undefined {
  if (!selection) return undefined
  return { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) }
}

/**
 * Egress allowlist: fail closed when the role's allowHosts is empty or the
 * provider is absent. An empty list never means "allow all".
 */
function isAllowedHost(config: RouteKeeperConfig, role: 'root' | 'child', provider: string): boolean {
  const hosts = role === 'root' ? config.roles.root.allowHosts : config.roles.child.allowHosts
  if (!Array.isArray(hosts) || hosts.length === 0) return false
  return hosts.includes(provider)
}

interface AgentsRegistry {
  currentInitiator(): Agent | undefined
  list(): Agent[]
  get(id: string): Agent | undefined
}

export async function apply(ctx: Context, config: RouteKeeperConfig = {} as RouteKeeperConfig) {
  const llm = ctx.get('llm') as LlmRuntime | undefined
  const agents = ctx.get('agents') as AgentsRegistry | undefined
  const sessionProjections = ctx.get('sessionProjections')

  const states = new Map<string, RouteAgentState>()
  const attemptByKey = new Map<string, AttemptRecord>()
  const activeTurnStep = new Map<string, { turn: number; step: number }>()
  const attemptCount = new Map<string, number>()
  const halfOpenRoutes = new Map<string, { route: Route; ownerSessionId: string }>()
  const probeSnapshots = new Map<string, { routeKey: string; authorized: boolean; at: number; manualGeneration: number; configGeneration: number; registryRevision: number }>()
  /** Sessions that already recorded a `model/selection` before route-keeper admission. */
  const seenSelection = new Set<string>()

  /** Own-write marker consumed synchronously by the `session/event` observer. */
  let ownSelectSeq: number | undefined
  let lifetimeController = new AbortController()
  let disposed = false
  let wasEnabled = config.enabled === true
  /** Bumped on `llm/adapters-updated` so cached async model metadata invalidates. */
  let registryRevision = 0

  let policyHandle: SubagentPolicyHandle | undefined
  if (sessionProjections) {
    try {
      policyHandle = await registerSubagentPolicy(sessionProjections)
    } catch (error) {
      ctx.logger.warn(`route-keeper: subagent policy projection unavailable (${String(error)})`)
    }
  }

  const roleOf = (agent: Agent): 'root' | 'child' => (delegationDepthOf(agent) === 0 ? 'root' : 'child')
  const roleConfig = (role: 'root' | 'child') => (role === 'root' ? config.roles.root : config.roles.child)

  const isManagedRoute = (state: RouteAgentState, route: Route): boolean => state.managedRoutes.some((f) => sameRoute(f, route))

  const setResident = (state: RouteAgentState, route: Route, isFallback: boolean): void => {
    state.resident = route
    state.isFallback = isFallback
    state.residenceSince = Date.now()
  }

  /**
   * Central synchronous final-admission guard. Called immediately before every
   * selection side effect (after the LAST await) so a late manual/config change,
   * cancel, disable or unmount can never be overwritten by a stale selection.
   */
  const finalAdmission = (state: RouteAgentState, agent: Agent, manualGeneration: number, configGeneration: number, signal: AbortSignal | undefined): boolean => {
    if (!config.enabled || disposed || lifetimeController.signal.aborted) return false
    if (signal?.aborted) return false
    if (!agents?.get(agent.session.id)) return false
    if (state.manualGeneration !== manualGeneration || state.configGeneration !== configGeneration) return false
    return true
  }

  const assignManaged = (state: RouteAgentState, agent: Agent): void => {
    const rc = roleConfig(state.role)
    const current = agent.model.current()
    const assigned: Route | undefined = (current && current.provider && current.model)
      ? { provider: current.provider, model: current.model }
      : (agent.options.provider && agent.options.model)
        ? { provider: agent.options.provider, model: agent.options.model }
        : rc.primary ?? undefined
    state.assignedSource = assigned
    const set: Route[] = []
    const push = (r: Route) => { if (!set.some((x) => sameRoute(x, r))) set.push(r) }
    if (assigned) push(assigned)
    if (rc.primary) push(rc.primary)
    for (const f of rc.fallbacks) push(f)
    state.managedRoutes = set
    if (rc.primary) state.primary = rc.primary
    // Resident tracks the actual current route; primary is the sticky return target.
    if (assigned) setResident(state, assigned, false)
    else if (rc.primary) setResident(state, rc.primary, false)
  }

  /** Record our own still-pending `model/selection` write (ownership for CAS rollback). */
  const selectOwned = (state: RouteAgentState, agent: Agent, target: Readonly<ModelSelection>): number | undefined => {
    const before = agent.session.seq
    const prev = toSelection(agent.model.current())
    ownSelectSeq = before
    try {
      agent.model.select(target)
    } finally {
      ownSelectSeq = undefined
    }
    if (agent.session.seq > before) {
      state.ownedSelectionSeq = before
      state.ownedSelection = { provider: target.provider, model: target.model, ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort }) }
      state.predecessorSelection = prev
      return before
    }
    return undefined
  }

  /** Release only our own route-wide half-open reservation (never another agent's). */
  const releaseHalfOpenOwned = (state: RouteAgentState): void => {
    const probe = state.halfOpen
    if (!probe) return
    const entry = halfOpenRoutes.get(routeKey(probe.route))
    if (entry && entry.ownerSessionId === state.sessionId) {
      halfOpenRoutes.delete(routeKey(probe.route))
    }
    releaseHalfOpen(state)
  }

  /** Atomic route-wide half-open reservation keyed by route+owner. */
  const reserveHalfOpenRoute = (state: RouteAgentState, route: Route, now: number): boolean => {
    const rk = routeKey(route)
    if (halfOpenRoutes.has(rk)) return false
    halfOpenRoutes.set(rk, { route, ownerSessionId: state.sessionId })
    reserveHalfOpen(state, route, now)
    return true
  }

  /** Durable parent policy ∩ role ∩ egress: fail closed (absent policy ⇒ parent route only). */
  const childTargetAllowed = (state: RouteAgentState, target: Route): boolean => {
    if (state.role !== 'child') return true
    if (state.parentSessionId === undefined) return false
    if (!policyHandle || !agents) return false
    const parentAgent = agents.get(state.parentSessionId)
    if (!parentAgent) return false
    const policy = policyHandle.stateOf(parentAgent.session)
    if (policy === null || policy === undefined) {
      // No recorded policy ⇒ only the parent route (host tool semantics), never broaden.
      const parentRoute = parentAgent.model.current()
      if (!parentRoute) return false
      return sameRoute({ provider: parentRoute.provider, model: parentRoute.model }, target)
    }
    return policy.some((r) => sameRoute(r, target))
  }

  /** Uniform authorization for every automatic target select (no-downgrade is source protection, not target). */
  const targetAuthorized = async (state: RouteAgentState, target: Route, signal: AbortSignal | undefined): Promise<boolean> => {
    const rc = roleConfig(state.role)
    if (!llm) return false
    const providers = llm.listProviders()
    if (!providers.some((p) => p.id === target.provider)) return false
    if (!isAllowedHost(config, state.role, target.provider)) return false
    if (!childTargetAllowed(state, target)) return false
    try {
      await llm.resolveModelInfo(target.provider, target.model, signal)
      return true
    } catch {
      return false
    }
  }

  /** Refresh the prevalidated fail-closed probe snapshot for a future boundary. */
  const refreshProbeSnapshot = async (state: RouteAgentState, route: Route): Promise<void> => {
    const manualGeneration = state.manualGeneration
    const configGeneration = state.configGeneration
    const registryRev = registryRevision
    const authorized = await targetAuthorized(state, route, undefined)
    // Discard a snapshot whose guard inputs changed while the metadata resolved.
    if (state.manualGeneration !== manualGeneration || state.configGeneration !== configGeneration) return
    probeSnapshots.set(state.sessionId, { routeKey: routeKey(route), authorized, at: Date.now(), manualGeneration, configGeneration, registryRevision: registryRev })
  }

  const pickFallback = async (state: RouteAgentState, failed: Route, signal: AbortSignal | undefined): Promise<Route | undefined> => {
    const rc = roleConfig(state.role)
    const now = Date.now()
    for (const cand of rc.fallbacks) {
      if (sameRoute(cand, failed)) continue
      if (isModelInCooldown(state.cooldowns, cand, now)) continue
      if (!await targetAuthorized(state, cand, signal)) continue
      return cand
    }
    return undefined
  }

  const latchFallback = (
    state: RouteAgentState, agent: Agent, turn: number, step: number, record: AttemptRecord, target: Route,
    ownedSelectionSeq: number | undefined, manualGeneration: number, configGeneration: number,
  ): void => {
    setRecoveryLatch(state, {
      sessionId: agent.session.id,
      turn,
      step,
      selection: { ...target },
      attempt: record,
      manualGeneration,
      configGeneration,
      ownedSelectionSeq,
    })
  }

  // agent/created: register role, inventory, sticky primary/pin (fresh startup only, fully validated).
  const disposeCreated = ctx.on('agent/created', async ({ agent, source }): Promise<undefined> => {
    observeDisable()
    if (!config.enabled) return undefined
    const role = roleOf(agent)
    const existing = states.get(agent.session.id)
    if (existing) {
      existing.role = role
      return undefined
    }
    const state = createAgentState(agent.session.id, role)
    state.parentSessionId = agent.session.header.parentSession
    assignManaged(state, agent)
    states.set(agent.session.id, state)

    // Never force-switch a resumed/cleared/compacted session's recorded selection.
    if (source !== 'startup') return undefined

    const rc = roleConfig(role)
    if (role === 'root') {
      const manualGenBefore = state.manualGeneration
      const configGenBefore = state.configGeneration
      if (config.pin) {
        if (await targetAuthorized(state, config.pin, undefined)) {
          // Final admission after the LAST await: no late manual/cancel/disable override.
          if (!finalAdmission(state, agent, manualGenBefore, configGenBefore, undefined)) return undefined
          state.pin = { ...config.pin }
          state.configGeneration += 1
          selectOwned(state, agent, toModelSelection(config.pin))
          setResident(state, config.pin, false)
        }
      } else {
        const primary = resolvePrimary(rc)
        // Sticky primary applies only when no recorded manual selection pre-exists.
        if (primary && !seenSelection.has(agent.session.id) && await targetAuthorized(state, primary, undefined)) {
          if (!finalAdmission(state, agent, manualGenBefore, configGenBefore, undefined)) return undefined
          if (seenSelection.has(agent.session.id)) return undefined // manual select appeared during the metadata wait
          state.configGeneration += 1
          selectOwned(state, agent, toModelSelection(primary))
          setResident(state, primary, false)
        }
      }
    }
    return undefined
  })

  // agent/pre-step: cache active turn/step + bounded current task (no truncation).
  const disposePreStep = ctx.on('agent/pre-step', ({ agent, turn, step, messages }, next) => {
    observeDisable()
    activeTurnStep.set(agent.session.id, { turn, step })
    const state = states.get(agent.session.id)
    if (state && step === 1) {
      const text = extractUserTaskText(messages as never)
      if (text) state.currentTask = text
    }
    // A subsequent step implies the prior step committed successfully: reset failure episode.
    if (state && step >= 2) resetFailureCounters(state)
    return next()
  })

  // llm/stream observer (security-critical): correlation + zero-output tracking.
  const disposeStream = ctx.on('llm/stream', (options: GenerateOptions, next) => {
    observeDisable()
    if (!config.enabled) return next()
    if (!isAgentLoopRequest(options)) return next()
    const sessionId = (options as { sessionId?: string }).sessionId
    if (!sessionId) return next()
    const ats = activeTurnStep.get(sessionId)
    const record: AttemptRecord = {
      attemptId: options as object,
      sessionId,
      turn: ats?.turn ?? -1,
      step: ats?.step ?? -1,
      provider: (options as { provider?: string }).provider ?? '',
      model: (options as { model?: string }).model ?? '',
      hasOutput: false,
      signal: (options as { signal?: AbortSignal }).signal,
    }
    attemptByKey.set(`${sessionId}:${record.turn}:${record.step}`, record)
    const state = states.get(sessionId)
    if (state && state.halfOpen && record.provider !== '' && record.model !== '' && sameRoute(state.halfOpen.route, { provider: record.provider, model: record.model })) {
      state.halfOpenRequestObserved = true
    }
    const upstream = next()
    return (async function* (): AsyncIterable<StreamChunk> {
      for await (const chunk of upstream) {
        if (emittedModelContent(chunk as never)) record.hasOutput = true
        yield chunk
      }
    })()
  })

  // agent/request-error (prepend): ownership FIRST, then short-circuit all managed outcomes.
  const disposeRequestError = ctx.on('agent/request-error', async (payload, next): Promise<RequestErrorAction> => {
    const { agent, turn, step, provider, failure, signal } = payload
    observeDisable()
    if (!config.enabled) return next()
    const state = states.get(agent.session.id)
    if (!state) return next()

    // Ownership is determined before any outcome gate: only exact managed routes
    // are short-circuited; every unmanaged route delegates native unchanged.
    const providerManaged = state.managedRoutes.some((r) => r.provider === provider)
    if (!providerManaged) return next()

    const key = `${agent.session.id}:${turn}:${step}`
    const attempt = (attemptCount.get(key) ?? 0) + 1
    attemptCount.set(key, attempt)

    const record = attemptByKey.get(key)
    // Managed provider with absent/unknown correlation ⇒ terminal (fail closed, no native retry).
    if (!record || record.sessionId !== agent.session.id || record.model === '' || record.provider !== provider) {
      return undefined
    }
    const failed: Route = { provider, model: record.model }
    // Managed provider but exact model not owned ⇒ unmanaged ⇒ delegate native unchanged.
    if (!isManagedRoute(state, failed)) return next()
    // Fully managed from here: route-keeper owns every outcome (never `next()`).

    // Probe reservation release: ANY error on the half-open probe route (including
    // cancel/partial/unknown) releases the reservation and stays on the fallback.
    if (state.halfOpen && sameRoute(state.halfOpen.route, failed)) {
      releaseHalfOpenOwned(state)
      state.isFallback = true
    }

    if (record.hasOutput || signal.aborted) return undefined // partial output / cancel ⇒ terminal

    const code = (failure as LlmFailure).code
    if (!isManagedFailureCode(code)) return undefined // permanent/unknown ⇒ terminal (never native)

    if (isNoDowngrade(roleConfig(state.role), failed)) return undefined // protected source: never fall back away

    const now = Date.now()
    if (state.firstFailureAt === undefined) state.firstFailureAt = now

    let decision: RetryDecision
    if (terminalFallbackDue(state, config.budget, now)) {
      decision = { kind: 'fallback' }
    } else {
      decision = decideSameRouteRetry({
        attempt,
        maxRetries: config.budget.maxRetries,
        backoffInitialMs: config.budget.backoffInitialMs,
        backoffMaxMs: config.budget.backoffMaxMs,
        jitterRatio: config.budget.jitterRatio,
        maxFailureElapsedMs: config.budget.maxFailureElapsedMs,
        firstFailureAt: state.firstFailureAt,
        now,
        failure: failure as unknown as Failure,
        random: Math.random,
      })
    }

    if (decision.kind === 'retry') {
      const combined = AbortSignal.any([signal, lifetimeController.signal])
      if (!await cancellableDelay(decision.delayMs, combined)) return undefined
      if (retryBudgetExhausted(state.firstFailureAt ?? now, Date.now(), config.budget.maxFailureElapsedMs)) {
        decision = { kind: 'fallback' }
      } else {
        return { kind: 'retry' }
      }
    }

    if (decision.kind === 'fallback') {
      if (state.fallbackHops >= config.budget.maxFallbackHops) return undefined
      const manualGenBefore = state.manualGeneration
      const configGenBefore = state.configGeneration
      const retryAfter = (failure as LlmFailure).providerRetryAfterMs
      const target = await pickFallback(state, failed, signal)
      // Post-await revalidation: signal/lifetime/enabled/manual+config generation/no newer input.
      if (signal.aborted || lifetimeController.signal.aborted || disposed) return undefined
      if (!config.enabled) return undefined
      if (state.manualGeneration !== manualGenBefore || state.configGeneration !== configGenBefore) return undefined
      if (state.recoveryLatch !== undefined) return undefined
      if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) return undefined
      if (!target) return undefined

      recordTerminalFailure(state, now)
      markModelFailed(state.cooldowns, failed, now, retryAfter, { baseMs: config.cooldown.baseMs, maxMs: config.cooldown.maxMs })
      state.fallbackHops += 1
      state.isFallback = true
      state.resident = target
      state.residenceSince = now
      const ownedSeq = selectOwned(state, agent, toModelSelection(target))
      latchFallback(state, agent, turn, step, record, target, ownedSeq, manualGenBefore, configGenBefore)
      // Pre-validate the future primary return probe for the next boundary.
      if (state.primary && !sameRoute(state.primary, target)) {
        void refreshProbeSnapshot(state, state.primary)
      }
      return undefined
    }

    return undefined
  }, { prepend: true })

  // agent/status: pre-capture half-open return at running, commit latch at idle.
  const disposeStatus = ctx.on('agent/status', ({ agent, status }) => {
    observeDisable()
    if (!config.enabled) return
    const state = states.get(agent.session.id)
    if (!state) return

    if (status === 'running') {
      if (state.halfOpen) return
      if (state.isFallback && state.primary && state.resident && !sameRoute(state.resident, state.primary)) {
        const primary = state.primary
        const now = Date.now()
        if (now - state.residenceSince < config.sticky.minResidenceMs) return
        const rk = routeKey(primary)
        if (halfOpenRoutes.has(rk)) return // route-wide contention
        if (isModelInCooldown(state.cooldowns, primary, now)) return
        // Source protection: never probe away from a no-downgrade current route.
        if (state.resident && isNoDowngrade(roleConfig(state.role), state.resident)) return
        // Synchronous fail-closed re-validation of the live parts (egress/allowHosts/policy).
        if (!isAllowedHost(config, state.role, primary.provider)) return
        if (!llm || !llm.listProviders().some((p) => p.id === primary.provider)) return
        if (!childTargetAllowed(state, primary)) return
        // Async exact-model result must come from a current, non-stale snapshot.
        const snapshot = probeSnapshots.get(state.sessionId)
        if (!snapshot || snapshot.routeKey !== rk || snapshot.at < state.residenceSince
          || snapshot.manualGeneration !== state.manualGeneration
          || snapshot.configGeneration !== state.configGeneration
          || snapshot.registryRevision !== registryRevision) {
          void refreshProbeSnapshot(state, primary)
          return
        }
        if (!snapshot.authorized) return
        if (reserveHalfOpenRoute(state, primary, now)) {
          selectOwned(state, agent, toModelSelection(primary))
        }
      }
      return
    }

    if (status === 'idle') {
      // Any still-reserved probe whose turn ended without a successful commit is stale.
      if (state.halfOpen) releaseHalfOpenOwned(state)
      const latch = state.recoveryLatch
      if (!latch) return
      if (!agents?.get(agent.session.id)) { clearRecoveryLatch(state); return }
      if (latch.attempt.signal?.aborted) { clearRecoveryLatch(state); return }
      if (latch.manualGeneration !== state.manualGeneration) { clearRecoveryLatch(state); return }
      if (latch.configGeneration !== state.configGeneration) { clearRecoveryLatch(state); return }
      if (latch.ownedSelectionSeq !== state.ownedSelectionSeq) { clearRecoveryLatch(state); return }
      if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) { clearRecoveryLatch(state); return }
      if (state.autoContinueCount >= config.budget.maxAutoContinue) { clearRecoveryLatch(state); return }
      clearRecoveryLatch(state)
      state.autoContinueCount += 1
      selectOwned(state, agent, toModelSelection(latch.selection))
      agent.followup(continuationNotice({ provider: latch.attempt.provider, model: latch.attempt.model }, latch.selection))
    }
  })

  // Genuine user input resets the auto-continue episode and drops a stale latch.
  const disposeInboxInserted = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    observeDisable()
    const state = states.get(agent.session.id)
    if (!state) return
    if ((message as { source?: { kind?: string } }).source?.kind === 'user') {
      state.autoContinueCount = 0
      state.recoveryLatch = undefined
    }
  })

  // Success settlement + optional bounded Jev advisory (safe boundary).
  const disposeStep = ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    observeDisable()
    const state = states.get(agent.session.id)
    if (!state) return
    resetFailureCounters(state)
    state.fallbackHops = 0 // cross-route hop ceiling is per-episode, not lifetime

    if (state.isFallback && state.resident) clearModelCooldown(state.cooldowns, state.resident)

    if (state.halfOpen) {
      const probe = state.halfOpen.route
      if (state.halfOpenRequestObserved) {
        // Probe succeeded: record the actual resident route (primary is back).
        state.resident = probe
        state.isFallback = false
        state.residenceSince = Date.now()
        clearModelCooldown(state.cooldowns, probe)
      }
      releaseHalfOpenOwned(state)
    }

    // Drop stale per-session attempt bookkeeping at the turn boundary.
    for (const k of [...attemptByKey.keys()]) {
      if (k.startsWith(`${agent.session.id}:`)) attemptByKey.delete(k)
    }
    for (const k of [...attemptCount.keys()]) {
      if (k.startsWith(`${agent.session.id}:`)) attemptCount.delete(k)
    }

    if (!config.enabled || !config.jev.enabled || state.role !== 'root' || !state.currentTask) return
    if (signal?.aborted) return
    const rc = roleConfig('root')
    // Protect the current source from downgrade; a manual pin and sticky residence win.
    if (state.pin) return
    if (state.resident && isNoDowngrade(rc, state.resident)) return
    if (Date.now() - state.residenceSince < config.sticky.minResidenceMs) return
    const genBefore = state.configGeneration
    const manualBefore = state.manualGeneration
    const allowed = [...(rc.primary ? [rc.primary] : []), ...rc.fallbacks]
    const criteria: Record<string, string> = {}
    for (const r of allowed) {
      if (isAllowedHost(config, 'root', r.provider) && !isModelInCooldown(state.cooldowns, r, Date.now())) {
        criteria[routeKey(r)] = routeKey(r)
      }
    }
    if (Object.keys(criteria).length === 0) return
    const linked = AbortSignal.any([signal, lifetimeController.signal])
    const outcome = await classifyWithJev(config.jev, state.currentTask, criteria, linked, {
      credentials: ctx.get('credentials') as never,
    })
    // Lifetime revalidation before the second await.
    if (!config.enabled || !config.jev.enabled || linked.aborted || disposed) return
    if (genBefore !== state.configGeneration || manualBefore !== state.manualGeneration) return
    if (outcome.status === 'ok' && outcome.choice) {
      const target = allowed.find((r) => routeKey(r) === outcome.choice)
      if (target && await targetAuthorized(state, target, signal)) {
        // Final admission after the LAST await + sticky residence re-check.
        if (!finalAdmission(state, agent, manualBefore, genBefore, signal)) return
        if (Date.now() - state.residenceSince < config.sticky.minResidenceMs) return
        state.resident = target
        state.isFallback = false
        state.residenceSince = Date.now()
        state.configGeneration += 1
        selectOwned(state, agent, toModelSelection(target))
      }
    }
  })

  // Observe external model/selection and request/header for ownership/manual tracking.
  const disposeSessionEvent = ctx.on('session/event', (session, event) => {
    const id = (session as { id: string }).id
    const type = (event as { type: string }).type
    const seq = (event as { seq: number }).seq
    if (type === 'model/selection') {
      seenSelection.add(id)
      const state = states.get(id)
      if (!state) return
      if (ownSelectSeq !== undefined && seq === ownSelectSeq) return // our own synchronous write
      // External manual selection supersedes ownership, probe and fallback state.
      state.manualGeneration += 1
      state.recoveryLatch = undefined
      state.ownedSelectionSeq = undefined
      state.ownedSelection = undefined
      state.predecessorSelection = undefined
      state.isFallback = false // user took over: stop probing back
      probeSnapshots.delete(id) // manual selection invalidates the probe snapshot
      if (state.halfOpen) releaseHalfOpenOwned(state)
      return
    }
    if (type === 'request/header') {
      const state = states.get(id)
      if (!state) return
      const header = (event as { data?: { header?: { config?: { provider?: string; model?: string } } } }).data?.header
      if (state.ownedSelection && header?.config?.provider === state.ownedSelection.provider && header?.config?.model === state.ownedSelection.model) {
        // Our pending selection was consumed by a prepared request: nothing left to roll back.
        state.ownedSelectionSeq = undefined
        state.ownedSelection = undefined
        state.predecessorSelection = undefined
      }
    }
  })

  // Provider/model registry changed: invalidate cached async metadata snapshots.
  const disposeAdaptersUpdated = ctx.on('llm/adapters-updated', () => {
    registryRevision += 1
    probeSnapshots.clear()
  })

  // Inventory already-live agents at global install (safe attach, no switch).
  for (const live of agents?.list() ?? []) {
    if (states.has(live.session.id)) continue
    const role = roleOf(live)
    const s = createAgentState(live.session.id, role)
    s.parentSessionId = live.session.header.parentSession
    assignManaged(s, live)
    states.set(live.session.id, s)
  }

  /** Restore only our own still-pending selection by ownership (never newer/used). */
  const restoreOwnedSelection = (state: RouteAgentState, agent: Agent): void => {
    if (state.ownedSelection === undefined || state.predecessorSelection === undefined) return
    if (sameSelection(state.predecessorSelection, state.ownedSelection)) return
    agent.model.select({ ...state.predecessorSelection } as unknown as Readonly<ModelSelection>)
    state.ownedSelectionSeq = undefined
    state.ownedSelection = undefined
    state.predecessorSelection = undefined
  }

  const onDisableOrDispose = (): void => {
    // Abort/drain own async work (Jev, retry delays, probe refresh).
    lifetimeController.abort()
    for (const [id, state] of states) {
      clearRecoveryLatch(state)
      releaseHalfOpenOwned(state)
      const agent = agents?.get(id)
      // Roll back on BOTH live disable and normal unmount/remount. The restore
      // itself is seq-CAS: it only touches a still-owned, still-pending selection
      // (never a newer manual choice or an already-used request header).
      if (agent) restoreOwnedSelection(state, agent)
    }
    probeSnapshots.clear()
  }

  /** Detect a live `enabled` transition at the next handler boundary and roll back/re-arm. */
  const observeDisable = (): void => {
    if (disposed) return
    const nowEnabled = config.enabled === true
    if (nowEnabled === wasEnabled) return
    wasEnabled = nowEnabled
    if (!nowEnabled) onDisableOrDispose()
    else lifetimeController = new AbortController()
  }

  ctx.effect(() => () => {
    disposed = true
    onDisableOrDispose()
    disposeCreated()
    disposePreStep()
    disposeStream()
    disposeRequestError()
    disposeStatus()
    disposeInboxInserted()
    disposeStep()
    disposeSessionEvent()
    disposeAdaptersUpdated()
    void policyHandle?.dispose().catch(() => {
      /* @silent-catch: projection unregister cleanup only; dispose is best-effort */
    })
    states.clear()
    attemptByKey.clear()
    activeTurnStep.clear()
    attemptCount.clear()
    halfOpenRoutes.clear()
    seenSelection.clear()
  }, 'route-keeper.dispose()')

  observeDisable()
}
