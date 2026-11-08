# Contributing to dsh-route-keeper

Thanks for taking the time to improve `dsh-route-keeper`. This document covers
how to build the plugin, what a reviewable change looks like, and the rules that
keep routing behaviour safe.

## Requirements

- Node.js `>=24`
- pnpm (the repository ships a `pnpm-lock.yaml`)

## Build and test

```sh
pnpm install
pnpm build       # tsc -p tsconfig.json
pnpm typecheck   # tsc -p tsconfig.json --noEmit
pnpm test        # vitest run
```

Please run `pnpm typecheck` and `pnpm test` before opening a pull request, and
add or update tests for every behaviour change. A change without a test is a
draft, not a contribution.

## Proposing a change

1. Fork the repository and branch from `main`.
2. Keep the pull request focused: one behaviour change per PR, with the reason in
   the description (failure mode, observed error, or limitation being removed).
3. State compatibility: which DeepSeek Harness version and Node version you
   tested against, and whether existing profile configuration keeps working.
4. Open the pull request. `main` requires review; direct pushes are reserved for
   maintainers.

Bug reports are welcome as issues. Include the plugin version, the DeepSeek
Harness version, your Node version, the profile type (desktop or isolated
headless), the exact provider/model route involved, and the relevant log lines.
**Redact** API keys, tokens, account identifiers, and full prompt or response
bodies before pasting logs.

## Rules that are not negotiable

- Route selection stays **fail-closed**: an empty `allowHosts` denies every
  automatic target select. Never introduce an "allow all" default.
- The plugin never stores, copies, or forwards provider credentials. It only
  resolves the host credential reference (`TYPESAFE_API_KEY` for Jev).
- No new outbound network endpoint, telemetry, or cross-process dispatch without
  an explicit design discussion in the pull request.
- No synthetic paid probes: fallback decisions are driven by real requests.
- Partial output is never concatenated across routes; auto-continue happens only
  on zero-output failures.
- Keep the retained upstream attribution in `NOTICE` and the provenance notes in
  `src/cooldown.ts` intact.

## License

The project is MIT licensed. By opening a pull request you agree to license your
contribution under the same MIT terms (inbound = outbound). No CLA or copyright
assignment is required — you keep your copyright and are credited through the
project's contributors line.
