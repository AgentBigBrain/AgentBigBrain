# Profile Memory Runtime

## Responsibility
This subsystem owns the profile-memory runtime contracts plus the query, pulse, mutation, and
persistence helpers that sit between encrypted persistence and higher-level planner or operator
surfaces.

The goal is to keep profile-memory access semantics discoverable without forcing edits through the
full `profileMemoryStore.ts` implementation.

## Inputs
- normalized profile-memory state from `src/core/profileMemory.ts`
- encrypted-store lifecycle from `src/core/profileMemoryStore.ts`
- planner-query ranking from `src/core/profileMemoryPlanningContext.ts`
- pulse request and access request contracts from higher-level runtime callers

## Outputs
- shared profile-memory runtime contracts in `contracts.ts`
- commitment signal classification helpers in `profileMemoryCommitmentSignals.ts`
- unresolved commitment topic extraction and matching in `profileMemoryCommitmentTopics.ts`
- canonical state creation and freshness helpers in `profileMemoryState.ts`
- canonical fact upsert lifecycle helpers in `profileMemoryFactLifecycle.ts`
- key, value, sensitivity, and topic normalization helpers in `profileMemoryNormalization.ts`
- canonical persisted state normalization helpers in `profileMemoryStateNormalization.ts`
- deterministic user-input candidate extraction in `profileMemoryExtraction.ts`
- contact-focused named-entity and relationship extraction in `profileMemoryContactExtraction.ts`
- canonical encryption envelope and key parsing helpers in `profileMemoryEncryption.ts`
- pulse continuity helpers in `profileMemoryPulse.ts`
- planner-context rendering and query-aware ranking in `profileMemoryPlanningContext.ts`
- approval-aware readable-fact queries in `profileMemoryQueries.ts`
- commitment-resolution and candidate-apply helpers in `profileMemoryMutations.ts`
- env configuration plus encrypted disk I/O helpers in `profileMemoryPersistence.ts`

## Invariants
- `profileMemoryStore.ts` remains the stable encrypted-store entrypoint while canonical runtime
  contracts and query, pulse, mutation, and persistence helpers move here.
- Sensitive fact reads stay fail-closed unless the request carries explicit human approval.
- Planner context generation stays bounded and deterministic for the same state/query input.
- State creation, freshness downgrades, fact upserts, and persisted-state normalization belong here
  even when `profileMemory.ts` keeps the stable public export surface.
- Encryption envelope parsing and key validation stay canonical in this subsystem even when
  `profileMemoryCrypto.ts` remains as a thin compatibility entrypoint.

## Related Tests
- `tests/core/profileMemoryQueries.test.ts`
- `tests/core/profileMemoryFactLifecycle.test.ts`
- `tests/core/profileMemoryMutations.test.ts`
- `tests/core/profileMemoryNormalization.test.ts`
- `tests/core/profileMemoryStateNormalization.test.ts`
- `tests/core/profileMemoryExtraction.test.ts`
- `tests/core/profileMemoryEncryption.test.ts`
- `tests/core/profileMemoryPlanningContext.test.ts`
- `tests/core/profileMemoryPulse.test.ts`
- `tests/core/profileMemoryPersistence.test.ts`
- `tests/core/profileMemoryStore.test.ts`
- `tests/core/profileMemory.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed in `src/core/profileMemoryRuntime/`
- profile-memory runtime contracts move between this folder and `profileMemoryStore.ts`
- planner-context, state lifecycle, normalization, extraction, pulse, mutation, encryption,
  readable-fact query, or persistence ownership changes
- related profile-memory runtime tests move materially
