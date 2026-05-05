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
