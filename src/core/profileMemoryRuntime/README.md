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
- canonical episodic-memory contracts in `profileMemoryEpisodeContracts.ts`
- canonical episodic-memory state helpers in `profileMemoryEpisodeState.ts`
- canonical episodic-memory normalization helpers in `profileMemoryEpisodeNormalization.ts`
- deterministic episodic-memory extraction in `profileMemoryEpisodeExtraction.ts`
- deterministic episodic-memory continuity linkage in `profileMemoryEpisodeLinking.ts`
- canonical episodic-memory upsert/merge helpers in `profileMemoryEpisodeMutations.ts`
- bounded episodic-memory planner-context rendering in `profileMemoryEpisodePlanningContext.ts`
- approval-aware episodic-memory reads and continuity queries in `profileMemoryEpisodeQueries.ts`
  that can power bounded active-conversation recall and private remembered-situation review
- bounded episodic-memory resolution inference in `profileMemoryEpisodeResolution.ts`
- episodic-memory consolidation plus freshness/lifecycle ranking in
  `profileMemoryEpisodeConsolidation.ts`
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
- bounded user-review and explicit correction or forgetting flows for remembered situations, still
  brokered through stable interface and memory-broker entrypoints

## Invariants
- `profileMemoryStore.ts` remains the stable encrypted-store entrypoint while canonical runtime
  contracts and query, pulse, mutation, persistence, and episodic-memory helpers move here.
- Sensitive fact reads stay fail-closed unless the request carries explicit human approval.
- Planner context generation stays bounded and deterministic for the same state/query input.
- State creation, freshness downgrades, fact upserts, and persisted-state normalization belong here
  even when `profileMemory.ts` keeps the stable public export surface.
- Episodic-memory contracts, state helpers, extraction, mutation, and bounded resolution inference
  belong here before recall ranking or planner-context injection ship.
- Duplicate episodic-memory records should consolidate here before they clutter store reads or
  active-turn recall selection.
- Bounded unresolved-situation summaries for planner/model grounding belong here before brokered
  context injection renders them.
- Continuity-aware episode queries here may support one bounded active-conversation recall, but they
  must stay approval-aware, privacy-safe, and deterministic.
- Explicit user review or correction flows must still rely on approval-aware episode reads here; the
  runtime must not grow an unbounded raw-episode dump surface.
- Explicit user resolve, wrong, or forget flows must remain bounded and deterministic here even
  when higher layers expose private remembered-situation controls.
- Episodic-memory freshness and lifecycle ranking here may de-prioritize stale or terminal
  situations for planning, pulse grounding, and continuity recall, but must not fabricate recall
  candidates.
- Encryption envelope parsing and key validation stay canonical in this subsystem even when
  `profileMemoryCrypto.ts` remains as a thin compatibility entrypoint.
- Richer human-language understanding for episodic extraction, linkage, and planning-context
  ranking should consume shared `src/core/languageRuntime/` helpers and eventually bounded
  `src/organs/languageUnderstanding/` surfaces instead of growing more one-off local lexicons here.

## Related Tests
- `tests/core/profileMemoryQueries.test.ts`
- `tests/core/profileMemoryEpisodeState.test.ts`
- `tests/core/profileMemoryEpisodeNormalization.test.ts`
- `tests/core/profileMemoryEpisodeExtraction.test.ts`
- `tests/core/profileMemoryEpisodeLinking.test.ts`
- `tests/core/profileMemoryEpisodeMutations.test.ts`
- `tests/core/profileMemoryEpisodePlanningContext.test.ts`
- `tests/core/profileMemoryEpisodeQueries.test.ts`
- `tests/core/profileMemoryEpisodeResolution.test.ts`
- `tests/core/profileMemoryEpisodeConsolidation.test.ts`
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
  readable-fact query, readable-episode query, episodic-memory linkage, episodic-memory,
  episodic-memory planning context, episodic-memory consolidation, or persistence ownership changes
- related profile-memory runtime tests move materially
