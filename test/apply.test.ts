import { describe, expect, it } from 'vitest'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../lib/index.js'

type Listener = (payload: any, next?: any) => any

function makeHarness(config: any) {
  const listeners = new Map<string, { fn: Listener; prepend: boolean }[]>()
  const disposers: Array<() => void> = []
  const calls: string[] = []

  const agent = {
    id: 's1',
    session: {
      id: 's1',
      seq: 0,
      header: { parentSession: undefined, delegationDepth: 0 },
      append: () => { agent.session.seq += 1 },
    },
    model: {
      current: () => ({ provider: 'openai-codex', model: 'gpt-6.1-sol' }),
      select: (sel: any) => { calls.push(`select:${sel.provider}/${sel.model}`) },
    },
    options: { provider: 'openai-codex', model: 'gpt-6.1-sol' },
    inbox: { nextTurn: [] as any[], nextStep: [] as any[] },
    status: 'idle',
    followup: (m: any) => { calls.push('followup') },
    ctx: {},
  }

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
        listProviders: () => [{ id: 'openai-codex', name: 'codex' }, { id: 'opencode-go', name: 'go' }],
        resolveModelInfo: async (p: string, m: string) => ({ provider: p, id: m, name: m }),
      }
      if (name === 'agents') return {
        currentInitiator: () => undefined,
        list: () => [],
        get: () => agent,
      }
      if (name === 'sessionProjections') return {
        register: async () => ({ stateOf: () => null, dispose: async () => {} }),
      }
      if (name === 'credentials') return undefined
      return undefined
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }

  const fire = (name: string, payload: any, next?: () => any): any => {
    const list = listeners.get(name) ?? []
    const ordered = [...list.filter((l) => l.prepend), ...list.filter((l) => !l.prepend)]
    if (ordered.length === 0) return next ? next() : undefined
    // route-keeper is the only listener in these tests; pass a `next` that
    // delegates to the caller-provided default.
    return ordered[0].fn(payload, () => (next ? next() : undefined))
  }

  return { ctx, agent, calls, fire, listeners, disposers }
}

const cfg = {
  enabled: true,
  roles: {
    root: { primary: { provider: 'openai-codex', model: 'gpt-6.1-sol' }, fallbacks: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }], allowHosts: ['openai-codex', 'opencode-go'], noDowngradeRoutes: [] },
    child: { primary: null, fallbacks: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }], allowHosts: ['opencode-go'], noDowngradeRoutes: [] },
  },
  sticky: { minResidenceMs: 1000 },
  cooldown: { baseMs: 60000, maxMs: 21600000 },
  budget: { maxRetries: 1, backoffInitialMs: 10, backoffMaxMs: 10, jitterRatio: 0, maxFailureElapsedMs: 0, consecutiveFailures: 0, failureWindowMs: 0, failureThreshold: 2, condition: 'any', maxFallbackHops: 1, maxAutoContinue: 2 },
  jev: { enabled: false, model: 'jev-latest', maxPromptChars: 6000, maxRequestBytes: 32768, maxResponseBytes: 65536, timeoutMs: 25000 },
  pin: null,
}

describe('apply-level handler lifecycle', () => {
  it('managed quota: prepend handler latches fallback and idle commits followup', async () => {
    const h = makeHarness(cfg)
    await apply(h.ctx, cfg as any)

    // agent/created registers state (sticky primary select)
    await h.fire('agent/created', { agent: h.agent, source: 'startup' })

    // pre-step caches turn/step
    await h.fire('agent/pre-step', { agent: h.agent, turn: 1, step: 1, messages: [] }, () => ({ kind: 'enter', messages: [] }))

    // branded request observer (real WeakSet brand)
    const request: any = markAgentLoopRequest({ sessionId: 's1', provider: 'openai-codex', model: 'gpt-6.1-sol', signal: undefined } as any)
    const stream = h.fire('llm/stream', request, async function* () { yield { type: 'finish', reason: { kind: 'error' } } as any })
    for await (const _ of stream) { /* consume */ }

    // request-error: managed QUOTA → fallback + latch (terminal undefined)
    const action = await h.fire('agent/request-error', {
      agent: h.agent, turn: 1, step: 1, provider: 'openai-codex', failure: { code: 'QUOTA', message: 'q' }, retryPolicy: undefined, signal: new AbortController().signal,
    })
    expect(action).toBeUndefined()
    expect(h.calls).toContain('select:opencode-go/deepseek-v4.1-flash')

    // idle: commit latch → select + followup
    await h.fire('agent/status', { agent: h.agent, status: 'idle' })
    expect(h.calls).toContain('followup')
  })

  it('unmanaged route delegates native (does not short-circuit)', async () => {
    const h = makeHarness(cfg)
    await apply(h.ctx, cfg as any)
    await h.fire('agent/created', { agent: h.agent, source: 'startup' })
    await h.fire('agent/pre-step', { agent: h.agent, turn: 1, step: 1, messages: [] }, () => ({ kind: 'enter', messages: [] }))
    const request: any = markAgentLoopRequest({ sessionId: 's1', provider: 'some-other', model: 'm', signal: undefined } as any)
    const stream = h.fire('llm/stream', request, async function* () { yield { type: 'finish', reason: { kind: 'error' } } as any })
    for await (const _ of stream) { /* consume */ }
    const delegated = await h.fire('agent/request-error', {
      agent: h.agent, turn: 1, step: 1, provider: 'some-other', failure: { code: 'QUOTA', message: 'q' }, retryPolicy: undefined, signal: new AbortController().signal,
    }, () => 'NATIVE')
    expect(delegated).toBe('NATIVE')
  })

  it('partial output on managed route is terminal (no latch, no native)', async () => {
    const h = makeHarness(cfg)
    await apply(h.ctx, cfg as any)
    await h.fire('agent/created', { agent: h.agent, source: 'startup' })
    await h.fire('agent/pre-step', { agent: h.agent, turn: 1, step: 1, messages: [] }, () => ({ kind: 'enter', messages: [] }))
    const request: any = markAgentLoopRequest({ sessionId: 's1', provider: 'openai-codex', model: 'gpt-6.1-sol', signal: undefined } as any)
    const stream = h.fire('llm/stream', request, async function* () { yield { type: 'text-delta', text: 'partial' } as any; yield { type: 'finish', reason: { kind: 'error' } } as any })
    for await (const _ of stream) { /* consume */ }
    const action = await h.fire('agent/request-error', {
      agent: h.agent, turn: 1, step: 1, provider: 'openai-codex', failure: { code: 'QUOTA', message: 'q' }, retryPolicy: undefined, signal: new AbortController().signal,
    })
    expect(action).toBeUndefined()
    expect(h.calls.filter((c) => c.startsWith('select:')).length).toBe(1) // only initial primary, no fallback select
    await h.fire('agent/status', { agent: h.agent, status: 'idle' })
    expect(h.calls).not.toContain('followup')
  })
})
