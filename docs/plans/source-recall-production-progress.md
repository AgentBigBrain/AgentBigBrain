# Source Recall Production Progress

## A1 - Encrypted Production Source Recall Storage

- date: 2026-05-05
- branch: `feat/source-recall-encrypted-user-turn-capture`
- status: passed before checkpoint commit
- encrypted payload design note:
  - payload fields encrypted: the full `SourceRecallDocument` JSON payload, including source records,
    chunks, chunk text, origin refs, hashes, timestamps, sensitivity flags, and lifecycle state.
  - plaintext metadata fields: SQLite row id, `storage_mode`, and AES-GCM envelope fields
    (`version`, `algorithm`, `ivBase64`, `tagBase64`, `ciphertextBase64`).
  - key source: A1 store construction accepts initialized 32-byte key material directly; A2 will
    decide env/config parsing and runtime construction.
  - key validation behavior: the store and encryption helper reject missing keys and any key that is
    not exactly 32 bytes.
  - plaintext row behavior: production encrypted mode rejects existing plaintext rows with an
    explicit migration error instead of silently reading or rewriting them.
  - readiness rule: production readiness is derived from initialized encrypted store/key material,
    not from a boolean environment flag.
- files inspected:
  - `src/core/sourceRecall/sourceRecallStore.ts`
  - `src/core/sourceRecall/sourceRecallPersistence.ts`
  - `src/core/sourceRecall/sourceRecallRetention.ts`
  - `src/core/sourceRecall/contracts.ts`
  - `src/core/profileMemoryRuntime/profileMemoryEncryption.ts`
  - `src/core/profileMemoryRuntime/profileMemoryPersistence.ts`
  - `src/core/config.ts`
  - `src/core/configRuntime/envContracts.ts`
  - `src/core/buildBrain.ts`
  - `tests/core/sourceRecallStore.test.ts`
  - `tests/core/sourceRecallRetention.test.ts`
- files changed:
  - `src/core/sourceRecall/sourceRecallEncryption.ts`
  - `src/core/sourceRecall/sourceRecallStore.ts`
  - `src/core/sourceRecall/sourceRecallRetention.ts`
  - `src/core/sourceRecall/README.md`
  - `src/core/config.ts`
  - `tests/core/sourceRecallStore.test.ts`
  - `tests/core/sourceRecallRetention.test.ts`
  - `docs/plans/SOURCE_RECALL_PRODUCTION_ROADMAP.md`
  - `docs/plans/source-recall-production-progress.md`
- tests added:
  - encrypted production round trip with raw-row ciphertext assertion.
  - production rejection for plaintext foundation rows.
  - mixed plaintext/encrypted mode rejection.
  - production source scan preventing `testOnlyAllowPlaintextStorage: true` under `src/**`.
  - retention policy proof that an env boolean alone cannot claim encrypted payload readiness.
- tests run:
  - `npx tsx --test tests/core/sourceRecallStore.test.ts tests/core/sourceRecallRetention.test.ts`
  - `npm run check:test-types`
  - `npm run check:no-unused-locals`
  - `npm run build`
  - `npm run check:docs`
- evidence produced:
  - focused test output in the local terminal.
  - pre/post source scans for Source Recall construction, capture, retrieval, context rendering, and
    env seams.
- sensitive scan status:
  - focused changed-file and staged-diff scans passed for A1 before checkpoint commit.
- behavior changed:
  - `SourceRecallStore` now has a production encrypted mode that requires initialized key material.
  - production encrypted mode writes an AES-GCM envelope instead of plaintext Source Recall JSON.
  - production encrypted mode rejects legacy/test plaintext rows pending explicit migration.
  - retention policy encrypted-payload readiness is provided by initialized storage/key material,
    not by a standalone env boolean.
  - `runtime/source_recall.sqlite` is included in protected-path prefixes.
- behavior intentionally not changed:
  - no live conversation capture is enabled in A1.
  - no planner/chat retrieval or context injection is enabled in A1.
  - assistant/task/media/document helpers remain unwired from production runtime in A1.
- production defaults after slice:
  - no production runtime creates a Source Recall store by default.
  - no production capture, retrieval, projection, or context injection is enabled by default.
  - test-only plaintext remains available only through the explicit constructor latch.
- known limitations:
  - A2 still needs runtime config parsing and latches before production construction is wired.
  - A3 live user-turn capture remains blocked until A1 and A2 checkpoint commits exist.
- next slice status: `unblocked` after A1 checkpoint commit.

## A2 - Source Recall Config Latches

- date: 2026-05-05
- branch: `feat/source-recall-encrypted-user-turn-capture`
- status: passed before checkpoint commit
- files inspected:
  - `src/core/config.ts`
  - `src/core/configRuntime/configParsing.ts`
  - `src/core/configRuntime/envContracts.ts`
  - `src/interfaces/runtimeConfig.ts`
  - `src/core/buildBrain.ts`
  - `src/core/sourceRecall/sourceRecallRetention.ts`
  - `.env.example`
  - `docs/SETUP.md`
  - `tests/core/config.test.ts`
  - `tests/interfaces/runtimeConfig.test.ts`
  - `tests/core/sourceRecallRetention.test.ts`
  - `tests/core/buildBrain.test.ts`
- files changed:
  - `.env.example`
  - `docs/SETUP.md`
  - `scripts/evidence/mediaIngestExecutionIntentLiveSmoke.ts`
  - `src/core/buildBrain.ts`
  - `src/core/config.ts`
  - `src/core/configRuntime/envContracts.ts`
  - `src/core/sourceRecall/README.md`
  - `src/core/sourceRecall/sourceRecallEncryption.ts`
  - `src/core/sourceRecall/sourceRecallRetention.ts`
  - `src/interfaces/runtimeConfig.ts`
  - `tests/core/buildBrain.test.ts`
  - `tests/core/config.test.ts`
  - `tests/core/sourceRecallRetention.test.ts`
  - `tests/helpers/conversationFixtures.ts`
  - `tests/interfaces/discordGateway.test.ts`
  - `tests/interfaces/runtimeConfig.test.ts`
  - `tests/interfaces/transportRuntime.test.ts`
- tests added:
  - Brain config defaults keep Source Recall disabled with empty production capture allowlists.
  - Brain config parses Source Recall latches without enabling capture by default.
  - Malformed Source Recall encryption key values are rejected only when Source Recall is enabled.
  - Runtime config exposes Source Recall latch status without raw key values.
  - Retention policy rejects missing, empty, unknown, or broad production allowlists.
  - Shared runtime construction does not build a Source Recall store when the top-level latch is
    disabled.
- tests run:
  - `npx tsx --test tests/core/sourceRecallStore.test.ts tests/core/sourceRecallRetention.test.ts tests/core/config.test.ts tests/interfaces/runtimeConfig.test.ts tests/core/buildBrain.test.ts`
  - `npm run check:test-types`
  - `npm run check:no-unused-locals`
  - `npm run build`
  - `npm run check:docs`
  - `npm test -- sourceRecallRetention` (blocked: repo runner has no file-name target)
  - `npm test -- runtimeConfig` (blocked: repo runner has no file-name target)
  - `npm test -- config` (blocked: repo runner has no file-name target)
- evidence produced:
  - focused test output in the local terminal.
  - post-slice callsite/config scan showing the only production `new SourceRecallStore(` callsite is
    the gated shared-runtime construction path.
- sensitive scan status:
  - focused changed-file and staged-diff scans passed for A2 before checkpoint commit.
- behavior changed:
  - `BrainConfig` and interface runtime config now carry Source Recall latch/status data without raw
    encryption key values.
  - Source Recall has an explicit top-level enabled latch.
  - capture, retrieval, projection, operator-full projection, indexing, and evidence mode each
    require their own explicit latches.
  - production capture allowlists are empty by default and accept only `conversation_turn` plus
    `ordinary_source` in the immediate branch.
  - shared runtime construction creates no Source Recall store when the top-level latch is disabled.
- behavior intentionally not changed:
  - no production capture is enabled in A2.
  - no planner/chat retrieval or context injection is enabled in A2.
  - no media/document, assistant/task, projection, or semantic-candidate Source Recall wiring is
    enabled in A2.
- production defaults after slice:
  - Source Recall disabled.
  - capture disabled.
  - retrieval disabled.
  - projection disabled.
  - operator-full projection disabled.
  - index disabled.
  - evidence mode disabled.
  - capture allowlists empty unless explicitly configured.
- known limitations:
  - A3 still needs the central live-user-turn capture wrapper and rollback diagnostics.
  - A4 still needs review/evidence retrieval budgets and audit events.
- next slice status: `unblocked` after A2 checkpoint commit.

## A3 - Live User-Turn Capture

