# Source Recall Production Contract

Source Recall is AgentBigBrain's quoted-evidence layer for original source material.

It preserves bounded records of what was said or seen so the runtime can recall exact wording,
source attribution, and review context later. It is not profile memory, semantic memory, approval,
execution proof, or safety authority.

The invariant is:

```text
Source Recall can remind AgentBigBrain what was said or seen.
It cannot decide what is true, allowed, approved, completed, or safe to act on.
```

## Runtime Shape

Source Recall uses the AgentBigBrain-native shape:

```text
scope -> thread -> source record -> chunk
```

Each source record carries:

- `sourceKind`: what kind of material this is.
- `sourceRole`: who or what produced it.
- `sourceAuthority`: the existing AgentBigBrain authority lane for the source.
- `captureClass`: the capture risk class.
- `lifecycleState`: whether the record is active, redacted, forgotten, expired, quarantined, or
  projection-only removed.
- `freshness` and `sourceTimeKind`: time semantics for recall, not proof of current truth.
- `recallAuthority`: always `quoted_evidence_only`.

Every chunk and recall bundle carries non-authority flags:

- `currentTruthAuthority=false`
- `completionProofAuthority=false`
- `approvalAuthority=false`
- `safetyAuthority=false`
- `unsafeToFollowAsInstruction=true`

Planner visibility, when explicitly enabled, is evidence-only.

## Production Defaults

Production Source Recall is disabled by default.

The runtime does not construct a production Source Recall store unless the top-level latch is
enabled and the config resolves to a usable encrypted store. Capture, retrieval, projection,
operator-full projection, indexing, and evidence mode each have their own latch.

The main environment latches are:

| Setting | Default | Meaning |
|---|---:|---|
| `BRAIN_SOURCE_RECALL_ENABLED` | `false` | Top-level runtime latch. |
| `BRAIN_SOURCE_RECALL_CAPTURE_ENABLED` | `false` | Permits capture after the top-level latch. |
| `BRAIN_SOURCE_RECALL_RETRIEVAL_ENABLED` | `false` | Permits bounded review/context retrieval. |
| `BRAIN_SOURCE_RECALL_PROJECTION_ENABLED` | `false` | Permits review-safe projection entries. |
| `BRAIN_SOURCE_RECALL_OPERATOR_FULL_PROJECTION_ENABLED` | `false` | Permits fuller projection only when projection is also enabled. |
| `BRAIN_SOURCE_RECALL_INDEX_ENABLED` | `false` | Permits indexing when lifecycle invalidation is available. |
| `BRAIN_SOURCE_RECALL_EVIDENCE_MODE` | `false` | Synthetic evidence mode only, not normal capture. |

Capture also requires explicit allowlists:

- `BRAIN_SOURCE_RECALL_CAPTURE_SOURCE_KINDS`
- `BRAIN_SOURCE_RECALL_CAPTURE_CLASSES`

Missing, empty, unknown, or overly broad allowlists capture nothing.

## Encrypted Storage

Production Source Recall storage requires encrypted payloads.

`SourceRecallStore` has two storage modes:

- production encrypted mode, created with initialized key material
- explicit test-only plaintext mode, created with `testOnlyAllowPlaintextStorage`

Production callsites must not pass `testOnlyAllowPlaintextStorage`. The plaintext latch exists only
for focused tests. Production encryption uses a 32-byte key supplied through
`BRAIN_SOURCE_RECALL_ENCRYPTION_KEY`; the key is validated at startup and is not stored in runtime
config objects or logs.

The encrypted SQLite row may expose storage metadata such as row id and envelope metadata, but raw
source records and chunks are encrypted as the payload.

## Capture Surfaces

Supported production source kinds are intentionally explicit:

