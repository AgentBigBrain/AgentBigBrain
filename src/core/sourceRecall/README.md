# Source Recall

## Responsibility

Owns the Source Recall contract surface for source records, chunks, excerpts, and recall bundles.
Source Recall can remind AgentBigBrain what was said or seen. It cannot decide what is true,
allowed, approved, completed, or safe to act on.

## Inputs

- Source-kind labels such as `conversation_turn`, `assistant_turn`, `document_text`, and
  `media_transcript`.
- Existing `SourceAuthority` values from `src/core/sourceAuthority.ts`.
- Source role, capture class, lifecycle, freshness, retrieval mode, retrieval authority, and source
  time metadata.

## Outputs

- Closed TypeScript contracts for Source Recall records, chunks, excerpts, and recall bundles.
- Normalization helpers that fail closed for unknown or authority-like values.
- Non-authority flags that keep recall evidence separate from planner, truth, approval, safety, and
  completion proof.
- Optional conversation capture artifacts that preserve safe origin refs without tying source-record
  retention to bounded session turn history.
- Bounded retrieval bundles and context-rendering metadata used by route-approved broker injection.
- Evidence-only refs that semantic memory candidates may cite as provenance without gaining truth
  or write authority.
- Projection-safe entries that Obsidian/JSON mirrors can display as bounded review evidence only.

## Invariants

- Source Recall uses `scope`, `thread`, `source record`, and `chunk` vocabulary.
- `recallAuthority` is only `quoted_evidence_only`.
- Source kind, source role, capture class, and source authority are separate fields.
- Live user turns are `conversation_turn` records with `sourceRole=user` and
  `sourceAuthority=explicit_user_statement`; assistant output and recovered summaries are handled by
  later, lower-authority slices.
- Assistant output is `assistant_turn` with `captureClass=assistant_output`. Task input and task
  summary text use operational capture classes and hashed origin refs so transport URLs or provider
  handles are not stored as origin metadata.
- Media transcript, OCR, and model-summary layers can produce source records while preserving their
  original layer `memoryAuthority`; these records remain quoted evidence and cannot become command
  routing input.
- Source Recall does not create profile-memory truth, semantic-memory lessons, approvals, side
  effects, safety decisions, or receipt-backed proof.
- Production Source Recall storage must use encrypted payloads derived from initialized key
  material. The test-only plaintext SQLite path remains explicit and cannot be used as a production
  runtime callsite.
- Production encrypted storage currently encrypts the full Source Recall document payload, leaving
  only row id, storage mode, and authenticated envelope fields visible in SQLite.
- Production runtime config is fail-closed: Source Recall, capture, retrieval, projection,
  operator-full projection, indexing, and evidence mode each require explicit latches.
- Production capture allowlists currently support explicit conversation, assistant, task,
  media/document source kinds, and their matching capture classes. Missing, empty, unknown, or
  broader allowlists capture nothing.
- Planner/model context injection requires the retrieval latch plus a route-approved memory intent
  and renders retrieved chunks only as quoted evidence.
- Semantic relationship candidates may carry Source Recall refs only as provenance. The candidates
  still require model/review evidence and route-approved profile-memory write policy before truth
  governance can apply durable facts.
- Projection requires the Source Recall projection latch. Operator-full mode requires the separate
  operator-full Source Recall latch; otherwise Source Recall is omitted from operator-full mirrors.
- Projected Source Recall notes cannot be re-captured as ordinary Source Recall input and cannot
  authorize review actions by source ref alone.

## Related Tests

- `tests/core/sourceRecallContracts.test.ts`
- `tests/core/sourceRecallIndex.test.ts`
- `tests/core/sourceRecallRetention.test.ts`
- `tests/core/sourceRecallStore.test.ts`
- `tests/core/sourceRecallMediaCapture.test.ts`
- `tests/core/sourceRecallMemoryBridge.test.ts`
- `tests/core/sourceRecallProjection.test.ts`
- `tests/interfaces/sourceRecallConversationCapture.test.ts`
- `tests/organs/sourceRecallContextInjection.test.ts`

## When to Update This README

Update this README when Source Recall adds storage, retrieval, capture, projection, memory bridges,
or new contract invariants.
