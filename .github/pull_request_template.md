## What changed

<!-- One behaviour change, and the failure mode or limitation it removes. -->

## Compatibility

- Plugin version before/after:
- DeepSeek Harness version tested:
- Node.js version tested:
- Existing profile config keeps working: yes / no

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes, with tests covering the change
- [ ] Route selection stays fail-closed (empty `allowHosts` still denies)
- [ ] No credentials are read, stored, or logged
- [ ] No new outbound endpoint or telemetry
- [ ] Logs/output in this description are redacted
