# User-Facing Rendering Subsystem

## Responsibility
This folder owns the canonical rendering surfaces for task-result summaries and autonomous terminal
messages.

`src/interfaces/userFacingResult.ts` remains the thin composition entrypoint for task-result
rendering, but the wording ownership lives here. Autonomous progress and terminal messages are now
consumed directly from `stopSummarySurface.ts` by the interface adapters.

## Primary Files
- `contracts.ts`
- `resultSurface.ts`
- `successSurface.ts`
- `blockSurface.ts`
- `noOpSurface.ts`
- `stopSummarySurface.ts`
- `trustSurface.ts`
- `debugSurface.ts`

## Inputs
- `TaskRunResult` planner and action results
- routing classification and diagnostics prompt classification
- trust lexical classification
- autonomous stop reasons from `src/core/autonomy/stopReasonText.ts`

## Outputs
- user-facing success summaries
- blocked and no-op explanations
- trust-safe respond rendering
- debug/diagnostic mission summaries
- autonomous progress and terminal summary messages

## Invariants
- User-facing text must never overclaim execution that did not happen.
- Block wording, no-op wording, success wording, and debug rendering should remain locally editable
  instead of mixing in one giant file.
- Debug/diagnostic output should only appear when explicitly requested and when technical summary is
  enabled.
- Thin entrypoints should stay limited to stable surface-composition paths such as
  `src/interfaces/userFacingResult.ts`; canonical wording logic should live in this folder.

## Related Tests
- `tests/interfaces/userFacingResult.test.ts`
- `tests/interfaces/autonomousMessagePolicy.test.ts`
- `tests/interfaces/userFacing/blockSurface.test.ts`
- `tests/interfaces/userFacing/noOpSurface.test.ts`
- `tests/interfaces/userFacing/stopSummarySurface.test.ts`

## When to Update This README
Update this README when:
- wording ownership moves between surfaces
- a new rendering surface or thin entrypoint is added
- trust/no-op/block/debug routing changes enough to alter the canonical edit path
- the related-test list changes because coverage moved to new files