- date: 2026-05-05
- branch: `feat/source-recall-encrypted-user-turn-capture`
- status: passed before checkpoint commit
- files inspected:
  - `src/interfaces/conversationSessionMutations.ts`
  - `src/interfaces/conversationRuntime/conversationRouting.ts`
  - `src/interfaces/conversationRuntime/conversationRoutingTurnSupport.ts`
  - `src/interfaces/conversationRuntime/conversationRoutingDirectReplies.ts`
  - `src/interfaces/conversationRuntime/conversationRoutingInlineReplies.ts`
  - `src/interfaces/conversationRuntime/conversationRoutingQueueSupport.ts`
  - `src/interfaces/conversationRuntime/commandDispatch.ts`
  - `src/interfaces/conversationRuntime/followUpResolution.ts`
  - `src/interfaces/conversationManager.ts`
  - `src/interfaces/interfaceRuntime.ts`
  - `src/interfaces/telegramGateway.ts`
  - `src/interfaces/discordGateway.ts`
  - `tests/interfaces/sourceRecallConversationCapture.test.ts`
- files changed:
  - `src/interfaces/conversationManager.ts`
  - `src/interfaces/conversationRuntime/commandDispatch.ts`
  - `src/interfaces/conversationRuntime/contracts.ts`
  - `src/interfaces/conversationRuntime/conversationRouting.ts`
  - `src/interfaces/conversationRuntime/conversationRoutingContracts.ts`
  - `src/interfaces/conversationRuntime/conversationRoutingDirectReplies.ts`
  - `src/interfaces/conversationRuntime/conversationRoutingInlineReplies.ts`
  - `src/interfaces/conversationRuntime/conversationRoutingQueueSupport.ts`
  - `src/interfaces/conversationRuntime/conversationRoutingTurnSupport.ts`
  - `src/interfaces/conversationRuntime/followUpResolution.ts`
  - `src/interfaces/discordGateway.ts`
  - `src/interfaces/interfaceRuntime.ts`
  - `src/interfaces/telegramGateway.ts`
  - `tests/interfaces/sourceRecallConversationCapture.test.ts`
- tests added:
  - manager-level live user-turn capture writes exactly one `conversation_turn:user` Source Recall
    record when encrypted production capture dependencies are present.
  - manager-level disabled/default capture writes no Source Recall records.
  - existing helper coverage was tightened so enabled policies include the top-level latch and
    explicit source-kind/capture-class allowlists.
- tests run:
  - `npx tsx --test tests/interfaces/sourceRecallConversationCapture.test.ts`
  - `npx tsx --test tests/core/sourceRecallStore.test.ts tests/core/sourceRecallRetention.test.ts tests/core/config.test.ts tests/interfaces/runtimeConfig.test.ts tests/core/buildBrain.test.ts tests/interfaces/sourceRecallConversationCapture.test.ts`
  - `npm run check:test-types`
  - `npm run check:no-unused-locals`
  - `npm run build`
  - `npm run check:docs`
- evidence produced:
  - focused manager-level capture tests.
  - post-slice source scan showing production user-turn writes now route through
    `recordTopicAwareUserTurn` and the only direct `recordUserTurn` production use is the canonical
    `recordUserTurnWithSourceRecall` wrapper.
  - post-slice Source Recall construction scan showing the only production `new SourceRecallStore(`
    callsite remains shared-runtime construction.
- sensitive scan status:
  - focused changed-file and staged-diff scans still required immediately before checkpoint commit.
- behavior changed:
  - Conversation ingress can now receive central Source Recall capture dependencies from the
    interface runtime.
  - Telegram and Discord gateways pass capture dependencies into `ConversationManager` only when
    the shared encrypted Source Recall store exists and provider config is enabled.
  - Live user-turn recording paths now use the Source Recall-aware helper, preserving normal session
    turn writes first and treating Source Recall capture as optional, bounded, and non-throwing.
  - `/auto`, follow-up/proposal fallback, direct replies, inline replies, follow-up queueing, and
    canonical routing paths all use the same live-user capture seam.
- behavior intentionally not changed:
  - assistant/task capture helpers remain unwired from production callsites.
  - media/document capture remains unwired from production callsites.
  - planner/chat retrieval and context injection remain disabled/unwired by default.
  - Obsidian projection and semantic-candidate promotion remain unchanged.
- production defaults after slice:
  - no capture occurs unless Source Recall is enabled, status is `enabled`, capture is enabled, an
    encrypted store exists, and the immediate allowlists permit `conversation_turn` plus
    `ordinary_source`.
  - capture failures do not crash conversation handling and only attach bounded non-raw diagnostic
    codes to the recorded turn.
- known limitations:
  - A4 still needs bounded review/evidence retrieval and minimal retrieval audit events.
  - A5 still needs a private/synthetic smoke that proves capture, exact-quote retrieval, and
    forget/delete behavior with raw evidence redacted.
- next slice status: `unblocked` after A3 checkpoint commit.

## A4 - Review/Evidence Retrieval

- date: 2026-05-05
- branch: `feat/source-recall-encrypted-user-turn-capture`
- status: passed before checkpoint commit
- files inspected:
  - `src/core/sourceRecall/contracts.ts`
  - `src/core/sourceRecall/sourceRecallRetriever.ts`
  - `src/organs/memoryContext/contextInjection.ts`
  - `tests/core/sourceRecallRetriever.test.ts`
  - `tests/organs/sourceRecallContextInjection.test.ts`
  - `tests/security/sourceRecallPromptInjection.test.ts`
- files changed:
  - `src/core/sourceRecall/contracts.ts`
  - `src/core/sourceRecall/sourceRecallRetriever.ts`
  - `src/organs/memoryContext/contextInjection.ts`
  - `tests/core/sourceRecallRetriever.test.ts`
  - `tests/organs/sourceRecallContextInjection.test.ts`
  - `tests/security/sourceRecallPromptInjection.test.ts`
  - `docs/plans/source-recall-production-progress.md`
- retrieval modes implemented:
  - `source_id`
  - `exact_quote`
  - `scope_thread_filter`
  - `semantic_vector`
  - `hybrid`
  - `keyword`
  - `recent_fallback`
- output budgets:
  - maximum records
  - maximum chunks
  - maximum excerpt characters per chunk
  - maximum total excerpt characters
  - source-kind allowlist
  - source-role allowlist
  - sensitivity policy
  - lifecycle visibility through record/chunk state
- audit fields:
  - query hash
  - scope/thread filters
  - retrieval mode
  - returned source record ids
  - returned chunk ids
  - total excerpts returned
  - total chars returned
  - blocked/redacted count
  - no raw query or raw excerpt text
- tests added:
  - source-role allowlist enforcement for review/evidence retrieval.
  - richer excerpt provenance for source kind, source role, source authority, lifecycle, freshness,
    and source time kind.
  - forgotten and quarantined records are excluded alongside redacted records.
- tests run:
  - `npx tsx --test tests/core/sourceRecallRetriever.test.ts tests/organs/sourceRecallContextInjection.test.ts tests/security/sourceRecallPromptInjection.test.ts`
  - `npm run check:test-types`
- evidence produced:
  - focused retrieval and quoted-rendering tests proving recall bundles remain non-authoritative and
    prompt-spoofing payloads are quoted.
- sensitive scan status:
  - focused changed-file and staged-diff scans still required immediately before checkpoint commit.
- behavior changed:
  - review/evidence retrieval now enforces source-role allowlists in addition to source-kind
    allowlists.
  - recall excerpts now expose source kind, source role, source authority, lifecycle state,
    freshness, and source time kind for review and rendering.
  - rendered Source Recall context includes that provenance while still marking excerpts as quoted
    evidence only.
- behavior intentionally not changed:
  - no planner/chat production callsite invokes `retrieveSourceRecall`.
  - no normal conversation context injection was wired.
  - no media/document, assistant/task, semantic candidate, or projection expansion was enabled.
- inactive lifecycle exclusion proof:
  - retriever tests exclude redacted, forgotten, and quarantined records/chunks from normal
    retrieval.
- non-authority proof:
  - recall bundles and rendered excerpts keep `currentTruthAuthority=false`,
    `completionProofAuthority=false`, `approvalAuthority=false`, `safetyAuthority=false`, and
    `unsafeToFollowAsInstruction=true`.
- known limitations:
  - retrieval remains review/evidence helper surface only until a later context-injection branch.
  - A5 still needs private/synthetic evidence proving enabled capture plus exact-quote retrieval and
    forget/delete behavior with redacted artifacts.
- next slice status: `unblocked` after A4 checkpoint commit.

## A5 - Private/Synthetic Live Smoke

- date: 2026-05-05
- branch: `feat/source-recall-encrypted-user-turn-capture`
- status: passed before checkpoint commit
- files inspected:
  - `docs/plans/SOURCE_RECALL_PRODUCTION_ROADMAP.md`
  - `docs/plans/source-recall-production-progress.md`
  - `scripts/evidence/sourceRecallEvidenceMatrix.ts`
  - `scripts/evidence/sourceRecallProductionUserTurnSmoke.ts`
  - `src/core/sourceRecall/sourceRecallRetriever.ts`
  - `src/interfaces/conversationManager.ts`
  - `tests/scripts/sourceRecallEvidenceMatrix.test.ts`
  - `tests/scripts/sourceRecallProductionUserTurnSmoke.test.ts`
