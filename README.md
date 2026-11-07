# dsh-route-keeper

Sticky model-route keeper for DeepSeek Harness.

`dsh-route-keeper` holds a root agent on a subscription primary model
(e.g. `openai-codex/gpt-6.1-sol`), falls back to allowed routes on quota/failure,
and transparently auto-continues the same agent (root and authorized local
child) on the fallback without concatenating partial output. It owns same-route
retries for managed routes (prepended, so native `dsh-llm-retry` is never
doubled), enforces host allowlist / role / data-flow boundaries, and optionally
asks TypeSafe System One (Jev) for an advisory next-step route.

## Installation

Tested against DeepSeek Harness `0.2.2-rc.1` on Node `>=24`.

- Desktop profiles are managed exclusively through the DSH bundle/plugin
  manager in the GUI: add the reviewed `dsh-route-keeper-<version>.tgz` bundle
  there, then enable it in the profile settings.
- The isolated headless CLI is for tests only (never the desktop profile):

  ```sh
  dsh plugin --profile headless add ./dsh-route-keeper-<version>.tgz
  ```

- The plugin is **disabled by default** and does nothing until you set
  `enabled: true` and explicitly list the role `allowHosts`.

## Scope and profiles

When enabled in a profile, the plugin covers every root and local child agent in
all workspaces of that profile. Other profiles are unaffected. It never manages
credentials, other apps, or cross-process dispatch; credentials are resolved only
through the host credential reference (Jev's dedicated `TYPESAFE_API_KEY`).

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

`enabled: false` is a passive no-op. An empty `allowHosts` **denies** every
automatic target select (fail-closed): route-keeper never treats an empty list
as "allow all" — operators must list the exact providers they permit. Disable or
roll back without source changes by setting `enabled: false` or removing the
profile plugin row.

## Provider notes

A provider that hangs silently is bounded only by its `streamIdleTimeoutMs`
(in `dsh-llm-pi-ai` providers settings, default `300000` ms). Route-keeper does
not promise a total-generation deadline; `maxFailureElapsedMs` measures elapsed
failure observation up to the fallback decision.

## License

MIT. See `LICENSE` and `NOTICE` for retained dsh-shift-router attribution.
