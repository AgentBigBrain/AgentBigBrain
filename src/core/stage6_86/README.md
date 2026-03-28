# Stage 6.86 Runtime

## Responsibility
This subsystem owns the canonical clustered Stage 6.86 runtime helpers as they move out of the
legacy top-level `stage6_86*` files.

The current extracted slice moves bridge-question, conversation-stack, entity-graph, media-continuity,
pulse-candidate, runtime-action, and runtime-state ownership behind:
- `bridgeQuestions.ts`
- `bridgeQuestionTimingSupport.ts`
- `conversationStack.ts`
- `conversationStackContracts.ts`
- `conversationStackHelpers.ts`
- `contracts.ts`
- `entityGraph.ts`
- `entityGraphAliasReconciliation.ts`
- `mediaContinuityLinking.ts`
- `memoryGovernance.ts`
- `openLoops.ts`
- `pulseCandidates.ts`
- `pulseCandidateSupport.ts`
- `runtimeActions.ts`
- `runtimeState.ts`

The stable compatibility entrypoints remain:
- `stage6_86BridgeQuestions.ts`
- `stage6_86ConversationStack.ts`
- `stage6_86EntityGraph.ts`
- `stage6_86MemoryGovernance.ts`
- `stage6_86OpenLoops.ts`
- `stage6_86PulseCandidates.ts`
- `stage6_86RuntimeActions.ts`
- `stage6_86RuntimeStateStore.ts`

Canonical behavior for those entrypoints now lives here.

## Inputs
- Stage 6.86 memory-mutation and pulse-emission actions from core task execution
- Stage 6.86 conversation-stack, entity-graph, bridge-question, and pulse-state contracts from
  `src/core/`
- persistence backend/runtime config from the core runtime layer

## Outputs
- deterministic bridge-question gating, rendering, and answer-resolution helpers for Stage 6.86
- deterministic bounded bridge-question timing interpretation helpers for Stage 6.86
- deterministic conversation-stack threading, topic switching, and migration helpers for Stage 6.86
- deterministic entity extraction, graph mutation, and relation-promotion helpers for Stage 6.86
- deterministic validated entity-type-hint application for ambiguous ingress extraction candidates
- deterministic alias-candidate validation and bounded alias reconciliation helpers for Stage 6.86
- deterministic entity lookup-term helpers for Stage 6.86 continuity linkage
- deterministic interpreted-media continuity-linking hints for Stage 6.86 recall grounding
- deterministic pulse-candidate generation, suppression, and emission-history normalization for
  Stage 6.86
- deterministic runtime-action execution for Stage 6.86 `memory_mutation` and `pulse_emit` flows
- deterministic memory-governance receipts, conflict checks, and rollback parity
- deterministic open-loop creation, resolution, and pulse-selection helpers
- deterministic open-loop lookup-term helpers for Stage 6.86 continuity linkage
- deterministic runtime-state persistence for conversation stack, pulse state, bridge queue, and
  mutation-receipt linkage
- shared Stage 6.86 runtime contracts for extracted helper modules and stable entrypoints

## Invariants
- `stage6_86BridgeQuestions.ts`, `stage6_86ConversationStack.ts`, `stage6_86EntityGraph.ts`,
  `stage6_86MemoryGovernance.ts`, `stage6_86OpenLoops.ts`, `stage6_86PulseCandidates.ts`,
  `stage6_86RuntimeActions.ts`, and `stage6_86RuntimeStateStore.ts`
  remain stable thin entrypoints unless a dedicated migration renames them.
- Extraction here changes ownership, not Stage 6.86 product semantics.
- Stage 6.86 runtime helpers here must remain deterministic and fail-closed.
- Additional Stage 6.86 helpers should move into this folder by concern instead of growing new
  top-level `stage6_86*` catch-all files.
- Conversation-stack and entity/open-loop language handling here should converge on shared
  `src/core/languageRuntime/` helpers rather than growing more local stop-word or token
  heuristics.

## Related Tests
- `tests/core/stage6_86MemoryGovernance.test.ts`
- `tests/core/stage6_86OpenLoops.test.ts`
- `tests/core/stage6_86BridgeQuestions.test.ts`
- `tests/core/stage6_86ConversationStack.test.ts`
- `tests/core/stage6_86EntityGraph.test.ts`
- `tests/core/entityGraphStore.test.ts`
- `tests/core/stage6_86MediaContinuityLinking.test.ts`
- `tests/core/stage6_86PulseCandidates.test.ts`
- `tests/core/stage6_86RuntimeActions.test.ts`
- `tests/core/stage6_86RuntimeStateStore.test.ts`
- `tests/core/taskRunnerExecution.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed under `src/core/stage6_86/`
- canonical Stage 6.86 bridge-question, conversation-stack, entity-graph, media-continuity,
  memory-governance, open-loop, pulse-candidate, runtime-action, or runtime-state ownership moves
- any stable `stage6_86*.ts` compatibility entrypoint changes role
- deterministic Stage 6.86 runtime behavior changes materially
- the related-test surface changes because Stage 6.86 ownership moved