- files changed:
  - `package.json`
  - `scripts/evidence/sourceRecallProductionUserTurnSmoke.ts`
  - `tests/scripts/sourceRecallProductionUserTurnSmoke.test.ts`
  - `docs/plans/source-recall-production-progress.md`
- tests added:
  - synthetic production user-turn smoke test proving encrypted storage, enabled live-user capture,
    exact-quote retrieval, forget/delete behavior, disabled assistant/task/media/document capture,
    no planner/chat Source Recall retrieval callsites, and redacted evidence output.
- tests run:
  - `npx tsx --test tests/scripts/sourceRecallProductionUserTurnSmoke.test.ts tests/scripts/sourceRecallEvidenceMatrix.test.ts tests/core/sourceRecallRetriever.test.ts tests/interfaces/sourceRecallConversationCapture.test.ts tests/core/sourceRecallStore.test.ts tests/core/sourceRecallRetention.test.ts`
  - `npm run test:source_recall:evidence`
  - `npm run test:source_recall:production_user_turn_smoke`
  - `npm run check:test-types`
  - `npm run check:no-unused-locals`
  - `npm run build`
  - `npm run check:docs`
- evidence produced:
  - `runtime/evidence/source_recall/source_recall_production_user_turn_smoke.json`
  - evidence mode: `synthetic_runtime_observed`
  - live dependency status: `NOT_REQUIRED`
  - artifact status: `PASS`
- sensitive scan status:
  - focused changed-file, generated-evidence, and staged-diff scans still required immediately
    before checkpoint commit.
- behavior changed:
  - added a CI-safe production user-turn smoke command for the enabled Source Recall path.
  - the smoke uses encrypted production storage, explicit capture/retrieval latches, an exact quote
    query, a forget/delete step, and redacted evidence.
  - the smoke proves the encrypted SQLite row does not contain captured source text.
- behavior intentionally not changed:
  - no assistant/task capture was enabled.
  - no media/document capture was enabled.
  - no planner/chat production retrieval or context injection was wired.
  - no semantic candidate promotion, Obsidian projection expansion, or operator-full projection was
    added.
- production defaults after slice:
  - Source Recall remains disabled unless explicitly enabled by config.
  - retrieval remains review/evidence-only and disabled by default.
  - generated smoke evidence is redacted and does not include raw captured text.
- known limitations:
  - the smoke is synthetic runtime-observed proof, not a Telegram live smoke.
  - later roadmap branches still need separately reviewed assistant/task capture, media/document
    capture, context injection, semantic candidate bridging, projection review, and the broader
    production evidence matrix.
- next slice status: `immediate-branch final validation unblocked`.

## B - Assistant And Task Summary Capture

- date: 2026-05-05
- branch: `feat/source-recall-assistant-task-capture`
- status: passed before checkpoint commit
- files inspected:
  - `docs/plans/SOURCE_RECALL_PRODUCTION_ROADMAP.md`
  - `docs/plans/source-recall-production-progress.md`
  - `src/core/sourceRecall/sourceRecallConversationCapture.ts`
  - `src/core/sourceRecall/sourceRecallRetention.ts`
  - `src/interfaces/conversationManager.ts`
  - `src/interfaces/conversationRuntime/conversationRouting.ts`
  - `src/interfaces/conversationRuntime/conversationRoutingAssistantTurnSupport.ts`
  - `src/interfaces/conversationRuntime/conversationRoutingDirectReplies.ts`
  - `src/interfaces/conversationRuntime/conversationRoutingInlineReplies.ts`
  - `src/interfaces/conversationRuntime/conversationWorkerOutcomePersistence.ts`
  - `src/interfaces/conversationRuntime/conversationWorkerRuntime.ts`
  - `src/interfaces/conversationRuntime/README.md`
  - `src/interfaces/conversationRuntime/followUpResolution.ts`
  - `src/interfaces/conversationSessionMutations.ts`
  - `tests/core/config.test.ts`
  - `tests/core/sourceRecallRetention.test.ts`
  - `tests/interfaces/conversationWorkerRuntime.test.ts`
  - `tests/interfaces/sourceRecallConversationCapture.test.ts`
- files changed:
  - `docs/plans/source-recall-production-progress.md`
  - `src/core/sourceRecall/sourceRecallRetention.ts`
  - `src/interfaces/conversationManager.ts`
  - `src/interfaces/conversationRuntime/conversationRouting.ts`
  - `src/interfaces/conversationRuntime/conversationRoutingAssistantTurnSupport.ts`
  - `src/interfaces/conversationRuntime/conversationRoutingDirectReplies.ts`
  - `src/interfaces/conversationRuntime/conversationRoutingInlineReplies.ts`
  - `src/interfaces/conversationRuntime/conversationWorkerOutcomePersistence.ts`
  - `src/interfaces/conversationRuntime/conversationWorkerRuntime.ts`
  - `src/interfaces/conversationRuntime/README.md`
  - `src/interfaces/conversationRuntime/followUpResolution.ts`
  - `src/interfaces/conversationRuntime/sourceRecallTaskCapture.ts`
  - `tests/core/config.test.ts`
  - `tests/core/sourceRecallRetention.test.ts`
  - `tests/interfaces/conversationWorkerRuntime.test.ts`
  - `tests/interfaces/sourceRecallConversationCapture.test.ts`
- tests added:
  - production allowlist coverage for explicit `conversation_turn`, `assistant_turn`,
    `task_input`, and `task_summary` capture.
  - manager-level assistant reply capture when `assistant_output` is explicitly allowed.
  - worker-level task input, task summary, and final assistant-summary capture as lower-authority
    evidence.
- tests run:
  - `npx tsx --test tests/core/sourceRecallRetention.test.ts tests/interfaces/sourceRecallConversationCapture.test.ts tests/interfaces/conversationWorkerRuntime.test.ts`
  - `npm run check:test-types`
  - `npm run check:no-unused-locals`
  - `npm run build`
  - `npm run check:docs`
  - `npm run check:module-size`
  - `npm test` found stale config/subsystem README expectations; targeted fixes were applied before
    final validation.
  - `npm test` final rerun passed with 3,352 tests, 0 failures, and 6 skipped.
- evidence produced:
  - focused tests only; no generated live-smoke artifact was created for this slice.
- sensitive scan status:
  - changed-file fixture phrase scan passed.
  - changed-file token-shaped secret scan passed.
  - staged-diff fixture phrase scan passed.
  - staged-diff token-shaped secret scan passed.
- behavior changed:
  - production capture allowlists can now explicitly permit assistant/task source kinds and
    `operational_output` while media/document/external capture remains outside this branch.
  - no-worker assistant replies now use `recordAssistantTurnWithSourceRecall`.
  - worker persistence captures persisted job input, generated task summary, and delivered final
    assistant summary as quoted evidence only when Source Recall capture is explicitly configured.
  - task capture uses persisted job input and result summary, not expanded execution prompts or
    planner/chat context.
- behavior intentionally not changed:
  - no media/document capture was enabled.
  - no planner/chat production retrieval, context injection, semantic candidate promotion,
    Obsidian projection expansion, operator-full projection, or broad evidence-matrix expansion was
    added.
  - recovered legacy summaries remain labeled as unavailable original source and do not invent
    source refs.
- non-authority proof:
  - assistant/task chunks keep `currentTruthAuthority=false`, `completionProofAuthority=false`,
    `approvalAuthority=false`, `safetyAuthority=false`, and `unsafeToFollowAsInstruction=true`.
- known limitations:
  - task summary and final assistant-summary capture currently reference the same generated text in
    separate source records so review can distinguish "workflow summary" from "assistant said this".
  - retrieval remains review/evidence helper surface only until a later context-injection branch.
- next slice status: `media/document capture remains blocked until this checkpoint is reviewed`.

## C - Media And Document Capture

- date: 2026-05-05
- branch: `feat/source-recall-media-document-capture`
- status: passed before checkpoint commit
- objective:
  - Capture Telegram media/document interpretation layers as Source Recall quoted evidence only
    when Source Recall capture is explicitly enabled and media/document source kinds plus
    `external_output` are explicitly allowlisted.
- owner files:
  - `src/core/sourceRecall/sourceRecallRetention.ts`
  - `src/core/sourceRecall/sourceRecallMediaCapture.ts`
  - `src/interfaces/transportRuntime/telegramConversationDispatch.ts`
  - `src/interfaces/telegramGateway.ts`
  - `src/interfaces/transportRuntime/README.md`
  - `tests/core/sourceRecallRetention.test.ts`
  - `tests/core/sourceRecallMediaCapture.test.ts`
  - `tests/interfaces/transportRuntime.test.ts`
  - `tests/core/config.test.ts`
- prohibited changes:
  - no planner/chat retrieval or context injection.
  - no semantic candidate promotion or profile-memory write authority.
  - no Obsidian projection expansion or operator-full projection.
  - no assistant/task capture changes outside regression fallout.
  - no broad evidence-matrix expansion.
