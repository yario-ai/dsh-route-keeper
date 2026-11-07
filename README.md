# dsh-route-keeper

Sticky model-route keeper for DeepSeek Harness.

`dsh-route-keeper` holds a root agent on a subscription primary model
(e.g. `openai-codex/gpt-6.1-sol`), falls back to allowed routes on quota/failure,
and transparently auto-continues the same agent (root and authorized local
child) on the fallback without concatenating partial output. It owns same-route
retries for managed routes (prepended, so native `dsh-llm-retry` is never
doubled), enforces host allowlist / role / data-flow boundaries, and optionally
asks TypeSafe System One (Jev) for an advisory next-step route.

## Features

- Sticky primary with minimum residence; bounded cooldown and single-flight
  half-open return on real requests (no synthetic paid probes).
- Plugin-owned same-route retries: `maxRetries=N` ⇒ 1+N attempts; `Retry-After`
  is honored (never shortened); `maxFailureElapsedMs` is a decision-boundary
  budget, not a hard deadline.
- Same-activation auto-continue on zero-output failures only (reasoning IS
  output); partial text/reasoning/tool-call blocks never concatenate.
- Durable parent allowlist enforcement for child fallback (fail-closed).
- Optional bounded Jev advisory to the fixed `https://api.typesafe.ai/v1/systemone`
  endpoint using the dedicated host `TYPESAFE_API_KEY` reference (no key copy,
  no login flows).

## Configuration

```yaml
- name: 'dsh-route-keeper'
  config:
    enabled: false
    roles:
      root:
        primary:   { provider: 'openai-codex', model: 'gpt-6.1-sol' }
        fallbacks: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }]
        allowHosts: ['openai-codex', 'opencode-go', 'deepseek']
        noDowngradeRoutes: []
      child:
        primary: null
        fallbacks: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }]
        allowHosts: ['opencode-go', 'deepseek']
        noDowngradeRoutes: []
    sticky: { minResidenceMs: 3600000 }
    cooldown: { baseMs: 60000, maxMs: 21600000 }
    budget:
      maxRetries: 2
      backoffInitialMs: 500
      backoffMaxMs: 10000
      jitterRatio: 0.1
      maxFailureElapsedMs: 0
      consecutiveFailures: 0
      failureWindowMs: 0
      failureThreshold: 2
      condition: any
      maxFallbackHops: 1
      maxAutoContinue: 3
    jev:
      enabled: false
      model: jev-latest
      maxPromptChars: 6000
      maxRequestBytes: 32768
      maxResponseBytes: 65536
      timeoutMs: 25000
    pin: null
```

`enabled: false` plus empty `allowHosts` is a passive no-op. Disable/rollback
without source changes: set `enabled: false` or remove the profile plugin row.

## Provider notes

A provider that hangs silently is bounded only by its `streamIdleTimeoutMs`
(in `dsh-llm-pi-ai` providers settings, default `300000` ms). Route-keeper does
not promise a total-generation deadline; `maxFailureElapsedMs` measures elapsed
failure observation up to the fallback decision.

## License

MIT. See `LICENSE` and `NOTICE` for retained dsh-shift-router attribution.
