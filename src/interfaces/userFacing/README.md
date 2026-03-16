# User-Facing Rendering Subsystem

## Responsibility
This folder owns the canonical rendering surfaces for task-result summaries and autonomous terminal
messages.

`src/interfaces/userFacingResult.ts` remains the thin composition entrypoint for task-result
rendering, but the wording ownership lives here. Autonomous progress and terminal messages are now
consumed directly from `stopSummarySurface.ts` by the interface adapters, including the richer
state-driven retry and verification updates used during `/auto`.

## Primary Files
- `contracts.ts`
- `resultSurface.ts`
- `languageSurface.ts`
- `successSurface.ts`
- `partialSuccessSurface.ts`
- `organizationOutcomeSurface.ts`
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
- human-first organization and recovery-completion summaries only when the run proved a real move
  into the verified destination
- bounded organization-move proof parsing from governed shell output when directory proof is absent
  but the runtime still emitted structured `MOVED_TO_DEST`, `DEST_CONTENTS`,
  `MOVED_TARGETS`, `ROOT_REMAINING_MATCHES`, or related verification markers
- label-style opening cleanup for model-authored replies
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
- User-facing replies should strip robotic label-style openings like `AI assistant response:` even
  if the model emits them.
- Folder-organization replies must not claim success unless the destination listing proves the move
  actually landed there, or the governed move step emitted bounded move-proof output that names what
  moved and what remained.
- Folder-organization replies must read the active request segment from wrapped prompts before
  resolving the destination folder, so stale conversation context cannot override the current ask.
- When a run changes an artifact and a later verification step is blocked, user-facing summaries
  should prefer the strongest proven change over later inspection-only steps or generic
  blocked/no-op boilerplate.
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