- acceptance criteria:
  - production capture allowlists accept media/document source kinds only when explicitly listed.
  - media/document `external_output` remains rejected unless explicitly allowlisted and Source
    Recall encryption/capture latches are active.
  - Telegram media enrichment attaches Source Recall refs to interpretation layers only after the
    media artifact is owned by the runtime.
  - source records use the media artifact id as their parent ref when available so artifact
    redaction/forget flows can hide linked source chunks.
  - OCR/document/model-summary text remains outside command-routing text and cannot become route
    metadata, approval, profile truth, safety proof, or completion proof.
  - capture failure must not crash media handling and diagnostics must remain non-raw.
- required tests:
  - focused Source Recall retention tests.
  - media capture helper tests.
  - Telegram transport media enrichment tests.
  - config tests for explicit allowlist behavior.
- required commands:
  - `npx tsx --test tests/core/sourceRecallRetention.test.ts tests/core/config.test.ts tests/core/sourceRecallMediaCapture.test.ts tests/interfaces/transportRuntime.test.ts`
  - `npm run check:test-types`
  - `npm run check:no-unused-locals`
  - `npm run build`
  - `npm run check:docs`
  - `npm run check:module-size`
  - `npm test` before checkpoint commit when focused validation is green.
- sensitive scan requirements:
  - changed files, staged diff, generated evidence if any, and token-shaped patterns.
  - no real PDFs, local private paths, raw source chunks, provider tokens, or private fixture text
    may be added to docs/tests/evidence.
- files inspected:
  - `docs/plans/SOURCE_RECALL_PRODUCTION_ROADMAP.md`
  - `docs/plans/source-recall-production-progress.md`
  - `src/core/sourceRecall/sourceRecallRetention.ts`
  - `src/core/sourceRecall/sourceRecallMediaCapture.ts`
  - `src/core/sourceRecall/sourceRecallConversationCapture.ts`
  - `src/core/sourceRecall/sourceRecallStore.ts`
  - `src/core/mediaArtifactStore.ts`
  - `src/core/mediaArtifacts.ts`
  - `src/interfaces/mediaRuntime/contracts.ts`
  - `src/interfaces/transportRuntime/telegramConversationDispatch.ts`
  - `src/interfaces/telegramGateway.ts`
  - `src/interfaces/interfaceRuntime.ts`
  - `tests/core/sourceRecallRetention.test.ts`
  - `tests/core/sourceRecallMediaCapture.test.ts`
  - `tests/core/config.test.ts`
  - `tests/interfaces/transportRuntime.test.ts`
- files changed:
  - `docs/SETUP.md`
  - `docs/plans/source-recall-production-progress.md`
  - `src/core/sourceRecall/README.md`
  - `src/core/sourceRecall/sourceRecallRetention.ts`
  - `src/interfaces/telegramGateway.ts`
  - `src/interfaces/transportRuntime/README.md`
  - `src/interfaces/transportRuntime/telegramConversationDispatch.ts`
  - `tests/core/config.test.ts`
  - `tests/core/sourceRecallRetention.test.ts`
  - `tests/interfaces/transportRuntime.test.ts`
- tests added:
  - production allowlist coverage for explicit media/document source kinds and `external_output`.
  - Telegram media enrichment coverage proving an owned document artifact gets Source Recall refs,
    no document text enters command routing, source chunks remain non-authoritative, and artifact
    parent redaction hides linked chunks.
- tests run:
  - `npx tsx --test tests/core/sourceRecallRetention.test.ts tests/core/config.test.ts tests/core/sourceRecallMediaCapture.test.ts tests/interfaces/transportRuntime.test.ts`
  - `npm run check:test-types`
  - `npm run check:no-unused-locals`
  - `npm run build`
  - `npm run check:docs`
  - `npm run check:module-size`
  - `npm test` passed with 3,354 tests, 0 failures, and 7 skipped.
- evidence produced:
  - focused tests only; no generated live-smoke artifact was created for this slice.
- sensitive scan status:
  - changed-file and working-diff private fixture phrase scans passed.
  - changed-file and working-diff token-shaped secret scans passed.
- behavior changed:
  - production capture allowlists can now explicitly permit media/document source kinds and
    `external_output`.
  - Telegram media enrichment passes Source Recall capture dependencies through the gateway.
  - interpreted media/document layers receive Source Recall refs only when the media artifact has a
    runtime-owned artifact id and policy allows media/document capture.
  - captured media/document source records use the media artifact id as their parent ref, so
    artifact redaction/forget operations can hide linked source chunks.
- behavior intentionally not changed:
  - no planner/chat retrieval, context injection, semantic candidate promotion, profile-memory write
    authority, Obsidian projection expansion, operator-full projection, or broad evidence-matrix
    expansion was added.
  - media/document text still stays out of command-routing text.
- non-authority proof:
  - media/document chunks keep `currentTruthAuthority=false`, `completionProofAuthority=false`,
    `approvalAuthority=false`, `safetyAuthority=false`, and `unsafeToFollowAsInstruction=true`.
- known limitations:
  - persisted media artifact records are written before Source Recall refs are attached to the
    inbound media envelope; deletion linkage is preserved through Source Recall `originRef.parentRefId`.
  - retrieval remains review/evidence helper surface only until a later context-injection branch.
- next slice status: `context injection remains blocked until this checkpoint is reviewed`.

## D - Source Recall Context Injection

- date: 2026-05-05
- branch: `feat/source-recall-context-injection`
- status: passed before checkpoint commit
- objective:
  - Allow Source Recall to enter planner/model context only as quoted evidence when an explicit
    retrieval latch and route-approved memory intent both allow it.
- owner files:
  - `src/organs/memoryBroker.ts`
  - `src/organs/memoryBrokerPlannerInput.ts`
  - `src/organs/memoryContext/contracts.ts`
  - `src/organs/memoryContext/contextInjection.ts`
  - `src/core/buildBrain.ts`
  - `src/organs/memoryContext/README.md`
  - `src/organs/README.md`
  - `src/core/sourceRecall/README.md`
  - `tests/organs/sourceRecallContextInjection.test.ts`
  - `tests/organs/memoryBroker.test.ts`
  - `tests/core/buildBrain.test.ts`
- prohibited changes:
  - no Source Recall retrieval without `BRAIN_SOURCE_RECALL_RETRIEVAL_ENABLED`.
  - no automatic injection into every planner/direct-chat request.
  - no semantic candidate promotion, profile-memory write authority, approval, action, safety, or
    completion-proof authority from retrieved chunks.
  - no Obsidian projection expansion or operator-full projection.
  - no new capture surfaces.
- acceptance criteria:
  - Source Recall context injection is consumer-gated by route-approved memory intent.
  - retrieval is disabled by default and when the retrieval latch is off.
  - injected Source Recall carries retrieval mode, retrieval authority, freshness, source labels,
    bounded audit metadata, and `unsafeToFollowAsInstruction=true`.
  - route-looking, approval-looking, command-looking, and proof-looking text appears only as quoted
    evidence.
  - source-only context can be injected without pretending profile memory is current truth.
  - no production path retrieves Source Recall unless the explicit retrieval policy is allowed.
- required tests:
  - renderer/context packet tests.
  - memory broker integration tests for route-approved injection and fail-closed defaults.
  - build-brain/default config tests showing retrieval remains off by default.
- required commands:
  - `npx tsx --test tests/organs/sourceRecallContextInjection.test.ts tests/organs/memoryBroker.test.ts tests/core/buildBrain.test.ts tests/core/sourceRecallRetriever.test.ts`
  - `npm run check:test-types`
  - `npm run check:no-unused-locals`
  - `npm run build`
  - `npm run check:docs`
  - `npm run check:module-size`
  - `npm test` before checkpoint commit when focused validation is green.
- sensitive scan requirements:
  - changed files, staged diff, generated evidence if any, and token-shaped patterns.
  - no raw private source chunks, local private paths, provider tokens, or private fixture text may
    be added to docs/tests/evidence.
- files inspected:
  - `docs/plans/SOURCE_RECALL_PRODUCTION_ROADMAP.md`
  - `docs/plans/source-recall-production-progress.md`
  - `src/core/buildBrain.ts`
  - `src/core/sourceRecall/README.md`
  - `src/organs/README.md`
  - `src/organs/memoryBroker.ts`
  - `src/organs/memoryBrokerPlannerInput.ts`
  - `src/organs/memoryContext/README.md`
  - `src/organs/memoryContext/contextInjection.ts`
  - `src/organs/memoryContext/contracts.ts`
  - `scripts/evidence/sourceRecallProductionUserTurnSmoke.ts`
  - `tests/core/buildBrain.test.ts`
  - `tests/core/sourceRecallRetriever.test.ts`
  - `tests/organs/memoryBroker.test.ts`
  - `tests/organs/sourceRecallContextInjection.test.ts`
  - `tests/scripts/sourceRecallProductionUserTurnSmoke.test.ts`
