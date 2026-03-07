# Organs Layer

## Responsibility
This folder owns the runtime "organs" that plan, execute, interpret intent, broker memory, and
reflect on task outcomes.

The extracted `src/organs/liveRun/` and `src/organs/plannerPolicy/` subsystems own detailed
live-run and planner-policy modules; the top-level files here keep the stable orchestration
entrypoints and remaining single-surface organs.

## Primary Files
- Stable orchestration entrypoints: `executor.ts`, `planner.ts`.
- Planner support and classification: `plannerHelpers.ts`, `intentInterpreter.ts`,
  `pulseLexicalClassifier.ts`.
- Runtime support organs: `memoryBroker.ts`, `reflection.ts`, `reflectionSignalClassifier.ts`.

## Inputs
- user goals, current request context, and orchestrator-governed runtime metadata
- model outputs, memory signals, and reflection events
- typed action definitions and planner schema contracts from `src/core/`

## Outputs
- executable action plans and fallback responses
- action execution dispatch and live-run capability routing
- memory context packets, reflection lessons, and pulse-intent classification

## Invariants
- `planner.ts` and `executor.ts` remain stable thin entrypoints; detailed policy or capability logic
  belongs in `plannerPolicy/` and `liveRun/`.
- Remaining top-level organs should stay single-purpose; if one grows into a multi-surface system,
  extract a subsystem instead of hiding more branches here.
- Memory and reflection behavior should remain explicit rather than being inferred from planner or
  executor internals.

## Related Tests
- `tests/organs/planner.test.ts`
- `tests/organs/plannerPolicy.test.ts`
- `tests/organs/executor.test.ts`
- `tests/organs/liveRunHandlers.test.ts`
- `tests/models/mockModelClient.test.ts`

## When to Update This README
Update this README when:
- a top-level organ file is added, removed, or renamed
- ownership moves between this folder and `liveRun/` or `plannerPolicy/`
- a remaining top-level organ is extracted into a new subsystem
- the related-test surface changes because organ ownership moved
