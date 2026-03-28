# Codex Model Backend

## Responsibility
This subsystem owns Codex CLI integration, local Codex auth-state inspection, model alias
resolution, and structured-output execution for the `codex_oauth` backend.

## Primary Files
- Auth/state inspection: `authStore.ts`
- CLI execution and path resolution: `cli.ts`
- Model alias resolution: `modelResolution.ts`
- Structured request runtime: `clientRuntime.ts`

## Inputs
- `BRAIN_MODEL_BACKEND=codex_oauth`
- `CODEX_MODEL_*` alias env overrides
- `CODEX_AUTH_STATE_DIR` and `CODEX_CLI_PATH` overrides when provided
- operator-owned local Codex auth state under `~/.codex/`

## Outputs
- bounded Codex auth status for owner-facing CLI surfaces
- ephemeral bearer-token access for bounded provider-backed subsystems such as media understanding
- fail-closed Codex provider-model resolution
- structured JSON completions routed through the local Codex CLI

## Invariants
- This subsystem must never persist raw access tokens, refresh tokens, or callback URLs into repo
  runtime ledgers or interface sessions.
- Auth inspection is metadata-only; the source of truth remains the operator-owned Codex state.
- Unsupported provider models must fail closed.
- Structured output must still pass the repo's schema validation after Codex returns.
- Structured `codex exec` prompts must be streamed over stdin rather than embedded in argv so large
  conversational requests do not fail at process-spawn time on Windows hosts.

## Related Tests
- `tests/models/createModelClient.test.ts`
- `tests/index.test.ts`
- `tests/models/codexAuthStore.test.ts`
- `tests/models/codexModelResolution.test.ts`

## When to Update This README
Update this README when:
- Codex auth state ownership or location changes
- Codex CLI execution strategy changes
- supported Codex model aliases change
- structured-output handling changes enough to affect the backend contract
