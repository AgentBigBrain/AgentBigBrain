# Memory Context

## Responsibility
This subsystem owns the deterministic query-extraction, probing, domain-boundary,
context-injection, and memory-access-audit helpers that sit behind the stable `memoryBroker.ts`
entrypoint.

## Inputs
- raw planner/task user input and wrapped conversation payloads
- optional brokered profile-context text from `src/core/profileMemoryStore.ts`
- optional brokered episode-context text from `src/core/profileMemoryStore.ts`
- optional typed lane-boundary metadata from bounded continuity or temporal synthesis adapters
- memory-access audit dependencies from `src/core/memoryAccessAudit.ts`

## Outputs
- shared memory-broker contracts in `contracts.ts`
- thin query-planning entrypoint re-exports in `queryPlanning.ts`
- current-request extraction and probing detection in `queryPlanningProbing.ts`
- domain-boundary scoring and ingest gating in `queryPlanningDomainBoundary.ts`
- profile-context sanitization and planner-packet rendering in `contextInjection.ts`
- episode-context sanitization and summary counting in `episodeContextInjection.ts`
- append-only audit helper routing in `auditEvents.ts`, including Phase 7 prompt-owner and
  prompt-surface plus alias-safety and self-identity safety/parity counter passthrough

## Invariants
- `memoryBroker.ts` remains the stable broker entrypoint while detailed query planning, context
  injection, and audit helpers live here.
- Structured prompt wrappers must not leak historical or profile-context lines into the extracted
  current user request.
- Probing detection stays deterministic for the same query window and config.
- Sensitive profile or episode fields must be redacted before brokered planner/model egress.
- Request-scoped audit counters here must describe the final brokered prompt owner and prompt
  surface count, not an earlier pre-render intermediate state.
- Request-scoped audit passthrough here may carry direct-chat identity-safety and self-identity
  parity counters, but it must stay append-only and must not become a second routing or truth
  decision surface.
- Query extraction and planning-context ranking here should eventually consume canonical
  `src/core/languageRuntime/` helpers and bounded `src/organs/memorySynthesis/` outputs rather
  than growing more local lexical heuristics.
- Broker ingest gating here may reuse shared bounded profile-extraction signals from
  `src/core/profileMemoryRuntime/` when that is the canonical way to detect conversational
  memory-worthy input; this module should not fork a second ad hoc relationship-memory detector.
- Domain-boundary relationship scoring should stay aligned with the bounded governed relationship
  vocabulary already supported in runtime memory so broker suppression does not lag behind
  relationship families such as `spouse`, `classmate`, `roommate`, `direct report`, `team lead`,
  `work peer`, and close-kinship phrasing.
- `queryPlanningDomainBoundary.ts` must consume typed `MemoryBoundaryLaneOutput` payloads for
  routing decisions; rendered memory text may still exist for model context, but it must not
  return as a co-equal boundary-scoring input.
- `queryPlanning.ts` remains a thin facade; detailed extraction, probing, and domain-boundary logic
  belong in `queryPlanningProbing.ts` and `queryPlanningDomainBoundary.ts` rather than drifting
  back into a single oversized file.

## Related Tests
- `tests/organs/memoryBroker.test.ts`
- `tests/organs/memoryContextQueryPlanning.test.ts`
- `tests/organs/queryPlanningDomainBoundary.test.ts`
- `tests/organs/memoryContextContextInjection.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed in `src/organs/memoryContext/`
- ownership moves between `memoryBroker.ts` and this subsystem
- query planning, probing detection, context injection, or audit append ownership changes
- episode-context injection ownership changes
- the related-test surface changes because this subsystem moved
