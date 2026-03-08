# Memory Context

## Responsibility
This subsystem owns the deterministic query-extraction, domain-boundary, context-injection, and
memory-access-audit helpers that sit behind the stable `memoryBroker.ts` entrypoint.

## Inputs
- raw planner/task user input and wrapped conversation payloads
- optional brokered profile-context text from `src/core/profileMemoryStore.ts`
- optional brokered episode-context text from `src/core/profileMemoryStore.ts`
- memory-access audit dependencies from `src/core/memoryAccessAudit.ts`

## Outputs
- shared memory-broker contracts in `contracts.ts`
- current-request extraction, probing detection, and domain-boundary scoring in `queryPlanning.ts`
- profile-context sanitization and planner-packet rendering in `contextInjection.ts`
- episode-context sanitization and summary counting in `episodeContextInjection.ts`
- append-only audit helper routing in `auditEvents.ts`

## Invariants
- `memoryBroker.ts` remains the stable broker entrypoint while detailed query planning, context
  injection, and audit helpers live here.
- Structured prompt wrappers must not leak historical or profile-context lines into the extracted
  current user request.
- Probing detection stays deterministic for the same query window and config.
- Sensitive profile or episode fields must be redacted before brokered planner/model egress.
- Query extraction and planning-context ranking here should eventually consume canonical
  `src/core/languageRuntime/` helpers and bounded `src/organs/memorySynthesis/` outputs rather
  than growing more local lexical heuristics.

## Related Tests
- `tests/organs/memoryBroker.test.ts`
- `tests/organs/memoryContextQueryPlanning.test.ts`
- `tests/organs/memoryContextContextInjection.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed in `src/organs/memoryContext/`
- ownership moves between `memoryBroker.ts` and this subsystem
- query planning, probing detection, context injection, or audit append ownership changes
- episode-context injection ownership changes
- the related-test surface changes because this subsystem moved
