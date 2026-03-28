# Execution Runtime

## Responsibility
This subsystem owns the non-live-run execution helpers used by the stable `src/organs/executor.ts`
entrypoint.

It contains the direct file/basic action handlers, dynamic skill create/run runtime, shell
execution helpers, and supporting contracts that should not live inline inside the top-level
executor coordinator. Skill manifest lifecycle, inventory, workflow-bridge summaries, and
verification-state rendering stay owned by `src/organs/skillRegistry/`.

## Primary Files
- `contracts.ts`
- `pathRuntime.ts`
- `fileMutationExecution.ts`
- `skillModuleLoader.ts`
- `skillRuntime.ts`
- `shellExecution.ts`
- `shellExecutionSupport.ts`
- `shellCommandStaging.ts`
- `shellExecutionPostconditions.ts`
- `shellExecutionPathSupport.ts`

## Inputs
- approved planner actions and params
- runtime shell/profile config
- sandbox/workspace path policy
- executor-owned shell spawn and live-run dependencies

## Outputs
- typed `ExecutorExecutionOutcome` values
- shell execution telemetry records for runtime traces
- shell postcondition checks and Windows package-manager normalization used to fail closed when
  scaffold/build commands do not leave behind the required local artifacts
- path-style-aware shell path helpers so Windows scaffold/build postconditions stay correct even
  when the current host OS differs from the shell/runtime target style
- staged temp-script fallback for oversized shell commands so bounded execution does not depend on
  platform argv limits
- extracted scaffold/build postcondition helpers so `shellExecutionSupport.ts` can stay focused on
  command shaping and launcher policy
- stable skill-artifact execution and bounded file-action responses
- skill create/run execution metadata that can be handed off to the skill registry without the
  executor re-reading manifests inline

## Invariants
- `src/organs/executor.ts` stays the stable top-level execution entrypoint.
- Live-run actions stay owned by `src/organs/liveRun/`; this subsystem owns only the remaining
  direct execution families.
- Shell helpers here must preserve existing fail-closed timeout, cwd, and process-tree semantics.
- Skill runtime helpers must not bypass the existing executor-side name/path validation.
- Manifest creation, verification updates, and inventory rendering must stay delegated to
  `src/organs/skillRegistry/`; this subsystem should not become a second registry surface.

## Related Tests
- `tests/organs/executor.test.ts`
- `tests/organs/liveRunHandlers.test.ts`

## When to Update This README
Update this README when:
- a new non-live-run execution family moves out of `executor.ts`
- shell, skill, or file/basic action ownership moves again
- the stable boundary between this subsystem and `src/organs/liveRun/` changes
