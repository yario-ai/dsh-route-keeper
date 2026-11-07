import z from '@deepseek-ai/schemastery'

export const RouteSchema = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
})

const RoleConfigSchema = z.object({
  primary: z.union([RouteSchema, z.const(null)]).default(null),
  fallbacks: z.array(RouteSchema).default([]),
  allowHosts: z.array(z.string().min(1)).default([]),
  noDowngradeRoutes: z.array(RouteSchema).default([]),
})

const StickySchema = z.object({
  minResidenceMs: z.natural().max(31_536_000_000).default(3_600_000),
})

const CooldownSchema = z.object({
  baseMs: z.natural().min(100).max(31_536_000_000).default(60_000),
  maxMs: z.natural().min(1_000).max(31_536_000_000).default(6 * 60 * 60_000),
})

// Non-negative integer budgets only; every ceiling is finite and capped.
// `backoffMaxMs` must be >= `backoffInitialMs` (computeBackoffMs clamps the
// exponential to maxMs regardless, so a smaller max is still bounded/safe).
const BudgetSchema = z.object({
  maxRetries: z.natural().max(100).default(2),
  backoffInitialMs: z.natural().max(3_600_000).default(500),
  backoffMaxMs: z.natural().max(3_600_000).default(10_000),
  jitterRatio: z.number().min(0).max(1).default(0.1),
  maxFailureElapsedMs: z.natural().max(3_600_000).default(0),
  consecutiveFailures: z.natural().max(1_000).default(0),
  failureWindowMs: z.natural().max(86_400_000).default(0),
  failureThreshold: z.natural().min(1).max(1_000).default(2),
  condition: z.union([z.const('any'), z.const('all')]).default('any'),
  maxFallbackHops: z.natural().min(1).max(10).default(1),
  maxAutoContinue: z.natural().max(20).default(3),
})

const JevSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().min(1).default('jev-latest'),
  maxPromptChars: z.natural().min(1).max(256 * 1024).default(6_000),
  maxRequestBytes: z.natural().min(1).max(256 * 1024).default(32 * 1024),
  maxResponseBytes: z.natural().min(1).max(256 * 1024).default(64 * 1024),
  timeoutMs: z.natural().min(1).max(60_000).default(25_000),
})

export const Config = z.object({
  enabled: z.boolean().default(false),
  roles: z.object({
    root: RoleConfigSchema,
    child: RoleConfigSchema,
  }),
  sticky: StickySchema,
  cooldown: CooldownSchema,
  budget: BudgetSchema,
  jev: JevSchema,
  pin: z.union([RouteSchema, z.const(null)]).default(null),
})
