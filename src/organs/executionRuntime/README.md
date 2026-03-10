# Execution Runtime

## Responsibility
This subsystem owns the non-live-run execution helpers used by the stable `src/organs/executor.ts`
entrypoint.

It contains the direct file/basic action handlers, dynamic skill create/run runtime, shell
execution helpers, and supporting contracts that should not live inline inside the top-level
executor coordinator.

## Primary Files
- `contracts.ts`
- `pathRuntime.ts`
- `fileMutationExecution.ts`
- `skillRuntime.ts`
- `shellExecution.ts`

## Inputs
- approved planner actions and params
- runtime shell/profile config
- sandbox/workspace path policy
- executor-owned shell spawn and live-run dependencies

## Outputs
- typed `ExecutorExecutionOutcome` values
- shell execution telemetry records for runtime traces
- stable skill-artifact execution and bounded file-action responses

## Invariants
- `src/organs/executor.ts` stays the stable top-level execution entrypoint.
- Live-run actions stay owned by `src/organs/liveRun/`; this subsystem owns only the remaining
  direct execution families.
- Shell helpers here must preserve existing fail-closed timeout, cwd, and process-tree semantics.
- Skill runtime helpers must not bypass the existing executor-side name/path validation.

## Related Tests
- `tests/organs/executor.test.ts`
- `tests/organs/liveRunHandlers.test.ts`

## When to Update This README
Update this README when:
- a new non-live-run execution family moves out of `executor.ts`
- shell, skill, or file/basic action ownership moves again
- the stable boundary between this subsystem and `src/organs/liveRun/` changes
