# Language Runtime

## Responsibility
This subsystem owns deterministic non-safety language tokenization, stop-word policy, language
profile selection, and overlap scoring used by memory, continuity, and retrieval code.

Its job is to stop conversational-memory and retrieval surfaces from each growing their own local
English-only tokenization rules while preserving deterministic fail-closed behavior. This subsystem
is for bounded non-safety text handling only; safety/governance lexicons still belong in their
existing deterministic policy files.

## Inputs
- free-form user, assistant, memory, and planner query text from higher-level runtime surfaces
- bounded language-token domains such as conversation-topic extraction, contextual recall,
  planning-query ranking, episode-linking, and semantic concept extraction
- optional deterministic language-profile hints

## Outputs
- canonical language-token contracts in `contracts.ts`
- canonical language-profile selection in `languageProfiles.ts`
- canonical stop-word policy in `stopWordPolicy.ts`
- canonical deterministic tokenization in `tokenization.ts`
- canonical domain-specific term extraction in `queryIntentTerms.ts`
- canonical deterministic overlap counting in `languageScoring.ts`

## Invariants
- This subsystem stays deterministic and local; it must not depend on model availability.
- It is for non-safety language handling only. Safety/governance lexical surfaces remain separate.
- It should centralize shared tokenization and stop-word policy instead of loosening suppressions in
  downstream callers.
- Language-profile expansion should remain explicit and fail closed when a profile is unsupported.

## Related Tests
- `tests/core/languageRuntime.test.ts`
- `tests/core/profileMemoryPlanningContext.test.ts`
- `tests/core/profileMemoryEpisodePlanningContext.test.ts`
- `tests/core/profileMemoryEpisodeLinking.test.ts`
- `tests/core/semanticMemory.test.ts`
- `tests/interfaces/contextualRecall.test.ts`
- `tests/core/stage6_86ConversationStack.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed in `src/core/languageRuntime/`
- a new non-safety tokenization domain or language profile is added
- memory, continuity, or retrieval ownership moves into or out of this subsystem
- related deterministic language-handling tests change materially
