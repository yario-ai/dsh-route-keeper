import { describe, expect, it, vi } from 'vitest'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { apply } from '../lib/index.js'

type Listener = (payload: any, next?: any) => any

interface HarnessOptions {
  resolveModelInfo?: (provider: string, model: string) => Promise<any> | any
  policyStateOf?: (session: any) => any
  parentAgent?: any
  providers?: Array<{ id: string; name?: string }>
  credentials?: any
}

/**
 * Realistic in-memory harness: `agent.model.select()` actually appends a
 * `model/selection` session event and advances `session.seq`, `current()` reads
 * pending ?? lastUsed ?? options, and `session/event` listeners fire on every
 * append. This lets the apply-level handlers exercise real event-seq/CAS,
 * ownership and manual-generation branches instead of stubbed constants.
 */
function makeHarness(config: any, opts: HarnessOptions = {}) {
  const listeners = new Map<string, { fn: Listener; prepend: boolean }[]>()
  const disposers: Array<() => void> = []
  const calls: string[] = []
  const sessionEvents: Array<{ type: string; seq: number; data: any }> = []

  let pending: any = undefined
  let lastUsed: any = undefined

  const agent: any = {
    id: 's1',
    session: {
      id: 's1',
      seq: 0,
      header: { parentSession: opts.parentAgent?.session?.id, delegationDepth: opts.parentAgent ? 1 : 0 },
    },
    options: { provider: 'openai-codex', model: 'gpt-6.1-sol', subagentDepth: opts.parentAgent ? 1 : undefined },
    inbox: { nextTurn: [] as any[], nextStep: [] as any[] },
    status: 'idle',
    followup: (m: any) => { calls.push('followup') },
    ctx: {},
  }

  const emitSessionEvent = (type: string, data: any): number => {
    const seq = agent.session.seq
    agent.session.seq += 1
    const event = { type, seq, time: Date.now(), data }
    sessionEvents.push(event)
    for (const { fn } of listeners.get('session/event') ?? []) {
      fn(agent.session, event)
    }
    return seq
  }

  agent.model = {
    current: () => {
      const recorded = pending ?? lastUsed
      if (recorded) return { ...recorded }
      const { provider, model } = agent.options
      return provider && model ? { provider, model } : undefined
    },
    select: (sel: any) => {
      const recorded = pending ?? lastUsed
      if (recorded && recorded.provider === sel.provider && recorded.model === sel.model
        && (recorded.reasoningEffort ?? undefined) === (sel.reasoningEffort ?? undefined)) {
        return // no-op
      }
      calls.push(`select:${sel.provider}/${sel.model}`)
      const data = { provider: sel.provider, model: sel.model, ...(sel.reasoningEffort === undefined ? {} : { reasoningEffort: sel.reasoningEffort }) }
      emitSessionEvent('model/selection', data)
      pending = { ...data }
    },
    retireHeader: (provider: string, model: string) => {
      emitSessionEvent('request/header', { header: { config: { provider, model } } })
      if (pending && pending.provider === provider && pending.model === model) {
        lastUsed = pending
        pending = undefined
      }
    },
  }

  const providers = opts.providers ?? [
    { id: 'openai-codex', name: 'codex' },
    { id: 'opencode-go', name: 'go' },
  ]

  const ctx: any = {
    on(name: string, fn: Listener, options?: boolean | { prepend?: boolean }) {
      const prepend = typeof options === 'object' && options.prepend === true
      const list = listeners.get(name) ?? []
      list.push({ fn, prepend })
      listeners.set(name, list)
      return () => { const i = list.findIndex((e) => e.fn === fn); if (i >= 0) list.splice(i, 1) }
    },
    effect(exec: () => () => void) {
      const d = exec()
      disposers.push(d)
      return () => {}
    },
    get(name: string) {
      if (name === 'llm') return {
        listProviders: () => providers,
        resolveModelInfo: opts.resolveModelInfo
          ? (p: string, m: string) => opts.resolveModelInfo!(p, m)
          : async (p: string, m: string) => ({ provider: p, id: m, name: m }),
      }
      if (name === 'agents') return {
        currentInitiator: () => undefined,
        list: () => [],
        get: (id: string) => (id === agent.id ? agent : opts.parentAgent && id === opts.parentAgent.id ? opts.parentAgent : undefined),
      }
      if (name === 'sessionProjections') return {
        register: async () => ({
          stateOf: opts.policyStateOf ?? (() => null),
          dispose: async () => {},
        }),
      }
      if (name === 'credentials') return opts.credentials
      return undefined
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }

  const fire = (name: string, payload: any, next?: () => any): any => {
    const list = listeners.get(name) ?? []
    const ordered = [...list.filter((l) => l.prepend), ...list.filter((l) => !l.prepend)]
    if (ordered.length === 0) return next ? next() : undefined
    return ordered[0].fn(payload, () => (next ? next() : undefined))
  }

  const fireExternalSelect = (sel: any) => { agent.model.select(sel) }
  const fireRequestHeader = (provider: string, model: string) => { agent.model.retireHeader(provider, model) }
  const dispose = () => { for (const d of [...disposers].reverse()) d() }

  return { ctx, agent, calls, fire, fireExternalSelect, fireRequestHeader, listeners, disposers, dispose, sessionEvents }
}

const cfg = {
  enabled: true,
  roles: {
    root: { primary: { provider: 'openai-codex', model: 'gpt-6.1-sol' }, fallbacks: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }], allowHosts: ['openai-codex', 'opencode-go'], noDowngradeRoutes: [] },
    child: { primary: null, fallbacks: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }], allowHosts: ['opencode-go'], noDowngradeRoutes: [] },
  },
  sticky: { minResidenceMs: 1000 },
  cooldown: { baseMs: 60000, maxMs: 21600000 },
  budget: { maxRetries: 0, backoffInitialMs: 10, backoffMaxMs: 10, jitterRatio: 0, maxFailureElapsedMs: 0, consecutiveFailures: 0, failureWindowMs: 0, failureThreshold: 2, condition: 'any', maxFallbackHops: 1, maxAutoContinue: 2 },
  jev: { enabled: false, model: 'jev-latest', maxPromptChars: 6000, maxRequestBytes: 32768, maxResponseBytes: 65536, timeoutMs: 25000 },
  pin: null,
}

