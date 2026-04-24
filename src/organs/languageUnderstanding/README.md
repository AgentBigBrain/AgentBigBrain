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
- bounded proposal-reply task contracts in `localIntentModelProposalReplyContracts.ts`
- env-backed local intent-model bootstrap in `localIntentModelRuntime.ts`
- fail-closed local intent-model routing in `localIntentModelRouter.ts`
- Ollama-backed local intent-model provider in `ollamaLocalIntentModel.ts`
- shared Ollama local-intent prompt contract in `ollamaLocalIntentPrompt.ts`
- Ollama-backed identity-interpretation task in `ollamaIdentityInterpretation.ts`
- Ollama-backed proposal-reply-interpretation task in `ollamaProposalReplyInterpretation.ts`
- Ollama-backed continuation-interpretation task in `ollamaContinuationInterpretation.ts`
- Ollama-backed autonomy-boundary-interpretation task in
  `ollamaAutonomyBoundaryInterpretation.ts`
- Ollama-backed contextual-reference-interpretation task in
  `ollamaContextualReferenceInterpretation.ts`
- Ollama-backed contextual-followup-interpretation task in
  `ollamaContextualFollowupInterpretation.ts`
- Ollama-backed bridge-question-timing-interpretation task in
  `ollamaBridgeQuestionTimingInterpretation.ts`
- Ollama-backed status-recall-boundary-interpretation task in
  `ollamaStatusRecallBoundaryInterpretation.ts`
- Ollama-backed topic-key-interpretation task in `ollamaTopicKeyInterpretation.ts`
- Ollama-backed entity-reference-interpretation task in `ollamaEntityReferenceInterpretation.ts`
- Ollama-backed entity-domain-hint-interpretation task in
  `ollamaEntityDomainHintInterpretation.ts`
- Ollama-backed entity-type-interpretation task in `ollamaEntityTypeInterpretation.ts`
- Ollama-backed handoff-control-interpretation task in `ollamaHandoffControlInterpretation.ts`
- shared bounded conversation-task contracts for execution intent, identity interpretation,
  proposal-reply interpretation, continuation interpretation, autonomy-boundary interpretation, contextual-reference
  interpretation, contextual-followup interpretation, bridge-question-timing interpretation,
  status-recall-boundary interpretation, topic-key interpretation, entity-reference
  interpretation, entity-domain-hint interpretation, and entity-type interpretation plus
  handoff-control interpretation in `localIntentModelContracts.ts`
- canonical front-door combination logic in `executionIntentUnderstanding.ts`
- canonical clarification-option helpers in `clarificationIntentRanking.ts`
- bounded return-handoff session hints and semantic handoff cues for the optional local intent
  model so saved-draft review, softer review-ready questions, anything-else-to-review prompts,
  review-next questions, wrap-up summaries, explain requests, and resume requests can be
  understood by meaning instead of only phrase rules
- bounded identity-context session hints plus structural identity-eligibility preservation so
  ambiguous declarations and short identity follow-ups can stay off the execution-intent model
  path when recent conversation state already shows the turn is identity-focused
- bounded session-domain lane and workflow-continuity hints for the optional local intent model so
  ambiguous end-to-end phrasing can stay sensitive to personal vs workflow context without turning
  the model into a second routing authority

## Invariants
- This subsystem is bounded: at most a small number of typed episode candidates per turn.
- It must fail closed; model errors return no extra candidates rather than guessing.
- It should improve human-language coverage, not bypass profile-memory sensitivity or approval rules.
- It should not become a general transcript summarizer or unbounded personal-history search layer.
- The optional local intent-model seam here must remain a bounded classifier/extractor. It must not
  become a second planner or a bypass around deterministic routing and clarification rules.
- Each conversational interpretation task here must keep its own typed schema and validator instead
  of expanding one unconstrained local-model contract.
- Session hints here must stay bounded and structural. They can expose facts like whether a durable
  handoff exists, whether a preview or primary artifact is available, or how many changed paths the
  saved checkpoint has, whether recent identity conversation is active, whether the assistant just
  asked for the user's name, what the current dominant domain lane is, or whether workflow
  continuity is active, but they must not leak raw authorization decisions or become a hidden
  safety layer.

## Related Tests
- `tests/organs/languageUnderstandingEpisodeExtraction.test.ts`
- `tests/core/profileMemoryEpisodeExtraction.test.ts`
- `tests/organs/memoryBroker.test.ts`
- `tests/models/mockModelClient.test.ts`
- `tests/models/schemaValidationRuntime.test.ts`
- `tests/interfaces/intentModeResolution.test.ts`
- `tests/organs/localIntentModelRuntime.test.ts`
- `tests/organs/ollamaProposalReplyInterpretation.test.ts`
- `tests/organs/ollamaContextualReferenceInterpretation.test.ts`
- `tests/organs/ollamaContextualFollowupInterpretation.test.ts`
- `tests/organs/ollamaAutonomyBoundaryInterpretation.test.ts`
- `tests/organs/ollamaBridgeQuestionTimingInterpretation.test.ts`
- `tests/organs/ollamaStatusRecallBoundaryInterpretation.test.ts`
- `tests/organs/ollamaTopicKeyInterpretation.test.ts`
- `tests/organs/ollamaEntityReferenceInterpretation.test.ts`
- `tests/organs/ollamaEntityDomainHintInterpretation.test.ts`
- `tests/organs/ollamaEntityTypeInterpretation.test.ts`
- `tests/organs/ollamaHandoffControlInterpretation.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed in `src/organs/languageUnderstanding/`
- the bounded extraction contract or failure behavior changes
- the local intent-model seam or clarification-option ownership changes
- the bounded session-domain hints surfaced to the optional local intent model change materially
- the bounded identity-context hints surfaced to the optional local intent model change materially
- profile-memory ingestion ownership moves between this subsystem and `profileMemoryStore.ts`
- front-door intent-routing ownership moves between this subsystem and `src/interfaces/`
- related tests move materially
