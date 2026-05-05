# Source Recall Production Roadmap

## Plan Status

In progress.

This plan adapts the operator's Source Recall production draft into a repo-local roadmap. The
foundation branch is treated as a Source Recall contract and test foundation, not a production
launch.

The immediate next implementation branch is intentionally narrow:

```text
feat/source-recall-encrypted-user-turn-capture
```

That branch should implement encrypted production storage, explicit config latches, and live
`conversation_turn` capture only. It must not enable media/document capture, planner/chat retrieval,
automatic context injection, semantic candidate promotion, or projection expansion.

## Current Verified Foundation State

This roadmap was re-checked against the current local repository before production planning.
Do not treat older audit notes as automatically current.

Verified current state:

- `SourceRecallStore` is still a test-only plaintext SQLite document store. It throws unless
  `testOnlyAllowPlaintextStorage: true` is provided.
- No production `BrainConfig`, interface runtime config, or shared runtime construction currently
  builds a Source Recall store.
- `createSourceRecallRetentionPolicyFromEnv` exists, but it is not yet wired into the canonical
  runtime config contract.
- The current retention helper has broad default source-kind constants for foundation tests. The
  production branch must not reuse that broad list as the production capture default.
- Live user-turn, lower-authority assistant/task, media/document, retrieval, context-rendering,
  projection, receipt, and memory-bridge helpers exist from the foundation branch.
- Production conversation/media/document callsites do not currently write Source Recall by default.
- Planner/chat paths do not currently retrieve or inject Source Recall by default.
- The immediate branch must wire only live `conversation_turn` capture and must keep the existing
  assistant/task/media/document/context/projection helpers unwired from production runtime.
- `docs/plans/` is ignored by git in this repository, so this roadmap requires an explicit
  force-add if it is committed.

## Agent Start Here

Do not read this roadmap and begin a broad Source Recall refactor.

Start with exactly one slice:

```text
A1 - Encrypted Production Source Recall Storage
```

Use this branch name unless the operator explicitly chooses a different one:

```text
feat/source-recall-encrypted-user-turn-capture
```

Do not add a `codex/` prefix to Source Recall roadmap branches. The branch names in this document
are intentionally operator-facing names.

Before editing, verify the current code again. The older audit and previous progress ledger are
useful context, but they are not proof that the current repo still has the same seams.

The only valid first behavior change is encrypted production-capable storage. Do not start with live
capture, media/document capture, retrieval, context injection, projection, or semantic candidate
promotion.

## Objective

Finish Source Recall as a production-capable AgentBigBrain memory-evidence layer without weakening
the runtime's authority model.

Source Recall preserves what was said or seen as source-labeled, scoped, threaded evidence. It can
support recall, review, source attribution, semantic candidate extraction, projection, and wake-up
context after those consumers are explicitly gated.

It cannot decide:

- current truth
- durable memory promotion
- planner action authority
- approval
- safety
- completion proof
- side-effect permission
- Obsidian write-back authority

## Core Invariant

Source Recall can remind AgentBigBrain what was said or seen.

It cannot decide what is true, allowed, approved, completed, or safe to act on.

## Execution Mode

This is a checkpointed multi-branch roadmap, not a single broad production-completion branch.

Each branch must implement a small reviewable slice, pass focused tests, run the required checks,
append the progress ledger, and stop. Do not collapse assistant/task capture, media/document
capture, context injection, memory bridges, projection, and evidence expansion into the next branch.

When the operator explicitly asks for end-to-end autonomous execution, the agent may continue from
one slice to the next in the same run only after the current slice fully passes its completion gate.
End-to-end mode does not relax privacy, authority, testing, branch, commit, or sensitive-scan
requirements.

In end-to-end mode, preserve review boundaries through:

- one named branch per Branch Queue item, or
- one active implementation branch with separate checkpoint commits matching each Branch Queue item,
  only when the operator explicitly asks for a single-branch execution.

Either way, do not combine unrelated slices in one commit.

The current roadmap keeps the A1-A5 work on one immediate branch for momentum. That is acceptable
only because A1-A5 are mandatory checkpoint slices. If A1 encrypted storage grows beyond its scope
budget or storage/config review becomes hard to isolate, split the immediate work into:

1. `feat/source-recall-encrypted-storage`
2. `feat/source-recall-user-turn-capture`

## Agent Execution Protocol

The agent must execute this roadmap as ordered slices. Later phases can look easier than earlier
ones; that does not make them safe to start.

### No Phase Skipping By Inference

If a later branch looks easier, do not start it. Later branches depend on earlier authority,
storage, retention, delete, and evidence gates even when their owner files appear unrelated.

The only valid first slice is `A1 - Encrypted Production Source Recall Storage`.

### Required Slice Loop

For every slice, execute this loop in order:

1. Re-read this roadmap's current slice plus `## Global Stop Conditions`,
   `## Required Guard Tests`, and `## Phase Dependency Locks`.
2. Re-verify current repo seams before editing.
3. Inspect every owner file listed for the slice.
4. Add or update focused tests that expose the current missing behavior or guard the existing
   boundary.
5. Implement the smallest production change that satisfies the slice.
6. Run the focused tests for that slice.
7. Run required behavior-slice checks.
8. Run the focused sensitive scan for changed files, fixtures, docs, generated evidence, and staged
   diff.
9. Update the progress ledger.
10. Update this roadmap's `## Last Worked On` if the plan or status changed.
11. Create a checkpoint commit.
12. Continue only if every acceptance criterion passed and no stop condition fired.

