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