- files changed:
  - `docs/SETUP.md`
  - `docs/plans/source-recall-production-progress.md`
  - `scripts/evidence/sourceRecallProductionUserTurnSmoke.ts`
  - `src/core/buildBrain.ts`
  - `src/core/sourceRecall/README.md`
  - `src/organs/README.md`
  - `src/organs/memoryBroker.ts`
  - `src/organs/memoryBrokerPlannerInput.ts`
  - `src/organs/memoryContext/README.md`
  - `src/organs/memoryContext/contextInjection.ts`
  - `src/organs/memoryContext/contracts.ts`
  - `tests/organs/memoryBroker.test.ts`
  - `tests/organs/sourceRecallContextInjection.test.ts`
  - `tests/scripts/sourceRecallProductionUserTurnSmoke.test.ts`
- tests added:
  - memory broker integration coverage for route-approved Source Recall injection with profile
    memory disabled.
  - memory broker fail-closed coverage proving retrieval latch and route memory intent are both
    required.
  - context packet coverage proving source-only recall remains quoted evidence and does not pretend
    profile memory is current truth.
  - updated production user-turn smoke coverage so the new route-gated broker callsite is allowed
    while unexpected planner/chat callsites still fail.
- tests run:
  - `npx tsx --test tests/organs/sourceRecallContextInjection.test.ts tests/organs/memoryBroker.test.ts tests/core/buildBrain.test.ts tests/core/sourceRecallRetriever.test.ts`
  - `npx tsx --test tests/scripts/sourceRecallProductionUserTurnSmoke.test.ts tests/organs/sourceRecallContextInjection.test.ts tests/organs/memoryBroker.test.ts tests/core/buildBrain.test.ts tests/core/sourceRecallRetriever.test.ts`
  - `npm run check:test-types`
  - `npm run check:no-unused-locals`
  - `npm run build`
  - `npm run check:docs`
  - `npm run check:module-size`
  - `npm test` (`3357` tests, `3352` pass, `0` fail, `5` skipped)
- evidence produced:
  - `runtime/evidence/source_recall/source_recall_production_user_turn_smoke.json`
  - evidence mode: `synthetic_runtime_observed`
  - artifact status: `PASS`
  - artifact remains redacted and contains no raw captured source text.
- sensitive scan status:
  - changed-file scan passed for prior private PDF needles, local private paths, provider-token
    shapes, GitHub token shapes, Slack token shapes, and Telegram token shapes.
  - generated Source Recall evidence scan passed for the same patterns plus the synthetic source
    quote needles.
  - staged-diff scan passed before checkpoint commit.
- behavior changed:
  - Source Recall retrieval can now enter the brokered planner packet only when the retrieval policy
    allows it, the request has route-approved memory intent, and domain-boundary policy allows memory
    context injection.
  - retrieved Source Recall is rendered with source labels, retrieval mode, retrieval authority,
    freshness/authority flags, bounded audit metadata, and `unsafeToFollowAsInstruction=true`.
  - source-only recall packets are possible when profile memory is disabled, but they are labeled as
    Source Recall context and do not become profile-current truth.
  - the Source Recall production user-turn smoke now recognizes the memory broker as the only
    route-gated planner/chat retrieval callsite and still fails on unexpected callsites.
- behavior intentionally not changed:
  - no Source Recall retrieval occurs when `BRAIN_SOURCE_RECALL_RETRIEVAL_ENABLED` is disabled.
  - no automatic injection into every planner/direct-chat request was added.
  - no semantic candidate promotion, profile-memory write authority, approval, action, safety, or
    completion-proof authority was added from retrieved chunks.
  - no Obsidian projection expansion, operator-full projection, or new capture surface was added.
- known limitations:
  - retrieval is still bounded to route-approved recall-style memory intents and conversation-scoped
    Source Recall records.
  - Source Recall retrieval audit is currently represented by the retrieval bundle/audit event and
    rendered context metadata; broader access-audit integration remains a later roadmap concern.
- next slice status: `semantic candidate bridge remains blocked until this checkpoint is reviewed`.

## E - Source Recall To Semantic Candidate Bridge

- date: 2026-05-05
- branch: `feat/source-recall-semantic-candidate-bridge`
- status: passed before checkpoint commit
- objective:
  - Let Source Recall source refs support semantic memory candidates as provenance while preserving
    the rule that truth governance decides any durable memory promotion.
- owner files:
  - `src/core/sourceRecall/sourceRecallMemoryBridge.ts`
  - `src/core/sourceRecall/README.md`
  - `src/core/profileMemoryRuntime/contracts.ts`
  - `src/core/profileMemoryRuntime/profileMemorySemanticRelationshipCandidates.ts`
  - `src/core/profileMemoryRuntime/README.md`
  - `src/interfaces/conversationRuntime/conversationProfileMemoryWrite.ts`
  - `tests/core/sourceRecallMemoryBridge.test.ts`
  - `tests/core/profileMemoryWriteAuthorityGates.test.ts`
  - `tests/interfaces/conversationProfileMemoryWrite.test.ts`
- prohibited changes:
  - no Source Recall text may become a semantic candidate by itself.
  - no source ref may grant profile-memory write authority, current truth, approval, action,
    safety, or completion-proof authority.
  - no new Source Recall retrieval, context injection, projection, or capture surface.
  - no broad relationship phrase packs or lexical expansion.
- acceptance criteria:
  - semantic relationship candidates can carry normalized Source Recall refs as provenance.
  - candidate refs are copied into the profile-memory provenance seam as source refs only.
  - candidates with only Source Recall refs but without valid semantic evidence are rejected.
  - missing route-approved memory write policy still blocks durable profile-memory writes.
  - mutation envelopes may cite Source Recall refs without treating them as truth, approval, action,
    safety, or completion proof.
- required tests:
  - source recall memory bridge tests for candidate-ref normalization and non-authority flags.
  - profile-memory authority-gate tests proving refs do not bypass route-approved ingest policy.
  - conversation profile-memory write tests proving candidate refs enter provenance only.
- required commands:
  - `npx tsx --test tests/core/sourceRecallMemoryBridge.test.ts tests/core/profileMemoryWriteAuthorityGates.test.ts tests/interfaces/conversationProfileMemoryWrite.test.ts`
  - `npm run check:test-types`
  - `npm run check:no-unused-locals`
  - `npm run build`
  - `npm run check:docs`
  - `npm run check:module-size`
  - `npm test` before checkpoint commit when focused validation is green.
- sensitive scan requirements:
  - changed files, staged diff, generated evidence if any, and token-shaped patterns.
  - no raw private source chunks, local private paths, provider tokens, or private fixture text may
    be added to docs/tests/evidence.
- files inspected:
  - `docs/plans/SOURCE_RECALL_PRODUCTION_ROADMAP.md`
  - `docs/plans/source-recall-production-progress.md`
  - `src/core/profileMemoryRuntime/README.md`
  - `src/core/profileMemoryRuntime/contracts.ts`
  - `src/core/profileMemoryRuntime/profileMemorySemanticRelationshipCandidates.ts`
  - `src/core/profileMemoryRuntime/profileMemoryTruthGovernance.ts`
  - `src/core/profileMemoryRuntime/profileMemoryTruthGovernanceSources.ts`
  - `src/core/sourceRecall/README.md`
  - `src/core/sourceRecall/contracts.ts`
  - `src/core/sourceRecall/sourceRecallMemoryBridge.ts`
  - `src/interfaces/conversationRuntime/conversationProfileMemoryWrite.ts`
  - `tests/core/profileMemoryWriteAuthorityGates.test.ts`
  - `tests/core/sourceRecallMemoryBridge.test.ts`
  - `tests/interfaces/conversationProfileMemoryWrite.test.ts`
- files changed:
  - `docs/plans/source-recall-production-progress.md`
  - `src/core/profileMemoryRuntime/README.md`
  - `src/core/profileMemoryRuntime/contracts.ts`
  - `src/core/profileMemoryRuntime/profileMemorySemanticRelationshipCandidates.ts`
  - `src/core/sourceRecall/README.md`
  - `src/core/sourceRecall/sourceRecallMemoryBridge.ts`
  - `src/interfaces/conversationRuntime/conversationProfileMemoryWrite.ts`
  - `tests/core/profileMemoryWriteAuthorityGates.test.ts`
  - `tests/core/sourceRecallMemoryBridge.test.ts`
  - `tests/interfaces/conversationProfileMemoryWrite.test.ts`
- tests added:
  - Source Recall bridge tests proving source refs can support semantic relationship candidates only
    as provenance and cannot make invalid candidates usable.
  - profile-memory authority-gate coverage proving source refs do not bypass route-approved memory
    write policy.
  - conversation profile-memory request coverage proving semantic candidate refs are copied into
    provenance only, with all authority flags false.
- tests run:
  - `npx tsx --test tests/core/sourceRecallMemoryBridge.test.ts tests/core/profileMemoryWriteAuthorityGates.test.ts tests/interfaces/conversationProfileMemoryWrite.test.ts`
  - `npm run check:test-types`
  - `npm run check:no-unused-locals`
  - `npm run build`
  - `npm run check:docs`
  - `npm run check:module-size`
  - `npm test` (`3360` tests, `3353` pass, `0` fail, `7` skipped)
- evidence produced:
  - no new evidence artifact was required for this slice.