A3 live user-turn capture cannot start until A1 encrypted storage and A2 config latches both have
passing focused tests and checkpoint commits. Do not rely on an uncommitted working tree as the
handoff boundary for live capture.

### Slice Completion Note

Every slice completion note must include:

- slice id
- branch name
- commit hash when available
- files inspected
- files changed
- tests added
- tests run
- checks run
- evidence artifacts produced
- sensitive scan status
- behavior changed
- behavior intentionally not changed
- production defaults after the slice
- known limitations
- whether the next slice is unblocked

### Scope Budget

A normal slice should touch:

- 1 to 6 production files,
- 1 to 4 focused test files,
- optionally 1 docs/progress file.

If a slice needs more than 8 production files, split it or stop and record why the planned owner
set was too small. Do not hide broad rewrites behind the Source Recall roadmap.

### Later Branch Work-Packet Gate

The A branch is fully packetized below. Before implementing B through G, the agent must convert the
branch into a concrete work packet in this roadmap or the progress ledger with:

- objective
- exact owner files
- read-only context files
- prohibited changes
- implementation tasks
- focused tests
- acceptance criteria
- evidence required
- stop conditions

Do not implement a later branch from its high-level heading alone.

### Pre-Slice Verification Commands

Before each behavior slice, run a current-code verification equivalent to:

```powershell
Get-ChildItem -Path src -Recurse -Filter *.ts |
  Select-String -Pattern 'new SourceRecallStore\(|testOnlyAllowPlaintextStorage|recordUserTurnWithSourceRecall\(|recordAssistantTurnWithSourceRecall\(|retrieveSourceRecall\(|renderSourceRecallContextForModelEgress\('

Select-String -Path src\core\sourceRecall\*.ts `
  -Pattern 'DEFAULT_SOURCE_RECALL_CAPTURE_SOURCE_KINDS|BRAIN_SOURCE_RECALL|encryptedPayloadsAvailable|sourceRoleAllowlist|captureLowerAuthority|captureLiveUserTurn'
