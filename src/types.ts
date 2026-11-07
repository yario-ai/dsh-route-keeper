/**
 * Shared value types for dsh-route-keeper.
 * Pure module types (no host imports) so the policy core is unit-testable
 * against a fake clock and fake providers.
 */

/** Exact provider/model route. */
export interface Route {
  provider: string
  model: string
}

/** Detached model selection (what `agent.model.select()` consumes). */
export interface Selection extends Route {
  reasoningEffort?: string
}

/** Provider-neutral failure facts surfaced by the host `agent/request-error`. */
export interface Failure {
  code: string
  message: string
  status?: number
  providerRetryAfterMs?: number
  requestId?: string
  offloadImages?: number
}

/** Role of an agent for policy purposes. */
export type Role = 'root' | 'child'

/** Why a failure is classified one way. */
export type FallbackClass =
  | 'transient-rate'
  | 'quota-reset'
  | 'server-transport'
  | 'permanent'
  | 'unknown'

/** One chunk of the host stream protocol (subset we need). */
export type StreamChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call-delta'; argumentsDelta?: string; name?: string }
  | { type: 'block-start'; blockType?: string }
  | { type: 'block-end'; block?: unknown }
  | { type: 'usage' }
  | { type: 'finish' }
  | { type: string; [key: string]: unknown }

/** Per-attempt correlation record built by the `llm/stream` observer. */
export interface AttemptRecord {
  attemptId: object
  sessionId: string
  turn: number
  step: number
  provider: string
  model: string
  hasOutput: boolean
  /** Original request signal, retained for cancellation-sensitive latching. */
  signal?: AbortSignal
}

/** Per-agent route-state machine (in-memory, deterministic clock). */
export interface RouteAgentState {
  sessionId: string
  role: Role
  /** Durable parent session id for a child; undefined for roots / unknown. */
  parentSessionId: string | undefined
  /** Currently resident route, or undefined until first admission. */
  resident: Route | undefined
  /** Sticky primary the agent returns to on managed return. */
  primary: Route | undefined
  /** Route we are currently on for fallback purposes (resident == fallback). */
  isFallback: boolean
  /** Routes this plugin owns for the agent (assigned source + configured set). */
  managedRoutes: Route[]
  /** The route the agent was assigned at admission (child explicit/inherited). */
  assignedSource: Route | undefined
  /** Number of cross-route fallback hops taken (bounded by maxFallbackHops). */
  fallbackHops: number
  /** Cooldown map: routeKey -> {until, attempts}. */
  cooldowns: Map<string, CooldownEntry>
  /** Half-open probe reservation. */
  halfOpen: { route: Route; reservedAt: number } | undefined
  /** Whether a branded request was observed on the current half-open probe. */
  halfOpenRequestObserved: boolean
  /** Manual pin, if any. */
  pin: Selection | undefined
  /** Sticky residence: when the current primary became resident. */
  residenceSince: number
  /** Recovery latch pending an `agent/status idle` commit. */
  recoveryLatch: RecoveryLatch | undefined
  /** Seq of our latest still-pending `model/selection` write (ownership). */
  ownedSelectionSeq: number | undefined
  /** The selection we wrote at `ownedSelectionSeq`. */
  ownedSelection: Selection | undefined
  /** The selection that was pending before our latest owned write. */
  predecessorSelection: Selection | undefined
  /** Bumped on every external (non-plugin) `model/selection` event. */
  manualGeneration: number
  /** Bumped on every plugin-applied config-driven selection (pin/primary). */
  configGeneration: number
  /** Bumped on every genuine user input entering the inbox (turn or step). */
  inputGeneration: number
  /** Terminal-failure accounting. */
  consecutiveFailures: number
  failureWindow: number[]
  /** Start of the current failure episode (first failure since last success). */
  firstFailureAt: number | undefined
  /** Bounded auto-continue episode counter. */
  autoContinueCount: number
  /** Bounded current task text for optional Jev advisory. */
  currentTask: string | undefined
}

export interface CooldownEntry {
  until: number
  attempts: number
}

export interface RecoveryLatch {
  sessionId: string
  turn: number
  step: number
  selection: Selection
  attempt: AttemptRecord
  manualGeneration: number
  configGeneration: number
  ownedSelectionSeq: number | undefined
}

/** Failure budget configuration. */
export interface BudgetConfig {
  maxRetries: number
  backoffInitialMs: number
  backoffMaxMs: number
  jitterRatio: number
  maxFailureElapsedMs: number
  consecutiveFailures: number
  failureWindowMs: number
  failureThreshold: number
  condition: 'any' | 'all'
  maxFallbackHops: number
  maxAutoContinue: number
}

/** One role's route policy. */
export interface RoleConfig {
  primary: Route | null
  fallbacks: Route[]
  allowHosts: string[]
  noDowngradeRoutes: Route[]
}

/** Jev (TypeSafe) configuration — fixed-origin subset per the owner addendum. */
export interface JevConfig {
  enabled: boolean
  model: string
  maxPromptChars: number
  maxRequestBytes: number
  maxResponseBytes: number
  timeoutMs: number
}

/** The whole plugin config. */
export interface RouteKeeperConfig {
  enabled: boolean
  roles: { root: RoleConfig; child: RoleConfig }
  sticky: { minResidenceMs: number }
  cooldown: { baseMs: number; maxMs: number }
  budget: BudgetConfig
  jev: JevConfig
  pin: Selection | null
}

export function routeKey(route: Route): string {
  return `${route.provider}/${route.model}`
}

export function sameRoute(a: Route | undefined, b: Route | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.provider === b.provider && a.model === b.model
}

export function sameSelection(a: Selection | undefined, b: Selection | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}