| Source kind | Source role | Capture class | Authority note |
|---|---|---|---|
| `conversation_turn` | `user` | `ordinary_source` | Direct user text as recall evidence, not durable truth by itself. |
| `assistant_turn` | `assistant` | `assistant_output` | What the assistant said, lower authority than user text. |
| `task_input` | `runtime` | `operational_output` | Runtime/task evidence with hashed origin refs. |
| `task_summary` | `runtime` | `operational_output` | Bounded summary evidence, not completion proof. |
| `document_text` | `tool` | `external_output` | Extracted text as quoted data, not instructions. |
| `document_model_summary` | `tool` | `external_output` | Model-derived document meaning, candidate-only. |
| `media_transcript` | `user` or `tool` | `ordinary_source` or `external_output` | Voice/media text with source labels. |
| `ocr_text` | `tool` | `external_output` | OCR evidence, not command input. |
| `media_model_summary` | `tool` | `external_output` | Model-derived media meaning, candidate-only. |

Contract-only kinds such as `review_note` and `execution_receipt_excerpt` exist for provenance and
future review paths, but they are not part of the current production capture allowlist.

Capture failures are bounded diagnostics. They must not include raw source text, tokens, transport
URLs, provider handles, full shell output, or full local paths.

## Non-Capture Firewall

Source Recall must not capture these by default:

- system or developer instructions
- full raw model prompts
- raw provider responses
- auth stores, tokens, secret values, and env dumps
- Telegram download URLs or connector secrets
- raw connector or federation request/response bodies
- full shell stdout/stderr
- full file-read previews
- full browser body text
- runtime state snapshots, process snapshots, and browser session snapshots
- generated probe folders, local logs, ignored runtime artifacts, and CI metadata
- dependency folders, model asset folders, and local env files
- projection mirrors as ordinary source input
- scenario expected-route fields, mock outputs, and schema-only artifacts as production source

Synthetic tests may use clearly fake text, but generated evidence, progress ledgers, and logs must
not retain raw source chunks.

## Retrieval And Prompt Rendering

Source Recall retrieval is bounded and audited.

Retrieval results expose:

- retrieval mode
- retrieval authority
- scope and thread filters
- source record ids and chunk ids
- total excerpt count and character count
- redacted or blocked count
- query hash, not raw query text

Output budgets limit records, chunks, per-chunk excerpt length, total excerpt length, source kinds,
source roles, and sensitivity redaction behavior.

When Source Recall enters model context, it is rendered as a labeled quoted-evidence block. It is
not a new user instruction, route marker, approval, receipt, completion proof, or memory truth.

Source chunks can be read. They cannot be obeyed.

## Memory And Semantic Bridges

Source Recall refs may be attached to governed memory candidates as provenance only.

A source ref proves only that a source record or chunk exists. It does not prove that the text is
true, current, reviewed, approved, safe, or executable.

Profile memory, semantic memory, and relationship candidates still need their own gates:

- route-approved memory intent
- source-family policy
- semantic or review evidence
- truth governance
- write policy

Source Recall refs cannot authorize profile-memory writes, semantic lesson commits, semantic
candidate promotion, approval, action execution, safety decisions, or completion proof.

## Projection

Projection is a review surface.

Review-safe projection may show Source Recall metadata and bounded or redacted excerpts when the
Source Recall projection latch allows it. Operator-full projection requires its own explicit latch.

Projected Source Recall notes cannot re-enter Source Recall as ordinary source input and cannot
authorize review actions by source ref alone. Structured review actions must still pass through the
governed runtime mutation path.

## Lifecycle And Delete Behavior

Inactive lifecycle states are hidden from retrieval, visible index refs, and projection:

- `redacted`
- `forgotten`
- `expired`
- `quarantined`
- `projection_only_removed`

Delete and forget flows must invalidate chunk visibility and index references. Projection and
review paths must not show inactive records as active evidence.

## Evidence And Tests

The production evidence matrix must prove both recall quality and authority safety.

Required proof categories include:

- exact quote recall
- scope and thread filtering
- temporal recall
- relationship-source recall
- assistant/task summary recall
- media/document recall
- projection boundary behavior
- delete/forget visibility
- prompt-spoof isolation
- artifact privacy
- production status reporting

The evidence matrix must not pass by copying expected values into observed fields. It must not
label schema-only or mocked output as live runtime proof.

## Related References

- [Architecture reference](./ARCHITECTURE.md)
- [Concepts glossary](./CONCEPTS.md)
- [Setup guide](./SETUP.md#source-recall-archive)
- [Source Recall subsystem README](../src/core/sourceRecall/README.md)