- sensitive scan status:
  - changed-file scan passed for prior private PDF needles, local private paths, provider-token
    shapes, GitHub token shapes, Slack token shapes, and Telegram token shapes.
  - no new generated Source Recall evidence artifact was produced by this slice.
  - staged-diff scan passed before checkpoint commit.
- behavior changed:
  - semantic relationship candidate inputs and validated relationship metadata can now carry
    normalized Source Recall refs.
  - Source Recall bridge helpers can attach refs to semantic candidates and collect deduped refs
    from validated fact candidates.
  - conversation profile-memory write requests copy candidate source refs into bounded provenance
    so mutation envelopes can cite them as source evidence.
- behavior intentionally not changed:
  - Source Recall refs do not create semantic candidates without typed semantic/review evidence.
  - Source Recall refs do not authorize profile-memory writes or semantic lesson commits.
  - Source Recall refs do not become current truth, approval authority, action authority, safety
    authority, or completion-proof authority.
  - no retrieval, capture, context-injection, projection, lexical expansion, or Obsidian behavior was
    added.
- known limitations:
  - candidate refs currently flow through relationship semantic candidates and request provenance;
    broader episode/source-ref attribution remains a later bridge concern if needed.
- next slice status: `projection and review remains blocked until this checkpoint is reviewed`.

## F - Source Recall Projection And Review

- date: 2026-05-05
- branch: `feat/source-recall-projection-review`
- status: passed before checkpoint commit
- objective:
  - Show Source Recall safely in Obsidian/JSON projection and review flows while preserving the
    rule that projection is review evidence only.
- owner files:
  - `src/core/buildBrain.ts`
  - `src/core/sourceRecall/sourceRecallProjection.ts`
  - `src/core/sourceRecall/sourceRecallStore.ts`
  - `src/core/sourceRecall/README.md`
  - `src/core/projections/README.md`
  - `src/core/projections/contracts.ts`
  - `src/core/projections/renderers/obsidianDashboardRenderer.ts`
  - `src/core/projections/renderers/obsidianSourceRecallRenderer.ts`
  - `src/core/projections/targets/obsidianVaultSink.ts`
  - `src/core/projections/reviewActionIngestion.ts`
  - `tests/core/buildBrain.test.ts`
  - `tests/core/sourceRecallProjection.test.ts`
  - `tests/core/sourceRecallStore.test.ts`
  - `tests/core/obsidianVaultSink.test.ts`
  - `tests/core/projectionReviewActions.test.ts`
- prohibited changes:
  - no new Source Recall capture surface.
  - no new planner/chat retrieval or context injection.
  - no semantic-candidate promotion changes.
  - no operator-full Source Recall projection without the explicit Source Recall operator-full
    projection latch.
  - no projection output may be captured back as ordinary Source Recall input.
  - no source ref may grant memory-write, approval, action, safety, or completion-proof authority.
- acceptance criteria:
  - projection snapshots include Source Recall entries only when Source Recall projection policy
    allows them.
  - review-safe Obsidian projection renders metadata and bounded/redacted quoted excerpts only.
  - JSON mirror entries carry non-authority flags and the explicit `quoted_evidence_only` recall
    authority.
  - Source Recall store mutations can emit bounded `source_recall_changed` projection changes
    without raw source text in reasons or metadata.
  - Obsidian review-action ingestion skips Source Recall projection notes that lack a valid review
    action schema.
  - `abb_source_recall_refs` remain provenance links only and cannot authorize review actions by
    themselves.
- required tests:
  - Source Recall projection read-model tests for metadata, latch, lifecycle, and authority flags.
  - Obsidian sink tests for Source Recall notes, dashboard counts, and review-only rendering.
  - build-brain JSON mirror test proving runtime snapshot wiring uses the projection latch.
  - Source Recall store change-set tests proving bounded `source_recall_changed` notifications.
  - review-action ingestion tests proving source-ref-only notes are skipped.
- required commands:
  - `npx tsx --test tests/core/sourceRecallProjection.test.ts tests/core/sourceRecallStore.test.ts tests/core/obsidianVaultSink.test.ts tests/core/projectionReviewActions.test.ts tests/core/buildBrain.test.ts`
  - `npm run check:test-types`
  - `npm run check:no-unused-locals`
  - `npm run build`
  - `npm run check:docs`
  - `npm run check:module-size`
  - `npm test` before checkpoint commit when focused validation is green.
- sensitive scan requirements:
  - changed files, staged diff, generated evidence if any, and token-shaped patterns.
  - no raw private source chunks, local private paths, provider tokens, or private fixture text may
    be added to docs/tests/evidence.
- files inspected:
  - `docs/plans/SOURCE_RECALL_PRODUCTION_ROADMAP.md`
  - `docs/plans/source-recall-production-progress.md`
  - `src/core/buildBrain.ts`
  - `src/core/projections/README.md`
  - `src/core/projections/contracts.ts`
  - `src/core/projections/renderers/obsidianDashboardRenderer.ts`
  - `src/core/projections/renderers/obsidianFrontmatter.ts`
  - `src/core/projections/targets/obsidianVaultSink.ts`
  - `src/core/projections/reviewActionIngestion.ts`
  - `src/core/sourceRecall/README.md`
  - `src/core/sourceRecall/contracts.ts`
  - `src/core/sourceRecall/sourceRecallProjection.ts`
  - `src/core/sourceRecall/sourceRecallRetention.ts`
  - `src/core/sourceRecall/sourceRecallStore.ts`
  - `tests/core/buildBrain.test.ts`
  - `tests/core/obsidianVaultSink.test.ts`
  - `tests/core/projectionReviewActions.test.ts`
  - `tests/core/projectionService.test.ts`
  - `tests/core/projectionTestSupport.ts`
  - `tests/core/sourceRecallProjection.test.ts`
  - `tests/core/sourceRecallReceipts.test.ts`
  - `tests/core/sourceRecallStore.test.ts`
- files changed:
  - `docs/plans/source-recall-production-progress.md`
  - `src/core/buildBrain.ts`
  - `src/core/projections/README.md`
  - `src/core/projections/renderers/obsidianDashboardRenderer.ts`
  - `src/core/projections/renderers/obsidianSourceRecallRenderer.ts`
  - `src/core/projections/targets/obsidianVaultSink.ts`
  - `src/core/sourceRecall/README.md`
  - `src/core/sourceRecall/sourceRecallProjection.ts`
  - `src/core/sourceRecall/sourceRecallStore.ts`
  - `tests/core/buildBrain.test.ts`
  - `tests/core/obsidianVaultSink.test.ts`
  - `tests/core/projectionReviewActions.test.ts`
  - `tests/core/sourceRecallProjection.test.ts`
  - `tests/core/sourceRecallStore.test.ts`
- tests added:
  - Source Recall projection read-model assertions for non-authority flags and projection-only
    notices.
  - Source Recall store change-set coverage proving mutation notifications are bounded and omit raw
    source text.
  - build-brain JSON mirror coverage proving Source Recall enters snapshots only through the
    projection latch.
  - Obsidian sink coverage proving Source Recall notes render as quoted review evidence with
    dashboard counts.
  - review-action ingestion coverage proving source-ref-only projection notes are skipped.
- tests run:
  - `npx tsx --test tests/core/sourceRecallProjection.test.ts tests/core/sourceRecallStore.test.ts tests/core/obsidianVaultSink.test.ts tests/core/projectionReviewActions.test.ts tests/core/buildBrain.test.ts`
  - `npm run check:test-types`
  - `npm run check:no-unused-locals`
  - `npm run build`
  - `npm run check:docs`
  - `npm run check:module-size`
  - `npm test` (`3364` tests, `3358` pass, `0` fail, `6` skipped)
  - `npm run check:ai-first`
- evidence produced:
  - no new slice-specific evidence artifact was required.
  - full `npm test` refreshed existing runtime evidence artifacts; generated-evidence sensitive
    scan passed.
- sensitive scan status:
  - changed-file scan passed for prior private PDF needles, local private paths, provider-token
    shapes, GitHub token shapes, Slack token shapes, and Telegram token shapes.
  - generated-evidence scan passed for the same patterns across Source Recall evidence and the
    Stage 6.5 live-check artifact.
  - staged-diff scan passed before checkpoint commit.
- behavior changed:
  - Source Recall store mutations can publish bounded `source_recall_changed` projection changes.
  - projection snapshots now include Source Recall projection entries only when Source Recall
    projection policy allows the current mode.
  - Obsidian projection now includes a `23 Source Recall` review mirror collection and dashboard
    count.
  - JSON mirror snapshots carry Source Recall projection entries with non-authority flags.
  - review-action guide and ingestion make Source Recall refs provenance-only and skip source-ref-only
    notes without valid action schema.
- behavior intentionally not changed:
  - no new Source Recall capture surface was added.
  - no new planner/chat retrieval, context injection, semantic-candidate promotion, approval,
    action, safety, completion-proof, or memory-write authority was added.
  - operator-full Source Recall projection still requires the separate Source Recall operator-full
    projection latch.
  - Source Recall projection output remains projection metadata and is not captured as ordinary
    Source Recall input.
