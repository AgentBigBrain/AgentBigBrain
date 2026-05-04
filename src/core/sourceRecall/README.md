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

## Related Tests

- `tests/core/sourceRecallContracts.test.ts`
- `tests/core/sourceRecallIndex.test.ts`
- `tests/core/sourceRecallRetention.test.ts`
- `tests/core/sourceRecallStore.test.ts`
- `tests/core/sourceRecallMediaCapture.test.ts`
- `tests/interfaces/sourceRecallConversationCapture.test.ts`

## When to Update This README

Update this README when Source Recall adds storage, retrieval, capture, projection, memory bridges,
or new contract invariants.
