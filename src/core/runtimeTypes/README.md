# Runtime Types

## Responsibility
This subsystem owns canonical shared runtime contracts extracted from `types.ts` once they become
high-churn or cross-cutting enough to justify a local edit surface.

The current extracted slices move shared ownership behind:
- `actionTypes.ts`
- `decisionSupportTypes.ts`
- `governanceTypes.ts`
- `governanceOutcomeTypes.ts`
- `interfaceTypes.ts`
- `persistenceTypes.ts`
- `runtimeStateTypes.ts`
- `taskPlanningTypes.ts`
- `workflowPersistenceTypes.ts`

The stable compatibility entrypoint remains:
- `types.ts`

Canonical behavior for those contracts now lives here.

## Inputs
- shared runtime contract requirements from core, governors, interfaces, models, and organs
- action, governance, and council semantics that must stay stable across the repo

## Outputs
- canonical action and execution-mode contracts
- canonical governor and council contracts
- canonical task, shell, and planning contracts reused by the stable `types.ts` entrypoint
- canonical governance, execution, and runtime-trace contracts reused by the stable `types.ts`
  entrypoint
- canonical persistence, evidence, receipt, and workflow schema contracts reused by the stable
  `types.ts` entrypoint
- canonical brain-state, profile-memory-status, delegation, first-principles, and
  failure-taxonomy contracts reused by the stable `types.ts` entrypoint
- canonical graph, conversation-stack, pulse, and bridge contracts reused by the stable `types.ts`
  entrypoint and interface/runtime consumers
- deterministic guard helpers for both governor ids and constraint-violation codes

## Invariants
- `types.ts` remains the stable shared import surface unless a dedicated migration changes that
  contract.
- Extraction here changes ownership, not runtime behavior or public type semantics.
- Shared runtime contracts should move here by concern instead of growing `types.ts` as one
  catch-all file.

## Related Tests
- `tests/core/runtimeTypes.test.ts`
- `tests/core/config.test.ts`
- `tests/core/shellRuntimeProfile.test.ts`
- `tests/core/stage6_86RuntimeActions.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed under `src/core/runtimeTypes/`
- canonical shared action, planning, shell, governance, persistence, or runtime-state ownership moves
- `types.ts` changes role as the stable compatibility entrypoint
- the related-test surface changes because shared runtime-type ownership moved