- known limitations:
  - Source Recall projection is limited to snapshot/Obsidian/JSON review surfaces; broader evidence
    matrix proof remains a later roadmap slice.
- next slice status: `production evidence matrix remains blocked until this checkpoint is reviewed`.

## G - Source Recall Production Evidence Matrix

- date: 2026-05-05
- branch: `test/source-recall-production-evidence-matrix`
- status: passed before checkpoint commit
- objective:
  - Prove production Source Recall works and remains non-authoritative across recall quality,
    authority safety, privacy/delete, projection, and production-status evidence.
- owner files:
  - `docs/plans/source-recall-production-progress.md`
  - `scripts/evidence/sourceRecallEvidenceMatrix.ts`
  - `tests/fixtures/sourceRecallMatrixScenarios.json`
  - `tests/scripts/sourceRecallEvidenceMatrix.test.ts`
- prohibited changes:
  - no new Source Recall capture, retrieval, projection, memory, planner, or interface runtime
    behavior.
  - no raw private source text, local paths, provider tokens, or token-shaped values in generated
    artifacts.
  - no expected-result copying into observed result fields.
  - no mocked proof may be labeled as live proof.
  - no evidence scenario may claim authority from Source Recall chunks, refs, projections, or recall
    bundles.
- acceptance criteria:
  - matrix uses encrypted production Source Recall storage, not the test-only plaintext latch.
  - evidence distinguishes `synthetic_runtime_observed` proof and `NOT_REQUIRED` live dependency
    status.
  - matrix proves exact quote, scope/thread, temporal, relationship-source, assistant/task, and
    media/document recall quality for already-landed source kinds.
  - matrix proves retrieved source cannot authorize memory writes, semantic lesson commits,
    semantic candidate promotion, actions, approvals, route metadata, safety, completion proof, or
    browser/process/file proof.
  - prompt-injection proof covers completion-proof, approval-command, route-metadata, and
    browser/process/file-proof spoofing as quoted evidence only.
  - delete proof shows forgotten records are absent from retrieval, projection, and visible index
    refs.
  - projection proof shows review-safe redaction and operator-full latch behavior.
  - top-level status proof distinguishes disabled, enabled, missing-encryption blocked, and
    policy-blocked production states.
  - artifact privacy proof shows no raw seed source text, local desktop path, or token-shaped secret
    is written to the generated matrix artifact.
- required tests:
  - Source Recall matrix script tests for scenario pass/fail behavior and non-authority fields.
  - retriever/index/projection tests for lower-level boundaries the matrix asserts.
- required commands:
  - `npx tsx --test tests/scripts/sourceRecallEvidenceMatrix.test.ts tests/core/sourceRecallRetriever.test.ts tests/core/sourceRecallIndex.test.ts tests/core/sourceRecallProjection.test.ts`
  - `npm run test:source_recall:evidence`
  - `npm run check:test-types`
  - `npm run check:no-unused-locals`
  - `npm run build`
  - `npm run check:docs`
  - `npm run check:module-size`
  - `npm test` before checkpoint commit when focused validation is green.
- sensitive scan requirements:
  - changed files, staged diff, and generated matrix artifact.
  - scan for prior private PDF needles, local private paths, provider-token shapes, GitHub token
    shapes, Slack token shapes, Telegram token shapes, and raw synthetic seed source text in
    generated artifacts.
- files inspected:
  - `docs/plans/SOURCE_RECALL_PRODUCTION_ROADMAP.md`
  - `docs/plans/source-recall-production-progress.md`
  - `package.json`
  - `scripts/evidence/sourceRecallEvidenceMatrix.ts`
  - `scripts/evidence/sourceRecallProductionUserTurnSmoke.ts`
  - `src/core/sourceRecall/sourceRecallIndex.ts`
  - `src/core/sourceRecall/sourceRecallMemoryBridge.ts`
  - `src/core/sourceRecall/sourceRecallProjection.ts`
  - `src/core/sourceRecall/sourceRecallRetriever.ts`
  - `src/organs/memoryContext/contextInjection.ts`
  - `tests/fixtures/sourceRecallMatrixScenarios.json`
  - `tests/scripts/sourceRecallEvidenceMatrix.test.ts`
- files changed:
  - `docs/plans/source-recall-production-progress.md`
  - `scripts/evidence/sourceRecallEvidenceMatrix.ts`
  - `tests/fixtures/sourceRecallMatrixScenarios.json`
  - `tests/scripts/sourceRecallEvidenceMatrix.test.ts`
- tests added:
  - matrix coverage for encrypted production-store proof and production status states.
  - matrix scenarios for scope/thread, assistant/task, media/document, and projection review
    boundaries.
  - authority assertions for action, approval, route metadata, browser/process/file proof, memory
    write, semantic lesson commit, and semantic candidate promotion.
  - prompt-injection proof for completion-proof, approval-command, route-metadata, and
    browser/process/file-proof spoofing.
  - regression coverage proving wrong expected retrieval values fail instead of being copied into
    observed fields.
- tests run:
  - `npx tsx --test tests/scripts/sourceRecallEvidenceMatrix.test.ts tests/core/sourceRecallRetriever.test.ts tests/core/sourceRecallIndex.test.ts tests/core/sourceRecallProjection.test.ts`
  - `npm run test:source_recall:evidence`
  - `npm run check:test-types`
  - `npm run check:no-unused-locals`
  - `npm run build`
  - `npm run check:docs`
  - `npm run check:module-size`
  - `npm run check:ai-first`
  - `npm test` (`3365` tests, `3358` pass, `0` fail, `7` skipped)
- evidence produced:
  - `runtime/evidence/source_recall/source_recall_evidence_matrix.json`
  - evidence mode: `synthetic_runtime_observed`
  - live dependency status: `NOT_REQUIRED`
  - summary: `12` total, `12` passed, `0` failed
  - top-level status: `PASS`
- sensitive scan status:
  - changed-file scan passed for prior private PDF needles, local private paths, provider-token
    shapes, GitHub token shapes, Slack token shapes, and Telegram token shapes.
  - generated-evidence scan passed for the same patterns plus raw synthetic seed source text needles.
  - staged-diff scan passed before checkpoint commit.
- behavior changed:
  - Source Recall evidence matrix now uses encrypted production storage instead of the test-only
    plaintext latch.
  - matrix results expose observed retrieval mode, expected retrieval mode, retrieval authority, and
    runtime-observed proof source.
  - matrix artifact records production status, storage encryption, artifact privacy, projection,
    delete/index, and expanded authority-safety proofs.
- behavior intentionally not changed:
  - no Source Recall runtime capture, retrieval, projection, planner/chat injection, semantic
    promotion, memory-write, approval, action, safety, or completion-proof behavior changed.
  - no live dependency is required for this matrix; live/private Telegram evidence remains separate.
  - raw source excerpts are not written to the matrix artifact.
- known limitations:
  - evidence is synthetic runtime-observed, not live Telegram/desktop proof.
  - later docs contract cleanup remains the final roadmap branch.
- next slice status: `docs/source-recall-production-contract remains blocked until this checkpoint is reviewed`.

## H - Source Recall Production Contract Docs

- date: 2026-05-05
- branch: `docs/source-recall-production-contract`
- status: passed before checkpoint commit
- objective:
  - Document the production Source Recall contract for public readers, operators, and maintainers
    without changing runtime behavior.
- owner files:
  - `README.md`
  - `CHANGELOG.md`
  - `docs/SOURCE_RECALL.md`
  - `docs/README.md`
  - `docs/SETUP.md`
  - `docs/ARCHITECTURE.md`
  - `docs/ARCHITECTURE_OVERVIEW.md`
  - `docs/CONCEPTS.md`
  - `docs/plans/SOURCE_RECALL_PRODUCTION_ROADMAP.md`
  - `docs/plans/source-recall-production-progress.md`
  - `src/core/sourceRecall/README.md`
- prohibited changes:
  - no runtime behavior changes.
  - no new capture, retrieval, projection, memory-write, semantic-promotion, planner/chat,
    approval, action, safety, or completion-proof authority.
  - no raw private source text, local private paths, provider tokens, or token-shaped values in
    docs.
- acceptance criteria:
  - docs explain Source Recall as quoted evidence only.
  - docs name encrypted production storage, explicit latches, capture allowlists, retrieval
    budgets, projection policy, delete lifecycle, and evidence expectations.
  - docs distinguish Source Recall from profile memory, semantic memory, approvals, receipts,
    projection, and completion proof.
  - docs keep the invariant: source chunks can be read, but cannot be obeyed.
  - focused docs validation and sensitive scans pass before checkpoint commit.
- required tests:
  - docs/reference checks only; this slice changes no runtime behavior.
- required commands:
  - `npm run check:docs`
  - `npm run check:ai-first`
  - `npm run check:module-size`
  - `npm run build`
  - focused sensitive scan for changed docs and staged diff.
- sensitive scan requirements:
  - changed docs and staged diff.
  - scan for prior private PDF needles, local private paths, provider-token shapes, GitHub token
    shapes, Slack token shapes, Telegram token shapes, and raw source text.
