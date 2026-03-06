# Operational Gates

1. Determinism gate: do not add nondeterministic sources (`Date.now()`, `Math.random()`, unstable
   iteration order) without injected boundaries and tests proving determinism at the contract layer.
   For runtime time or random boundaries, route through `src/core/runtimeEntropy.ts`.
2. Resource lifecycle gate: use `using` or `await using` for resources implementing
   `Symbol.dispose` or `Symbol.asyncDispose` (for example SQLite `DatabaseSync` and file handles).
   Otherwise use deterministic `try/finally` teardown with explicit `release()` where available.
3. ActionType change gate: if you add or change `ActionType` or action params, update at minimum:
   - `src/core/types.ts`
   - `src/core/hardConstraints.ts`
   - `src/core/executionMode.ts`
   - `src/core/actionCostPolicy.ts`
   - `src/organs/executor.ts`
   - `src/interfaces/userFacingResult.ts`
   - runtime-path tests for the full loop
4. Schema contract gate: for structured schema changes (`src/models/schemaValidation.ts` and provider
   contracts), update provider-side contracts and local validation together; add malformed-shape
   fail-closed tests.
5. Canonicalization gate: any hashing, fingerprinting, or idempotency key must use canonical JSON
   with declared ordering rules:
   - object keys sorted lexicographically at every nesting level
   - arrays ordered only if schema-declared ordered; unordered arrays require a centralized stable
     sort-key declaration
   - missing or conflicting canonicalization rules must fail closed with a typed code
6. Schema envelope gate: new persistent artifacts must be wrapped in `SchemaEnvelopeV1` and carry
   deterministic fingerprints derived from canonical JSON.
7. Receipt-chain integrity gate: do not introduce parallel receipt chains for new receipt types.
   Extend the existing `ExecutionReceiptStore` chain when adding receipt payloads.
8. SQLite parity gate: for runtime ledgers with `json|sqlite` backends, preserve deterministic
   bootstrap, parity, and export behavior and refresh `npm run audit:ledgers` evidence when relevant.
9. User-facing truth gate: never emit success language for side effects unless a matching action was
   approved and executed. Simulated execution must be labeled as simulated.
10. Sensitive egress gate: never log or emit secrets or personal data. Update redaction tests when
    adding fields that can contain sensitive values.
11. Typed outcomes gate: use stable typed error or block codes for new
    constraint/governance/runtime-limit outcomes. Do not rely on free-text parsing.
12. No new background loops gate: no new always-on schedulers, daemons, or background state changes
    without:
    - explicit enable latch
    - deterministic suppression rules
    - runtime-path evidence
13. Module size gate: trigger decomposition when modules exceed about 800 lines or mix multiple
    concerns. Extract focused helpers with no behavior drift and tests.