const PRIMARY = 'select:openai-codex/gpt-6.1-sol'
const FALLBACK = 'select:opencode-go/deepseek-v4.1-flash'

async function startManagedFallback(h: ReturnType<typeof makeHarness>, provider = 'openai-codex', model = 'gpt-6.1-sol') {
  await h.fire('agent/created', { agent: h.agent, source: 'startup' })
  await h.fire('agent/pre-step', { agent: h.agent, turn: 1, step: 1, messages: [] }, () => ({ kind: 'enter', messages: [] }))
  const request: any = markAgentLoopRequest({ sessionId: 's1', provider, model, signal: undefined } as any)
  const stream = h.fire('llm/stream', request, async function* () { yield { type: 'finish', reason: { kind: 'error' } } as any })
  for await (const _ of stream) { /* consume */ }
  return h.fire('agent/request-error', {
    agent: h.agent, turn: 1, step: 1, provider, failure: { code: 'QUOTA', message: 'q' }, retryPolicy: undefined, signal: new AbortController().signal,
  })
}

describe('apply-level ownership / CAS', () => {
  it('manual select during async pick is not overwritten (no stale fallback select)', async () => {
    let release: ((v: any) => void) | undefined
    const gate = new Promise<any>((res) => { release = res })
    const h = makeHarness(cfg, {
      resolveModelInfo: (p, m) => (m === 'deepseek-v4.1-flash' ? gate : { provider: p, id: m, name: m }),
    })
    await apply(h.ctx, cfg as any)
    await h.fire('agent/created', { agent: h.agent, source: 'startup' })
    await h.fire('agent/pre-step', { agent: h.agent, turn: 1, step: 1, messages: [] }, () => ({ kind: 'enter', messages: [] }))
    const request: any = markAgentLoopRequest({ sessionId: 's1', provider: 'openai-codex', model: 'gpt-6.1-sol', signal: undefined } as any)
    const stream = h.fire('llm/stream', request, async function* () { yield { type: 'finish', reason: { kind: 'error' } } as any })
    for await (const _ of stream) { /* consume */ }

    const errPromise = h.fire('agent/request-error', {
      agent: h.agent, turn: 1, step: 1, provider: 'openai-codex', failure: { code: 'QUOTA', message: 'q' }, retryPolicy: undefined, signal: new AbortController().signal,
    })
    // External manual selection arrives while pickFallback awaits resolveModelInfo.
    h.fireExternalSelect({ provider: 'deepseek', model: 'deepseek-v4-pro' })
    release!({ provider: 'opencode-go', id: 'deepseek-v4.1-flash', name: 'flash' })
    const action = await errPromise
    expect(action).toBeUndefined()
    expect(h.calls).not.toContain(FALLBACK)
    await h.fire('agent/status', { agent: h.agent, status: 'idle' })
    expect(h.calls).not.toContain('followup')
    // Newer user choice survives.
    expect(h.agent.model.current()).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' })
  })

  it('cancel after latch drops idle commit (no stale self-wake)', async () => {
    const h = makeHarness(cfg)
    await apply(h.ctx, cfg as any)
    const ac = new AbortController()
    await h.fire('agent/created', { agent: h.agent, source: 'startup' })
    await h.fire('agent/pre-step', { agent: h.agent, turn: 1, step: 1, messages: [] }, () => ({ kind: 'enter', messages: [] }))
    const request: any = markAgentLoopRequest({ sessionId: 's1', provider: 'openai-codex', model: 'gpt-6.1-sol', signal: ac.signal } as any)
    const stream = h.fire('llm/stream', request, async function* () { yield { type: 'finish', reason: { kind: 'error' } } as any })
    for await (const _ of stream) { /* consume */ }
    await h.fire('agent/request-error', {
      agent: h.agent, turn: 1, step: 1, provider: 'openai-codex', failure: { code: 'QUOTA', message: 'q' }, retryPolicy: undefined, signal: ac.signal,
    })
    expect(h.calls).toContain(FALLBACK)
    ac.abort()
    await h.fire('agent/status', { agent: h.agent, status: 'idle' })
    expect(h.calls).not.toContain('followup')
  })

  it('new user input after latch drops idle commit', async () => {
    const h = makeHarness(cfg)
    await apply(h.ctx, cfg as any)
    await startManagedFallback(h)
    expect(h.calls).toContain(FALLBACK)
    h.agent.inbox.nextTurn.push({ id: 'u1' })
    await h.fire('agent/status', { agent: h.agent, status: 'idle' })
    expect(h.calls).not.toContain('followup')
  })

  it('disable restores only our own still-pending selection', async () => {
    const h = makeHarness(cfg)
    await apply(h.ctx, cfg as any)
    await startManagedFallback(h)
    expect(h.agent.model.current()).toEqual({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
    cfg.enabled = false
    await h.fire('agent/pre-step', { agent: h.agent, turn: 2, step: 1, messages: [] }, () => ({ kind: 'enter', messages: [] }))
    expect(h.agent.model.current()).toEqual({ provider: 'openai-codex', model: 'gpt-6.1-sol' })
    cfg.enabled = true
  })

  it('external manual select supersedes ownership: disable does NOT overwrite newer choice', async () => {
    const h = makeHarness(cfg)
    await apply(h.ctx, cfg as any)
    await startManagedFallback(h)
    expect(h.agent.model.current()).toEqual({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
    h.fireExternalSelect({ provider: 'deepseek', model: 'deepseek-v4-pro' })
    cfg.enabled = false
    await h.fire('agent/pre-step', { agent: h.agent, turn: 2, step: 1, messages: [] }, () => ({ kind: 'enter', messages: [] }))
    expect(h.agent.model.current()).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' })
    cfg.enabled = true
  })

  it('used request header clears ownership: disable does not restore an already-used selection', async () => {
    const h = makeHarness(cfg)
    await apply(h.ctx, cfg as any)
    await startManagedFallback(h)
    h.fireRequestHeader('opencode-go', 'deepseek-v4.1-flash')
    cfg.enabled = false
    await h.fire('agent/pre-step', { agent: h.agent, turn: 2, step: 1, messages: [] }, () => ({ kind: 'enter', messages: [] }))
    expect(h.agent.model.current()).toEqual({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
    cfg.enabled = true
  })
})

describe('uniform authorization on every select edge', () => {
  it('creation pin to an unknown model is blocked', async () => {
    const pinned = { ...cfg, pin: { provider: 'openai-codex', model: 'no-such-model' } }
    const h = makeHarness(pinned, { resolveModelInfo: async () => { throw new Error('UNKNOWN_MODEL') } })
    await apply(h.ctx, pinned as any)
    await h.fire('agent/created', { agent: h.agent, source: 'startup' })
    expect(h.calls.filter((c) => c.startsWith('select:')).length).toBe(0)
  })

  it('creation pin outside allowHosts is blocked', async () => {
    const pinned = { ...cfg, pin: { provider: 'evil-host', model: 'm' } }
    const h = makeHarness(pinned)
    await apply(h.ctx, pinned as any)
    await h.fire('agent/created', { agent: h.agent, source: 'startup' })
    expect(h.calls.filter((c) => c.startsWith('select:')).length).toBe(0)
  })

  it('empty allowHosts fails closed (no automatic fallback select)', async () => {
    const empty = { ...cfg, roles: { ...cfg.roles, root: { ...cfg.roles.root, allowHosts: [] } } }
    const h = makeHarness(empty)
    await apply(h.ctx, empty as any)
    await startManagedFallback(h)
    expect(h.calls).not.toContain(FALLBACK)
  })

  it('protected (no-downgrade) current source does not fall back', async () => {
    const protectedCfg = { ...cfg, roles: { ...cfg.roles, root: { ...cfg.roles.root, noDowngradeRoutes: [{ provider: 'openai-codex', model: 'gpt-6.1-sol' }] } } }
    const h = makeHarness(protectedCfg)
    await apply(h.ctx, protectedCfg as any)
    await startManagedFallback(h)
    expect(h.calls).not.toContain(FALLBACK)
    expect(h.calls).not.toContain('followup')
  })

  it('child fallback target outside parent policy is forbidden', async () => {
    const parent: any = {
      id: 'p1', session: { id: 'p1', seq: 0, header: { delegationDepth: 0 } },
      model: { current: () => ({ provider: 'openai-codex', model: 'gpt-6.1-sol' }) },
      options: { provider: 'openai-codex', model: 'gpt-6.1-sol' }, inbox: { nextTurn: [], nextStep: [] },
    }
    const h = makeHarness(cfg, { parentAgent: parent, policyStateOf: () => [{ provider: 'openai-codex', model: 'gpt-6.1-sol' }] })
    await apply(h.ctx, cfg as any)
    await startManagedFallback(h)
    expect(h.calls).not.toContain(FALLBACK)
  })

  it('unbranded auxiliary stream never creates the attempt latch (managed failure is denied)', async () => {
    const h = makeHarness(cfg)
    await apply(h.ctx, cfg as any)
    await h.fire('agent/created', { agent: h.agent, source: 'startup' })
    await h.fire('agent/pre-step', { agent: h.agent, turn: 1, step: 1, messages: [] }, () => ({ kind: 'enter', messages: [] }))
    const aux: any = { sessionId: 's1', provider: 'openai-codex', model: 'gpt-6.1-sol', signal: undefined }
    const stream = h.fire('llm/stream', aux, async function* () { yield { type: 'text-delta', text: 'x' } as any })
    for await (const _ of stream) { /* consume */ }
    const action = await h.fire('agent/request-error', {
      agent: h.agent, turn: 1, step: 1, provider: 'openai-codex', failure: { code: 'QUOTA', message: 'q' }, retryPolicy: undefined, signal: new AbortController().signal,
    }, () => 'NATIVE')
    expect(action).toBeUndefined()
    expect(h.calls).not.toContain(FALLBACK)
  })
})

describe('state-machine completeness', () => {
  it('min-residence not elapsed holds the primary return probe', async () => {
    const h = makeHarness(cfg)
    await apply(h.ctx, cfg as any)
    await startManagedFallback(h)
    await h.fire('agent/status', { agent: h.agent, status: 'running' })
    // Only the initial sticky-primary select; no additional probe select yet.
    expect(h.calls.filter((c) => c === PRIMARY).length).toBe(1)
  })

  it('probe returns to primary after residence + prevalidated authorized snapshot', async () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness(cfg)
      await apply(h.ctx, cfg as any)
      await startManagedFallback(h)
      // Flush the fire-and-forget probe snapshot refresh.
      await Promise.resolve()
      await Promise.resolve()
      vi.setSystemTime(Date.now() + 2000)
      await h.fire('agent/status', { agent: h.agent, status: 'running' })
      expect(h.calls).toContain(PRIMARY)
    } finally {
      vi.useRealTimers()
    }
  })

  it('probe failure releases reservation and stays on fallback', async () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness(cfg)
      await apply(h.ctx, cfg as any)
      await startManagedFallback(h)
      await Promise.resolve(); await Promise.resolve()
      vi.setSystemTime(Date.now() + 2000)
      await h.fire('agent/status', { agent: h.agent, status: 'running' })
      expect(h.calls).toContain(PRIMARY)
      // Probe request fails on primary.
      await h.fire('agent/pre-step', { agent: h.agent, turn: 2, step: 1, messages: [] }, () => ({ kind: 'enter', messages: [] }))
      const request: any = markAgentLoopRequest({ sessionId: 's1', provider: 'openai-codex', model: 'gpt-6.1-sol', signal: undefined } as any)
      const stream = h.fire('llm/stream', request, async function* () { yield { type: 'finish', reason: { kind: 'error' } } as any })
      for await (const _ of stream) { /* consume */ }
      await h.fire('agent/request-error', {
        agent: h.agent, turn: 2, step: 1, provider: 'openai-codex', failure: { code: 'QUOTA', message: 'q' }, retryPolicy: undefined, signal: new AbortController().signal,
      })
      // Probe failed → released; resident stays fallback (another running can re-probe after residence).
      expect(h.calls).toContain(FALLBACK)
    } finally {
      vi.useRealTimers()
    }
  })

  it('maxAutoContinue bounds consecutive auto-continue followups', async () => {
    const multi = {
      ...cfg,
      roles: {
        ...cfg.roles,
        root: {
          ...cfg.roles.root,
          fallbacks: [
            { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
            { provider: 'deepseek', model: 'deepseek-v4-pro' },
          ],
          allowHosts: ['openai-codex', 'opencode-go', 'deepseek'],
        },
      },
      budget: { ...cfg.budget, maxFallbackHops: 2, maxAutoContinue: 1 },
    }
    const h = makeHarness(multi, {
      providers: [
        { id: 'openai-codex', name: 'codex' },
        { id: 'opencode-go', name: 'go' },
        { id: 'deepseek', name: 'ds' },
      ],
    })
    await apply(h.ctx, multi as any)

    // Cycle 1: primary fails → fallback b → idle commits followup (count 1).
    await startManagedFallback(h)
    await h.fire('agent/status', { agent: h.agent, status: 'idle' })
    expect(h.calls.filter((c) => c === 'followup').length).toBe(1)

    // Cycle 2: fallback b fails → fallback c → latch armed, but auto-continue budget exhausted → no followup.
    await h.fire('agent/pre-step', { agent: h.agent, turn: 2, step: 1, messages: [] }, () => ({ kind: 'enter', messages: [] }))
    const req: any = markAgentLoopRequest({ sessionId: 's1', provider: 'opencode-go', model: 'deepseek-v4.1-flash', signal: undefined } as any)
    const stream = h.fire('llm/stream', req, async function* () { yield { type: 'finish', reason: { kind: 'error' } } as any })
    for await (const _ of stream) { /* consume */ }
    await h.fire('agent/request-error', {
      agent: h.agent, turn: 2, step: 1, provider: 'opencode-go', failure: { code: 'QUOTA', message: 'q' }, retryPolicy: undefined, signal: new AbortController().signal,
    })
    await h.fire('agent/status', { agent: h.agent, status: 'idle' })
    expect(h.calls.filter((c) => c === 'followup').length).toBe(1)
  })
})

describe('Jev integration lifetime guards', () => {
  it('dispose during Jev prevents a late select', async () => {
    const jevCfg = { ...cfg, jev: { ...cfg.jev, enabled: true, timeoutMs: 60000 } }
    const hanging = { resolve: () => new Promise<{ value?: string }>(() => {}) }
    const h = makeHarness(jevCfg, { credentials: hanging })
    await apply(h.ctx, jevCfg as any)
    await h.fire('agent/created', { agent: h.agent, source: 'startup' })
    await h.fire('agent/pre-step', { agent: h.agent, turn: 1, step: 1, messages: [{ content: [{ type: 'text', text: 'task for jev' }] }] }, () => ({ kind: 'enter', messages: [] }))
    const signal = new AbortController().signal
    const p = h.fire('agent/turn-stopping', { agent: h.agent, turn: 1, signal })
    // turn-stopping now awaits credentials.resolve (hanging); dispose aborts lifetime.
    h.dispose()
    await p
    // Only the initial sticky-primary select; no Jev-driven select.
    expect(h.calls.filter((c) => c.startsWith('select:')).length).toBe(1)
  })

  it('oversize task is not truncated and produces no Jev select', async () => {
    const jevCfg = { ...cfg, jev: { ...cfg.jev, enabled: true, maxPromptChars: 10 } }
    const h = makeHarness(jevCfg, { credentials: { resolve: async () => ({ value: 'k' }) } })
    await apply(h.ctx, jevCfg as any)
    await h.fire('agent/created', { agent: h.agent, source: 'startup' })
    await h.fire('agent/pre-step', { agent: h.agent, turn: 1, step: 1, messages: [{ content: [{ type: 'text', text: 'this task is far longer than the budget allows' }] }] }, () => ({ kind: 'enter', messages: [] }))
    await h.fire('agent/turn-stopping', { agent: h.agent, turn: 1, signal: new AbortController().signal })
    expect(h.calls.filter((c) => c.startsWith('select:')).length).toBe(1) // only initial primary
  })

  it('continuation notice / child delivery never overwrites or leaks the user task', async () => {
    const jevCfg = { ...cfg, jev: { ...cfg.jev, enabled: true, maxPromptChars: 1000 } }
    const seenStates: string[] = []
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      seenStates.push(JSON.parse(init.body).state)
      return new Response(JSON.stringify({ answers: { model: { choice: 'openai-codex/gpt-6.1-sol', confidence: 0.9 } } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const h = makeHarness(jevCfg, { credentials: { resolve: async () => ({ value: 'k' }) } })
      await apply(h.ctx, jevCfg as any)
      await h.fire('agent/created', { agent: h.agent, source: 'startup' })
      const user = (text: string) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
      const notice = (text: string) => ({ source: { kind: 'model-selection', form: 'notice', summary: text }, content: [{ type: 'text', text }] })

      // Turn 1: genuine user task.
      await h.fire('agent/pre-step', { agent: h.agent, turn: 1, step: 1, messages: [user('do task A')] }, () => ({ kind: 'enter', messages: [] }))
      await h.fire('agent/turn-stopping', { agent: h.agent, turn: 1, signal: new AbortController().signal })
      // Turn 2: only a continuation notice (automatic continuation, no user text).
      await h.fire('agent/pre-step', { agent: h.agent, turn: 2, step: 1, messages: [notice('[route-keeper: provider switch x → y]')] }, () => ({ kind: 'enter', messages: [] }))
      await h.fire('agent/turn-stopping', { agent: h.agent, turn: 2, signal: new AbortController().signal })

      expect(seenStates).toEqual(['do task A', 'do task A'])
      expect(seenStates.join(' ')).not.toContain('provider switch')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