- files inspected:
  - `README.md`
  - `CHANGELOG.md`
  - `docs/README.md`
  - `docs/SETUP.md`
  - `docs/ARCHITECTURE.md`
  - `docs/ARCHITECTURE_OVERVIEW.md`
  - `docs/CONCEPTS.md`
  - `docs/plans/SOURCE_RECALL_PRODUCTION_ROADMAP.md`
  - `docs/plans/source-recall-production-progress.md`
  - `.env.example`
  - `src/core/sourceRecall/README.md`
  - `src/core/sourceRecall/contracts.ts`
  - `src/core/sourceRecall/sourceRecallConversationCapture.ts`
  - `src/core/sourceRecall/sourceRecallMediaCapture.ts`
  - `src/core/sourceRecall/sourceRecallMemoryBridge.ts`
  - `src/core/sourceRecall/sourceRecallProjection.ts`
  - `src/core/sourceRecall/sourceRecallRetention.ts`
  - `src/core/sourceRecall/sourceRecallRetriever.ts`
  - `src/core/sourceRecall/sourceRecallStore.ts`
  - `src/organs/memoryContext/contextInjection.ts`
- files changed:
  - `README.md`
  - `CHANGELOG.md`
  - `docs/SOURCE_RECALL.md`
  - `docs/README.md`
  - `docs/SETUP.md`
  - `docs/ARCHITECTURE.md`
  - `docs/ARCHITECTURE_OVERVIEW.md`
  - `docs/CONCEPTS.md`
  - `docs/plans/SOURCE_RECALL_PRODUCTION_ROADMAP.md`
  - `docs/plans/source-recall-production-progress.md`
  - `src/core/sourceRecall/README.md`
- tests added:
  - no tests added; this is a docs-only contract slice.
- tests run:
  - `npm run check:docs`
  - `npm run check:ai-first`
  - `npm run check:module-size`
  - `npm run build`
  - `npm run test:source_recall:evidence` (`12` total, `12` passed, `0` failed)
  - `npm test` (`3365` tests, `3358` pass, `0` fail, `7` skipped)
- evidence produced:
  - refreshed `runtime/evidence/source_recall/source_recall_evidence_matrix.json`
  - full `npm test` refreshed existing runtime evidence artifacts.
- sensitive scan status:
  - changed-file scan passed for prior private PDF needles, local private paths, provider-token
    shapes, GitHub token shapes, Slack token shapes, and Telegram token shapes.
  - generated-evidence scan passed for the same patterns plus raw synthetic seed source text
    needles across Source Recall evidence and the Stage 6.5 live-check artifact.
  - staged-diff scan passed before checkpoint commit.
- behavior changed:
  - added `docs/SOURCE_RECALL.md` as the operator-facing production Source Recall contract.
  - linked Source Recall docs from README, docs index, setup, architecture, concepts, and subsystem
    README.
  - roadmap now includes the H docs work packet and current checkpoint status.
- behavior intentionally not changed:
  - no runtime behavior changed.
  - no new Source Recall capture, retrieval, projection, planner/chat context injection, semantic
    promotion, memory-write, approval, action, safety, or completion-proof authority changed.
- known limitations:
  - this slice documents the production contract; it does not add new runtime capabilities.
- next slice status: `roadmap complete locally after scans and checkpoint commit`.

## I - Source Recall Telegram/Desktop Live Proof

- date: 2026-05-05
- branch: `docs/source-recall-production-contract`
- status: passed before checkpoint commit
- objective:
  - Prove the production Source Recall stack in the live Telegram/Desktop workflow with explicit
    live confirmation, encrypted storage, real browser open/close, Desktop cleanup, exact-quote
    retrieval, and redacted evidence.
- owner files:
  - `scripts/evidence/telegramDesktopWorkflowAndCleanupLiveSmoke.ts`
  - `scripts/evidence/sourceRecallTelegramDesktopLiveSmoke.ts`
  - `tests/scripts/sourceRecallTelegramDesktopLiveSmoke.test.ts`
  - `package.json`
  - `docs/SOURCE_RECALL.md`
  - `CHANGELOG.md`
  - `docs/plans/SOURCE_RECALL_PRODUCTION_ROADMAP.md`
  - `docs/plans/source-recall-production-progress.md`
- prohibited changes:
  - no automatic Source Recall enablement outside the explicit live-smoke latches.
  - no raw live Telegram text, Desktop path, provider token, or raw source chunk in committed docs,
    tests, progress, or evidence.
  - no Source Recall authority expansion for memory truth, approval, action, safety, or completion
    proof.
  - no media/document capture enablement in the live proof wrapper.
- acceptance criteria:
  - live run requires `BRAIN_TELEGRAM_HUMAN_LIVE_SMOKE_CONFIRM=true`.
  - live wrapper provides an encrypted production Source Recall store and explicit capture/retrieval
    latches only for the smoke process.
  - live artifact proves browser open, browser close, and Desktop cleanup.
  - live artifact proves exact-quote retrieval from encrypted Source Recall without raw quote/path
    leakage.
  - live artifact proves Source Recall excerpts remain quoted evidence only and non-authoritative.
  - full `npm test` remains green after the live harness changes.
- files inspected:
  - `scripts/evidence/telegramDesktopWorkflowAndCleanupLiveSmoke.ts`
  - `scripts/evidence/sourceRecallProductionUserTurnSmoke.ts`
  - `scripts/evidence/sourceRecallEvidenceMatrix.ts`
  - `tests/scripts/telegramDesktopWorkflowAndCleanupLiveSmoke.test.ts`
  - `tests/scripts/sourceRecallProductionUserTurnSmoke.test.ts`
  - `docs/SOURCE_RECALL.md`
  - `CHANGELOG.md`
  - `package.json`
- files changed:
  - `CHANGELOG.md`
  - `docs/SOURCE_RECALL.md`
  - `docs/plans/SOURCE_RECALL_PRODUCTION_ROADMAP.md`
  - `docs/plans/source-recall-production-progress.md`
  - `package.json`
  - `scripts/evidence/sourceRecallTelegramDesktopLiveSmoke.ts`
  - `scripts/evidence/telegramDesktopWorkflowAndCleanupLiveSmoke.ts`
  - `tests/scripts/sourceRecallTelegramDesktopLiveSmoke.test.ts`
- tests added:
  - confirmation-gated Source Recall Telegram/Desktop live smoke test that validates the redacted
    artifact shape, encrypted production storage, exact-quote retrieval, browser lifecycle proof,
    Desktop cleanup proof, and non-authority flags.
- tests run:
  - `npx tsx --test tests/scripts/sourceRecallTelegramDesktopLiveSmoke.test.ts tests/scripts/telegramDesktopWorkflowAndCleanupLiveSmoke.test.ts tests/scripts/sourceRecallEvidenceMatrix.test.ts`
  - `npm run check:ai-first`
  - `npm run build`
  - `npm run test:source_recall:evidence`
  - `$env:BRAIN_TELEGRAM_HUMAN_LIVE_SMOKE_CONFIRM='true'; npm run test:source_recall:telegram_desktop_live_smoke`
  - `npm test`
- evidence produced:
  - `runtime/evidence/source_recall/source_recall_telegram_desktop_live_smoke.json`
  - evidence mode: `live_telegram_desktop_observed`
  - live dependency status: `LIVE_SMOKE`
  - top-level status: `PASS`
  - source recall proof: encrypted production store, plaintext storage disallowed, exact quote
    retrieved, raw row does not contain the target quote, and non-authority flags are false/quoted
    as expected.
  - desktop proof: browser opened, browser closed, and target Desktop folder cleanup completed.
- sensitive scan status:
  - changed-file scan passed for prior private PDF needles, local private paths, provider-token
    shapes, GitHub token shapes, Slack token shapes, and Telegram token shapes.
  - generated-evidence scan passed for the same patterns plus raw synthetic/live source needles
    across Source Recall evidence and the Stage 6.5 live-check artifact.
  - staged-diff scan passed before checkpoint commit.
- behavior changed:
  - the Telegram/Desktop live smoke can optionally receive Source Recall capture dependencies from
    the shared runtime when explicit live-smoke Source Recall latches are set.
  - added a dedicated Source Recall Telegram/Desktop live proof command that creates temporary
    encrypted storage, runs the real live workflow, retrieves exact quoted evidence, writes a
    redacted artifact, and deletes temporary storage.
- behavior intentionally not changed:
  - normal interface runtime defaults remain disabled unless Source Recall latches are configured.
  - no planner/chat path gains Source Recall authority from the live proof.
  - no media/document Source Recall capture is enabled by the live proof wrapper.
  - the live artifact is runtime evidence and is not intended to be tracked.
- known limitations:
  - this live proof depends on Telegram/Desktop/browser live dependencies and remains
    confirmation-gated.
  - the artifact records ids, counts, hashes, and non-authority flags instead of raw live source
    text by design.
- next slice status: `push branch for PR/CI review after final scans and checkpoint commit`.
