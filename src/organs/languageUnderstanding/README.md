# Language Understanding

## Responsibility
This subsystem owns bounded model-assisted conversational language understanding that upgrades
episodic-memory extraction and the human-centric execution front door without weakening the
deterministic fail-closed runtime model.

## Inputs
- shared `ModelClient` structured-output boundary from `src/models/types.ts`
- raw user text plus task metadata from brokered memory ingestion
- raw user text plus deterministic routing hints from the interface front door
- canonical episode contracts from `src/core/profileMemoryRuntime/`

## Outputs
- structured episode-extraction contracts in `contracts.ts`
- bounded model-fallback request path in `languageModelFallback.ts`
- canonical model-output normalization in `episodeNormalization.ts`
- bounded contextual-reference resolution in `contextualReferenceResolution.ts`
- stable runtime entrypoint in `episodeExtraction.ts`
- optional local intent-model contracts in `localIntentModelContracts.ts`
- env-backed local intent-model bootstrap in `localIntentModelRuntime.ts`
- fail-closed local intent-model routing in `localIntentModelRouter.ts`
- Ollama-backed local intent-model provider in `ollamaLocalIntentModel.ts`
- canonical front-door combination logic in `executionIntentUnderstanding.ts`
- canonical clarification-option helpers in `clarificationIntentRanking.ts`
- bounded return-handoff session hints and semantic handoff cues for the optional local intent
  model so saved-draft review, softer review-ready questions, anything-else-to-review prompts,
  review-next questions, wrap-up summaries, explain requests, and resume requests can be
  understood by meaning instead of only phrase rules

## Invariants
- This subsystem is bounded: at most a small number of typed episode candidates per turn.
- It must fail closed; model errors return no extra candidates rather than guessing.
- It should improve human-language coverage, not bypass profile-memory sensitivity or approval rules.
- It should not become a general transcript summarizer or unbounded personal-history search layer.
- The optional local intent-model seam here must remain a bounded classifier/extractor. It must not
  become a second planner or a bypass around deterministic routing and clarification rules.
- Session hints here must stay bounded and structural. They can expose facts like whether a durable
  handoff exists, whether a preview or primary artifact is available, or how many changed paths the
  saved checkpoint has, but they must not leak raw authorization decisions or become a hidden
  safety layer.

## Related Tests
- `tests/organs/languageUnderstandingEpisodeExtraction.test.ts`
- `tests/core/profileMemoryEpisodeExtraction.test.ts`
- `tests/organs/memoryBroker.test.ts`
- `tests/models/mockModelClient.test.ts`
- `tests/models/schemaValidationRuntime.test.ts`
- `tests/interfaces/intentModeResolution.test.ts`
- `tests/organs/localIntentModelRuntime.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed in `src/organs/languageUnderstanding/`
- the bounded extraction contract or failure behavior changes
- the local intent-model seam or clarification-option ownership changes
- profile-memory ingestion ownership moves between this subsystem and `profileMemoryStore.ts`
- front-door intent-routing ownership moves between this subsystem and `src/interfaces/`
- related tests move materially
