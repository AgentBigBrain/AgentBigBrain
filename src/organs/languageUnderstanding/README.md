# Language Understanding

## Responsibility
This subsystem owns bounded model-assisted conversational language understanding that upgrades
episodic-memory extraction without weakening the deterministic fail-closed runtime model.

## Inputs
- shared `ModelClient` structured-output boundary from `src/models/types.ts`
- raw user text plus task metadata from brokered memory ingestion
- canonical episode contracts from `src/core/profileMemoryRuntime/`

## Outputs
- structured episode-extraction contracts in `contracts.ts`
- bounded model-fallback request path in `languageModelFallback.ts`
- canonical model-output normalization in `episodeNormalization.ts`
- bounded contextual-reference resolution in `contextualReferenceResolution.ts`
- stable runtime entrypoint in `episodeExtraction.ts`

## Invariants
- This subsystem is bounded: at most a small number of typed episode candidates per turn.
- It must fail closed; model errors return no extra candidates rather than guessing.
- It should improve human-language coverage, not bypass profile-memory sensitivity or approval rules.
- It should not become a general transcript summarizer or unbounded personal-history search layer.

## Related Tests
- `tests/organs/languageUnderstandingEpisodeExtraction.test.ts`
- `tests/core/profileMemoryEpisodeExtraction.test.ts`
- `tests/organs/memoryBroker.test.ts`
- `tests/models/mockModelClient.test.ts`
- `tests/models/schemaValidationRuntime.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed in `src/organs/languageUnderstanding/`
- the bounded extraction contract or failure behavior changes
- profile-memory ingestion ownership moves between this subsystem and `profileMemoryStore.ts`
- related tests move materially
