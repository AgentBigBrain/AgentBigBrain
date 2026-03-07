# Live-Run Subsystem

## Responsibility
This folder owns the canonical runtime handlers for managed-process lifecycle, localhost readiness
proof, and browser proof.

`src/organs/executor.ts` remains the dispatch entrypoint, but the behavior for live-run actions is
implemented here.

## Primary Files
- `contracts.ts`
- `managedProcessRegistry.ts`
- `startProcessHandler.ts`
- `checkProcessHandler.ts`
- `stopProcessHandler.ts`
- `probeHttpHandler.ts`
- `probePortHandler.ts`
- `browserVerifier.ts`
- `browserVerificationHandler.ts`

## Inputs
- approved executor actions such as `start_process`, `check_process`, `stop_process`,
  `probe_http`, `probe_port`, and `verify_browser`
- loopback targets, expected status codes, and browser proof expectations
- shell/runtime configuration from `src/core/config.ts`

## Outputs
- typed managed-process lease metadata
- readiness results (`PROCESS_READY`, `PROCESS_NOT_READY`)
- browser verification results and proof metadata
- typed runtime-unavailable or expectation-failure outcomes

## Invariants
- Loopback proof actions must stay bounded to localhost-only targets.
- `start_process` must fail early on occupied requested loopback ports instead of pretending the
  process started cleanly.
- Browser proof must never overclaim: runtime-unavailable and expectation failures must remain
  typed.
- Managed-process cleanup must operate through the registry contract instead of shell-side guesswork.

## Related Tests
- `tests/organs/liveRunHandlers.test.ts`
- `tests/organs/browserVerifier.test.ts`
- `tests/organs/executor.test.ts`
- `tests/core/agentLoop.test.ts`
- `scripts/evidence/managedProcessLiveSmoke.ts`

## When to Update This README
Update this README when:
- a live-run action type is added or removed
- lease metadata or readiness result contracts change
- browser verification launch semantics or proof metadata change
- executor dispatch ownership for live-run actions moves to different files