```

If these commands reveal a production callsite, config field, or retrieval/context/projection wiring
that is not reflected in this roadmap, update the plan or stop before implementing.

### Post-Slice Verification Commands

After A1 and A2, run the same scan again and include the result in the completion note. The scan
must specifically account for:

- `new SourceRecallStore(`
- `testOnlyAllowPlaintextStorage`
- `recordUserTurnWithSourceRecall`
- `recordAssistantTurnWithSourceRecall`
- `retrieveSourceRecall`
- `renderSourceRecallContextForModelEgress`
- `BRAIN_SOURCE_RECALL`

Unexpected new production callsites are a stop condition.

### Evidence Integrity Rule

Do not make tests pass by weakening assertions, copying expected values into observed fields,
labeling failures as blocked without a real dependency block, or replacing runtime behavior proof
with schema-only proof.

A test or evidence artifact must say which category it proves:

- contract/schema shape
- mocked plumbing
- runtime route/capture observation
- actual storage write/read
- actual retrieval
- delete/forget/redact cascade
- blocked dependency
- non-authority behavior
- prompt-injection isolation

A test that proves one category must not be cited as proof of another category.

### Autonomous Stop Conditions

In addition to the global stop conditions, an autonomous agent must stop and report when:

- owner files differ materially from the roadmap,
- implementation requires enabling a deferred source kind,
- encryption or key initialization design is ambiguous,
- a runtime callsite can write or retrieve Source Recall without explicit latches,
- a planned test would need real private data,
- a generated artifact contains raw source text after delete/forget,
- branch state is dirty with unrelated user changes,
- the agent cannot tell whether a string is source evidence, runtime authority, approval, proof, or
  prompt instruction.

## Branch Queue

1. `feat/source-recall-encrypted-user-turn-capture`
2. `feat/source-recall-review-retrieval`
3. `test/source-recall-private-live-smoke`
4. `feat/source-recall-assistant-task-capture`
5. `feat/source-recall-media-document-capture`
6. `feat/source-recall-context-injection`
7. `feat/source-recall-semantic-candidate-bridge`
8. `feat/source-recall-projection-review`
9. `test/source-recall-production-evidence-matrix`
10. `docs/source-recall-production-contract`

## Checkpoint Commit Rule

Create a checkpoint commit after every passed slice.

Commit format:

```text
feat(source-recall): <slice id> <short outcome>
```

Do not make one giant commit.

## Progress Ledger

Maintain:

```text
docs/plans/source-recall-production-progress.md
```

Each checkpoint must append:

- slice id
- commit hash
- files inspected
- files changed
- tests added
- tests run
- checks run
- evidence produced
- sensitive scan status
- behavior changed
- behavior intentionally not changed
- known limitations
- next slice status: `unblocked`, `blocked`, `failed`, or `deferred`

Do not store private fixture content, local desktop paths, secrets, raw source chunks, raw scan
needles, recovered private text, or full generated evidence payloads in the progress ledger.

Synthetic test source text is allowed in focused tests when it is obviously artificial and not
copied from real user data. Generated evidence, progress ledgers, logs, and committed artifacts must
not retain raw source text after delete/forget scenarios.

## Global Stop Conditions

Stop immediately if:

- production raw source text can be stored unencrypted
- production capture can run without explicit config latches
- production capture can run without an enabled source-kind allowlist
- production capture can use the broad foundation default source-kind list instead of an explicit
  production allowlist
- encryption readiness is accepted from a boolean env flag instead of derived from initialized
  encrypted storage/key material
- the Source Recall SQLite path is not included in protected-path containment checks before runtime
  wiring
- retrieved source chunks can authorize memory writes, actions, approvals, safety, or completion proof
- source chunks enter prompts unquoted
- source chunks are treated as live user instructions
- sensitive scan finds secrets, local desktop paths, private fixture data, raw source text, or token-shaped values
- a slice needs unrelated behavior changes
- live proof is required but the live dependency is missing
- focused tests fail
- full build/checks fail
- delete/forget cascade cannot be proven
- projection can expose full excerpts without an explicit operator-full latch
- mock/schema-only evidence is relabeled as live proof

## Global Required Checks

Run after every behavior slice:

```bash
npm run check:test-types
npm run check:no-unused-locals
npm run build
```

Run before each branch is opened for review:

```bash
npm run check:docs
npm run check:ai-first
npm run check:module-size
```

Run before a branch that changes runtime behavior is merged:

```bash
npm test
```

Run before branches that change Source Recall evidence:

```bash
npm run test:source_recall:evidence
```

Sensitive scan must cover:

- changed source files
- changed tests
- changed fixtures
- changed docs
- generated evidence
- staged diff
- runtime/evidence artifacts intended for commit

## Default Production Posture

Until explicitly enabled by config:

- Source Recall is disabled at the top-level runtime latch.
- Source Recall production storage is disabled.
- Source Recall production capture is disabled.
- Source Recall retrieval is disabled.
- Source Recall projection is disabled.
- Source Recall live interface capture is disabled.

No source text should enter production Source Recall by default.

## Non-Authority Contract

Source Recall records, chunks, excerpts, source refs, and recall bundles must not directly decide:

- profile-memory facts
- profile-memory episodes
- semantic-memory lessons
- graph-current truth
- planner action type
- action approval
- network/browser/process/file side effects
- safety gate pass/fail
- Stage 6.86 mutation
- Obsidian write-back
- mission completion
- user-facing success
- proactive outreach
- skill lifecycle permission

Source Recall may:

- remind the model or operator what was said or seen
- provide evidence spans for semantic candidate extraction
- provide linkable provenance for governed memory
- provide review-safe excerpts in projections
- support quote recall and decision-history recall

## Source Recall Vocabulary

Use AgentBigBrain-native names only:

- scope
- thread
- source record
- chunk
- source excerpt
- source evidence
- recall bundle

Do not use copied or cute external memory metaphors.

## Source Kind And Authority Rules

Source kind describes what the material is.

Source role describes who or what produced it.

Source authority describes the existing AgentBigBrain authority lane.

Capture class decides whether a source-adjacent surface is normally eligible for capture.

Recall authority is always:

```text
quoted_evidence_only
```

Do not add a generic `source_recall` source authority.

## Source-Kind Enablement Rule

Production capture must require a source-kind allowlist. The next branch may enable only:

```text
conversation_turn
```

The production allowlist must be parsed from explicit config. Unknown, empty, or missing production
allowlists must fail closed to no capture. Do not use
`DEFAULT_SOURCE_RECALL_CAPTURE_SOURCE_KINDS` as the production default, because that foundation
constant currently contains all known source kinds for tests and policy helpers.

The immediate branch may capture only this tuple:

```text
sourceKind=conversation_turn
sourceRole=user
captureClass=ordinary_source
```

All other source kinds remain deferred until separate branches:

- `assistant_turn`
- `task_input`
- `task_summary`
- `document_text`
- `document_model_summary`
- `media_transcript`
- `ocr_text`
- `media_model_summary`
- `review_note`
- `execution_receipt_excerpt`

## Required Source Roles

- `user`
- `assistant`
- `tool`
- `external_agent`
- `runtime`
- `operator_review`
- `test_fixture`

## Required Capture Classes

- `ordinary_source`
- `assistant_output`
- `operational_output`
- `external_output`
- `policy_metadata`
- `runtime_control_metadata`
- `projection_metadata`
- `test_fixture`
- `repository_reference`
- `excluded_by_default`

## Required Lifecycle States

- `active`
- `redacted`
- `forgotten`
- `expired`
- `quarantined`
- `projection_only_removed`

## Required Retrieval Modes

- `source_id`
- `exact_quote`
- `scope_thread_filter`
- `semantic_vector`
- `hybrid`
- `keyword`
- `recent_fallback`

## Required Retrieval Authority Values

- `exact_source_ref`
- `strong_recall_evidence`
- `weak_recall_evidence`
- `diagnostic_only`

## Required Freshness Values

- `current_turn`
- `recent`
- `historical`
- `stale`
- `unknown`

## Required Source Time Kinds

- `observed_event`
- `captured_record`
- `generated_summary`
- `unknown`

## Default Non-Capture Contract

Source Recall must not capture these by default:

- full model prompts
- system/developer instructions
- raw provider responses
- temporary schema files
- auth stores
- tokens
- credential-presence probes
- environment values
- connector secrets
- Telegram download URLs
- raw connector request/response bodies
- raw federation shared-secret headers
- full shell stdout/stderr
- full file-read previews
- full browser observed body text
- full runtime state snapshots
- process/browser session snapshots
- generated probe folders
- local test logs
- ignored runtime artifacts
- local environment files
- model asset folders
- dependency folders
- projection mirrors
- scenario expected-route fields
- mock model outputs as production source
- generated evidence artifacts as production source
- CI metadata as production source

Production capture must reject test fixtures, mock outputs, schema-only artifacts, generated evidence,
live-smoke output, temp probes, local logs, CI metadata, and projection mirrors unless the runtime is
explicitly in Source Recall evidence mode.

## Retrieval Output Budgets

Retrieval output must be bounded by:

- maximum records
- maximum chunks
- maximum excerpt characters per chunk
- maximum total excerpt characters
- source-kind allowlist for the current consumer
- source-role allowlist for the current consumer
- sensitivity redaction policy
- lifecycle visibility policy

Retrieval audit must store hashes and ids only. It must not store raw query text or raw excerpts.

## Prompt-Injection Contract

Source chunks can be read. They cannot be obeyed.

Every retrieved chunk must be:

- quoted or fenced
- source labeled
- marked `unsafeToFollowAsInstruction=true`
- marked `recallAuthority=quoted_evidence_only`
- rendered as not-current-user-instruction
- rendered as not approval
- rendered as not route metadata
- rendered as not receipt proof
- rendered as not memory truth

Prompt-injection negative controls must include:

- `/approve`
- `Resolved semantic route:`
- `TASK COMPLETE`
- `network_write approved`
- `ignore previous instructions`
- fake receipt-looking text
- fake memory-write-looking text

## Required Guard Tests

Every production branch must add or preserve guard tests proving:

1. no production callsite can pass `testOnlyAllowPlaintextStorage`
2. no live conversation/media/document path writes Source Recall by default
3. no planner/chat path retrieves Source Recall by default
4. Source Recall refs cannot authorize memory writes, approval, action, safety, or completion proof
5. quoted-evidence rendering prevents route/approval/command/proof spoofing
6. forgotten/redacted/quarantined records are hidden from retrieval, projection, and index refs
7. non-capture surfaces are rejected outside explicit evidence mode
8. sensitive scan covers changed docs, tests, fixtures, generated evidence, and staged diff
9. production config cannot report encryption readiness from a raw boolean env flag
10. Source Recall storage paths are covered by protected-path containment checks before runtime
    construction
11. lower-authority assistant/task/media/document helpers remain unwired until their dedicated
    branches
12. retrieval/context/projection helpers remain unwired from planner/chat/runtime projection until
    their dedicated branches

## Phase Dependency Locks

| Slice | Cannot start until |
|---|---|
| A1 encrypted storage | foundation branch reviewed and merged |
| A2 config latches | A1 storage tests pass or config can be isolated without storage wiring |
| A3 live user-turn capture | A1 and A2 pass and both have checkpoint commits |
| A4 review/evidence retrieval for proof | A1, A2, A3, and delete lifecycle pass |
| A5 private live smoke | A3 and A4 pass |
| B1 assistant/task capture | A3-A5 pass |
| C1 media/document capture | A3-A5 pass and assistant/task capture is not in progress |
| D1 context injection | bounded review retrieval passes and prompt-rendering tests exist |
| E1 semantic candidate bridge | D1 passes |
| F1 projection/review | config latch, delete/redact, and projection latch tests pass |
| G1 production evidence matrix | all asserted authority boundaries are implemented |

---

# A - Immediate Branch: Encrypted User-Turn Capture

## Branch

```text
feat/source-recall-encrypted-user-turn-capture
```

## Scope

This branch may implement only:

- encrypted production-capable Source Recall storage
- explicit Source Recall config latches
- live `conversation_turn` capture behind those latches
- minimal review/evidence retrieval only if needed to prove capture/delete behavior
- synthetic/private smoke evidence for the enabled user-turn path

This branch must not implement:

- assistant/task summary capture
- media/document capture
- automatic planner/chat retrieval
- normal context injection
- semantic candidate promotion
- Obsidian projection expansion
- operator-full projection
- broad evidence matrix expansion beyond the enabled path

## A1 - Encrypted Production Source Recall Storage

### Objective

Replace the test-only plaintext store path with encrypted production-capable storage.

### Owner Files

- `src/core/sourceRecall/sourceRecallStore.ts`
- `src/core/sourceRecall/sourceRecallPersistence.ts`
- `src/core/sourceRecall/sourceRecallRetention.ts`
- `src/core/sourceRecall/contracts.ts`
- `src/core/sourceRecall/README.md`
- new `src/core/sourceRecall/sourceRecallEncryption.ts` or a shared generic encrypted-payload
  helper
- `src/core/config.ts`
- `src/core/configRuntime/envContracts.ts`
- `src/core/buildBrain.ts`
- profile-memory crypto/persistence helpers as read-only context only
- `tests/core/sourceRecallStore.test.ts`
- config/encryption tests
- new encrypted store tests

### Work

Before implementation, write a short encrypted payload design note in the progress ledger. It must
state:

- which payload fields are encrypted
- which metadata fields remain plaintext
- how the key is provided and validated
- how plaintext rows are rejected, migrated, or deferred
- why production readiness is derived from initialized encrypted storage/key material instead of an
  env boolean

1. Add a production storage mode that cannot write raw text unless encryption policy is satisfied.
2. Keep `testOnlyAllowPlaintextStorage` test-only.
3. Add encrypted persistence for source records and chunks.
4. Preserve lifecycle states:
   - `active`
   - `redacted`
   - `forgotten`
   - `expired`
   - `quarantined`
   - `projection_only_removed`
5. Ensure source ids, chunk ids, hashes, and origin refs never contain raw source text.
6. Add idempotent upsert behavior:
   - same origin ref + source kind + content hash does not duplicate records unless explicitly versioned.
7. Ensure raw record text is never written through JSON export or progress ledger.
8. Ensure migration/test modes remain explicit and visibly separate.
9. Add a static/guard test proving no production callsite under `src/**` can pass
   `testOnlyAllowPlaintextStorage: true`.
10. Add a Source Recall SQLite path config and include it in protected path prefixes.
11. Derive `encryptedPayloadsAvailable` from initialized encrypted storage/key material. Do not
    trust a standalone `BRAIN_SOURCE_RECALL_ENCRYPTED_PAYLOADS_AVAILABLE` style flag.
12. Reject or explicitly migrate any existing plaintext Source Recall rows when running in
    production mode.
13. Encrypt raw chunk/source text. Metadata may remain plaintext only when explicitly designed and
    test-proven not to contain raw source text.
14. Do not persist the current test-only `document_json` shape with plaintext chunk text in
    production mode. If a JSON envelope remains inside SQLite, its raw source payload fields must be
    encrypted or absent.

### Prohibited Changes

- Do not enable live capture.
- Do not add planner/chat retrieval.
- Do not add media/document capture.
- Do not expand projection.

### Acceptance Criteria

- Production store cannot initialize without encryption policy.
- Test-only plaintext mode remains impossible from production callsites.
- Production storage readiness is derived from actual key/store initialization, not a boolean env
  assertion.
- Source Recall SQLite path is protected from file/path side effects.
- Existing plaintext rows are rejected or require explicit migration in production mode.
- The test-only plaintext row/table shape cannot be mistaken for production storage.
- Delete/forget/redact lifecycle works on encrypted records.
- Forgotten/redacted/quarantined chunks are hidden from normal reads.
- Existing foundation tests still pass.
- Sensitive scan finds no raw source text in docs, evidence, progress, fixtures, or logs.

### Tests

```bash
npm test -- sourceRecallStore
npm test -- sourceRecallRetention
npm run check:test-types
npm run build
```

### Completion Note Must Include

- encryption decision implemented
- storage mode implemented
- test-only mode isolation proof
- production callsites inspected
- pre-slice and post-slice Source Recall callsite/config scans
- encrypted payload design note summary
- delete/redact/forget behavior
- tests and checks run

## A2 - Source Recall Config Latches

### Objective

Make Source Recall impossible to enable accidentally.

### Owner Files

- `src/core/config.ts`
- `src/core/configRuntime/configParsing.ts`
- `src/core/configRuntime/envContracts.ts`
- `src/interfaces/runtimeConfig.ts`
- `src/core/buildBrain.ts`
- docs/env setup files
- config tests

### Work

Add explicit config latches:

```env
BRAIN_SOURCE_RECALL_ENABLED=false
BRAIN_SOURCE_RECALL_CAPTURE_ENABLED=false
BRAIN_SOURCE_RECALL_RETRIEVAL_ENABLED=false
BRAIN_SOURCE_RECALL_PROJECTION_ENABLED=false
BRAIN_SOURCE_RECALL_OPERATOR_FULL_PROJECTION_ENABLED=false
BRAIN_SOURCE_RECALL_INDEX_ENABLED=false
BRAIN_SOURCE_RECALL_EVIDENCE_MODE=false
BRAIN_SOURCE_RECALL_SQLITE_PATH=runtime/source_recall.sqlite
BRAIN_SOURCE_RECALL_ENCRYPTION_KEY=
BRAIN_SOURCE_RECALL_CAPTURE_SOURCE_KINDS=conversation_turn
BRAIN_SOURCE_RECALL_CAPTURE_CLASSES=ordinary_source
```

1. Capture cannot run unless Source Recall and capture latches are enabled.
2. Capture cannot run unless the source kind is explicitly allowed.
3. Capture cannot run unless the capture class is explicitly allowed.
4. Retrieval cannot run unless Source Recall and retrieval latches are enabled.
5. Projection cannot show source excerpts unless Source Recall and projection latches are enabled.
6. Operator-full projection requires a separate explicit latch.
7. Add Source Recall config fields to `BrainConfig` and interface runtime config.
8. Flow config into shared runtime construction without constructing a Source Recall store when the
   top-level latch is disabled.
9. Remove or ignore any standalone encrypted-payloads-available env flag. Encryption availability
   must come from initialized storage.
10. Runtime status should show:
   - `disabled`
   - `enabled`
   - `blocked_missing_encryption`
   - `blocked_missing_storage`
   - `blocked_by_policy`
11. Config docs must warn that verbatim/source recall is sensitive by default.

### Prohibited Changes

- Do not capture production data yet.
- Do not auto-retrieve into planner/chat.
- Do not enable projection by default.

### Acceptance Criteria

- Default production posture is disabled.
- Misconfigured Source Recall blocks with a concrete reason.
- Production capture cannot run through default config.
- Docs explain latches without encouraging broad raw capture.
- Operator-full projection cannot be enabled accidentally.
- Source-kind allowlist is explicit and supports only `conversation_turn` in the immediate branch.
- Capture-class allowlist is explicit and supports only `ordinary_source` in the immediate branch.
- Unknown, empty, or missing production allowlists capture nothing.
- `DEFAULT_SOURCE_RECALL_CAPTURE_SOURCE_KINDS` is not used as the production default.

### Tests

```bash
npm test -- sourceRecallRetention
npm test -- runtimeConfig
npm test -- config
npm run check:test-types
npm run build
```

### Completion Note Must Include

- exact config names
- defaults
- blocked-state behavior
- runtime status behavior
- pre-slice and post-slice Source Recall callsite/config scans
- docs changed
- tests and checks run

## A3 - Live User-Turn Capture

### Objective

Enable production capture for one source kind only:

```text
conversation_turn
```

### Owner Files

- `src/core/sourceRecall/sourceRecallConversationCapture.ts`
- `src/interfaces/conversationSessionMutations.ts`
- `src/interfaces/sessionStore.ts`
- `src/interfaces/conversationRuntime/contracts.ts`
- `src/interfaces/conversationRuntime/managerContracts.ts`
- `src/interfaces/conversationRuntime/commandDispatch.ts`
- `src/interfaces/conversationRuntime/conversationRoutingTurnSupport.ts`
- `src/interfaces/conversationRuntime/conversationRoutingQueueSupport.ts`
- `src/interfaces/conversationRuntime/conversationRoutingDirectReplies.ts`
- `src/interfaces/conversationRuntime/conversationRoutingInlineReplies.ts`
- `src/interfaces/conversationRuntime/followUpResolution.ts`
- `src/interfaces/interfaceRuntime.ts`
- conversation runtime/session tests
- source recall conversation capture tests

### Work

1. Capture live user turns only when:
   - Source Recall enabled
   - capture enabled
   - encrypted storage ready
   - source kind allowed
   - source role and capture class match the immediate allowlist
2. Record:
   - scope id
   - thread id
   - source record id
   - chunk id
   - origin ref
   - `sourceRole=user`
   - `sourceKind=conversation_turn`
   - `sourceAuthority=explicit_user_statement`
   - `recallAuthority=quoted_evidence_only`
   - freshness
   - observedAt/capturedAt
   - sensitivity
3. Capture failure must not crash conversation handling.
4. Capture failure diagnostics must not include raw text.
5. Delete/forget hides captured user-turn chunks.
6. Disabled config captures nothing.
7. If capture fails, conversation processing continues without Source Recall and records only a
   bounded non-raw diagnostic.
8. Capture failure must not retry in a loop or enqueue duplicate capture attempts.
9. Integrate through one central capture dependency/wrapper instead of ad hoc store construction at
   every `recordUserTurn` callsite.
10. Audit every current `recordUserTurn` production callsite and either route it through the central
   wrapper or document why it is not a live user source.
11. Prevent duplicate source records when one inbound turn passes through direct, inline, queue, or
   follow-up paths.
12. Keep `recordAssistantTurnWithSourceRecall`, `captureLowerAuthoritySourceRecall`, and media
    capture helpers unwired from production in this branch.

### Prohibited Changes

- Do not capture assistant turns yet.
- Do not capture media/docs yet.
- Do not inject retrieval into planner/chat yet.

### Acceptance Criteria

- Live user turns can be captured when explicitly enabled.
- Disabled config captures nothing.
- Failed capture records bounded diagnostics only.
- Failed capture does not block normal conversation handling, does not loop, and does not duplicate
  capture attempts.
- Captured source is retrievable only through enabled review/evidence retrieval.
- No memory truth or planner authority is granted.
- Exactly one source record is produced for one accepted inbound user turn.
- Assistant/task/media/document Source Recall helpers remain unwired from production callsites.
- Sensitive scan proves no raw user text enters logs or progress ledger.
- Regression tests prove media/document and assistant/task source kinds remain disabled.

### Tests

```bash
npm test -- sourceRecallConversationCapture
npm test -- conversationSessionMutations
npm test -- sessionStore
npm run check:test-types
npm run build
```

### Completion Note Must Include

- source kind enabled
- capture latches checked
- failure behavior
- raw-text diagnostic protections
- delete/forget behavior
- tests and checks run

## A4 - Review/Evidence Retrieval For Proof Only

### Objective

Enable bounded review/evidence retrieval only far enough to prove encrypted user-turn capture and
delete behavior. This slice must not add planner/chat retrieval.

### Owner Files

- `src/core/sourceRecall/sourceRecallRetriever.ts`
- `src/core/sourceRecall/sourceRecallIndex.ts`
- `src/core/memoryAccessAudit.ts`
- source recall retriever/index/audit tests

### Work

1. Add review/evidence retrieval mode.
2. Add output budgets:
   - max records
   - max chunks
   - max excerpt chars per chunk
   - max total excerpt chars
   - max source kinds by consumer
   - max source roles by consumer
3. Audit retrieval using hashes and ids only:
   - query hash
   - source record ids
   - chunk ids
   - excerpt counts/chars
   - blocked/redacted count
   - no raw query
   - no raw excerpt
4. Exclude forgotten/redacted/quarantined chunks from normal retrieval.
5. Expose source role, source authority, lifecycle, freshness, and retrieval mode in recall bundles.
6. Add `sourceRoleAllowlist` to the retrieval budget contract before production retrieval is wired.
7. Immediate review/evidence retrieval may return only `sourceKind=conversation_turn` and
   `sourceRole=user`.

### Prohibited Changes

- Do not inject into planner prompts.
- Do not use retrieval to answer as truth.
- Do not enable media/docs.
- Do not auto-retrieve in normal conversation.

### Acceptance Criteria

- Retrieval returns recall bundles only.
- Recall bundles carry non-authority flags.
- Retrieval audit stores no raw text.
- Forgotten/redacted/quarantined chunks are excluded.
- Output budgets are enforced.
- Source-kind and source-role allowlists are enforced by retrieval.
- Source refs prove existence only, not truth or permission.
- No production planner/chat callsite invokes `retrieveSourceRecall` or
  `renderSourceRecallContextForModelEgress` in this branch.

### Tests

```bash
npm test -- sourceRecallRetriever
npm test -- sourceRecallIndex
npm test -- memoryAccessAudit
npm run check:test-types
npm run build
```

### Completion Note Must Include

- retrieval modes implemented
- output budgets
- audit fields
- inactive lifecycle exclusion proof
- non-authority proof
- tests and checks run

## A5 - Private/Synthetic Live Smoke

### Objective

Prove production user-turn capture and retrieval work in a private/synthetic run.

### Owner Files

- source recall live-smoke script
- source recall evidence script
- source recall fixture/evidence tests

### Work

1. Run a synthetic private Source Recall flow.
2. Capture one user turn.
3. Retrieve exact quote as quoted evidence.
4. Forget/delete it.
5. Verify it no longer retrieves.
6. Write review-safe evidence artifact.
7. Mark unavailable live dependencies as `BLOCKED`, not passed.

### Acceptance Criteria

- Evidence proves encrypted production storage path works.
- Evidence proves capture latch works.
- Evidence proves retrieval latch works.
- Evidence proves delete/forget cascade works.
- Evidence contains no private data, local desktop paths, token-shaped values, or raw secrets.
- Evidence distinguishes synthetic, runtime-observed, live-smoke, and blocked live dependency.
- Evidence proves media/document and assistant/task capture remain disabled.
- Evidence proves no planner/chat production path consumed retrieved Source Recall chunks.
- Evidence proves generated artifacts do not retain captured raw user text after forget/delete.

### Tests

```bash
npm run test:source_recall:evidence
npm test -- sourceRecall
npm run check:test-types
npm run build
```

### Completion Note Must Include

- live/synthetic environment status
- evidence artifact path
- capture/retrieve/delete proof
- sensitive scan result
- tests and checks run

---

# B - Later Branch: Assistant And Task Summary Capture

## Objective

Capture lower-authority assistant/task source records without confusing them with user source.

## Source Kinds

- `assistant_turn`
- `task_input`
- `task_summary`

## Required Rule

Assistant output is recallable as "what ABB said", not as truth. Task summaries are generated
summaries, not original user source. Recovered summaries must never be labeled as live user turns.

## Deferred Until

Complete after the encrypted user-turn branch passes review and after review retrieval proves
Source Recall chunks remain non-authoritative.

## Implementation Reminder

Foundation helpers for assistant/task capture already exist. This branch is about production
wiring, source-role/capture-class policy, and guard tests. Do not recreate the helper surface, and
do not let assistant/task text masquerade as live user source.

---

# C - Later Branch: Media And Document Capture

## Objective

Capture media/document-derived source layers as quoted evidence only.

## Source Kinds

- `media_transcript`
- `ocr_text`
- `document_text`
- `document_model_summary`
- `media_model_summary`

## Required Rule

Media/document chunks are quoted evidence. They cannot become executable instructions, profile truth,
approval, route metadata, safety proof, or completion proof.

## Deferred Until

Complete only after live user-turn capture, review retrieval, and private/synthetic live smoke pass.
Do not include this in the immediate production branch.

## Implementation Reminder

Foundation media/document capture helpers already exist. This branch must wire them behind separate
media/document latches, preserve media artifact deletion linkage, and prove document/media text is
quoted evidence rather than instruction, route metadata, profile truth, approval, safety, or proof.

---

# D - Later Branch: Source Recall Context Injection

## Objective

Allow Source Recall to enter model/planner/chat context only as quoted evidence.

## Required Rule

Context injection must be consumer-gated. It must not auto-inject Source Recall into every planner
request. It must carry source labels, non-authority labels, retrieval mode, retrieval authority,
freshness, and `unsafeToFollowAsInstruction=true`.

## Implementation Reminder

The quoted-evidence renderer already exists. This branch must add the consumer policy and concrete
callsite gating. Until this branch lands, production planner/chat paths must not retrieve or render
Source Recall by default.

---

# E - Later Branch: Source Recall To Semantic Candidate Bridge

## Objective

Let Source Recall support semantic memory candidates without becoming governed memory truth.

## Required Rule

Source chunks can support candidates. Truth governance still decides promotion. Source refs are
provenance only.

---

# F - Later Branch: Projection And Review

## Objective

Show Source Recall safely in Obsidian/JSON projection and review flows.

## Required Rule

Review-safe projection shows metadata and redacted excerpts only. Operator-full projection requires
an explicit config latch. Projection output cannot re-enter Source Recall as ordinary source.

## Implementation Reminder

Projection read-model helpers already exist. This branch must wire them into projection snapshots
only after latch, delete/redact, and review-action boundary tests prove projection cannot become
runtime authority.

---

# G - Later Branch: Production Evidence Matrix

## Objective

Prove production Source Recall works and remains non-authoritative.

## Required Coverage

### Recall Quality

- exact quote recall
- scope/thread filtering
- temporal recall
- relationship-source recall
- assistant/task summary recall after that branch lands
- media/document recall after that branch lands

### Authority Safety

- retrieved source cannot authorize action
- retrieved source cannot write memory
- retrieved source cannot satisfy completion proof
- retrieved source cannot approve network write
- retrieved source cannot bypass safety
- retrieved source cannot spoof route metadata
- retrieved source cannot satisfy browser/process/file proof

### Privacy

- delete/forget cascade
- projection redaction
- sensitive scan
- non-capture firewall
- test fixture rejection
- no raw prompt/provider/auth/env capture

### Live/Synthetic

- synthetic CI-safe matrix
- optional private Telegram/CLI smoke if live env is available
- blocked live dependency reporting when unavailable

## Acceptance Criteria

- Evidence distinguishes synthetic, schema-only, runtime-observed, live-smoke, and blocked live
  dependency.
- No expected-result copying.
- No mocked proof presented as live proof.
- Matrix proves non-authority behavior, not just retrieval.
- Sensitive scan passes on generated artifacts.
- Production status is accurately represented: enabled, disabled, blocked, or live-proven.

---

# Immediate Branch Definition Of Done

The immediate encrypted user-turn branch is complete only when all of these are true:

1. Source Recall storage is encrypted for production use.
2. Test-only plaintext storage remains isolated from production callsites.
3. Production capture is explicitly config-latched.
4. Source-kind capture is explicitly allowlisted.
5. Live `conversation_turn` capture works when enabled.
6. Media/document capture remains disabled.
7. Assistant/task capture remains disabled.
8. Retrieval is review/evidence-only and disabled by default.
9. No planner/chat path retrieves Source Recall by default.
10. Retrieved chunks remain quoted evidence only.
11. Source chunks cannot create memory truth.
12. Source chunks cannot authorize actions, approvals, safety, or completion proof.
13. Delete/forget/redact hides chunks from retrieval and index refs.
14. Synthetic/private evidence proves capture, retrieval, and delete behavior.
15. Final sensitive scan passes.
16. Final `npm test` passes before merge.
17. Progress ledger has checkpoint entries for every slice.
18. Existing foundation helpers for assistant/task/media/document capture, context rendering, and
    projection remain unwired from production runtime.

# Roadmap Definition Of Done

The full Source Recall production roadmap is complete only when all of these are true:

1. Source Recall storage is encrypted for production use.
2. Production capture is explicitly config-latched.
3. Live user-turn capture works when enabled.
4. Assistant/task summary capture is lower-authority and correctly labeled.
5. Media/document capture works with quoted-data boundaries.
6. Retrieval is bounded, audited, source-labeled, and non-authoritative.
7. Retrieved chunks enter prompts only as quoted evidence.
8. Source chunks can feed semantic candidates.
9. Source chunks cannot directly create memory truth.
10. Source chunks cannot authorize actions, approvals, safety, or completion proof.
11. Delete/forget/redact cascades through chunks, indexes, projection, and review links.
12. Obsidian/JSON projection is review-safe by default.
13. Operator-full projection requires an explicit latch.
14. Live/synthetic evidence proves recall quality and non-authority behavior.
15. Docs explain the difference between Source Recall, governed memory, semantic memory, receipts,
    approvals, and projection.
16. Final sensitive scan passes.
17. Final `npm test` passes.
18. Final progress ledger has checkpoint entries for every slice.

## When another agent picks this up:

Read these first:

- `docs/plans/SOURCE_RECALL_ARCHIVE_EXECUTION_PLAN.md`
- `docs/plans/source-recall-archive-design-decision.md`
- `docs/plans/source-recall-archive-progress.md`
- `docs/audit/SOURCE_RECALL_ARCHIVE_AUDIT.md`
- `src/core/sourceRecall/README.md`
- `src/core/sourceRecall/contracts.ts`

Do not restart the audit or foundation plan. The next clean seam is the immediate branch
`feat/source-recall-encrypted-user-turn-capture`.

Before editing, verify the current code again:

- `SourceRecallStore` should still reject production plaintext storage.
- Source Recall config should still be absent or disabled in the runtime unless A1/A2 already
  landed.
- Production `recordUserTurn` callsites should still not use Source Recall by default.
- Production planner/chat paths should still not call Source Recall retrieval or context rendering.

Start with `A1 - Encrypted Production Source Recall Storage`. Do not enable media/document capture,
assistant/task capture, planner/chat retrieval, context injection, semantic candidate promotion, or
projection expansion in that branch. If committing this roadmap, remember that `docs/plans/` is
ignored and requires an explicit `git add -f`.

## Last Worked On

Current phase or focus: A1 encrypted production Source Recall storage checkpoint.

What changed last: implemented encrypted production storage for `SourceRecallStore` using a new
AES-GCM payload envelope. Production storage now requires initialized 32-byte key material, rejects
test-only plaintext mode when a key is present, rejects existing plaintext rows in encrypted mode,
and persists encrypted envelopes instead of the plaintext foundation `document_json` shape. The
retention policy now derives encrypted payload availability from initialized storage/key material
instead of trusting a standalone env flag, and the Source Recall SQLite path is included in protected
path prefixes.

What still feels clunky, blocked, or unfinished: A2 must add the runtime config object and explicit
enable/capture/retrieval/projection/index/evidence latches. A3 live user-turn capture remains
blocked until A1 and A2 both have passing tests and checkpoint commits. The exact private/synthetic
smoke command should be chosen after A1-A4 land.

Next clean seam to continue from: checkpoint A1, then begin `A2 - Source Recall Config Latches`.

Latest validation or evidence state: A1 focused store/retention tests, type checks, unused-local
check, build, and docs check passed locally. A focused changed-file sensitive scan is required before
the A1 checkpoint commit.
