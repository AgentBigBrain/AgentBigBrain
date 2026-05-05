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
