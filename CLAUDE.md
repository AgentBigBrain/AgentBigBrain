# AgentBigBrain — Instructions for Claude

## Project Overview

AgentBigBrain is a governance-first TypeScript runtime for autonomous AI agents. Every action follows the loop: **Plan → Constrain → Govern → Execute → Receipt → Reflect**.

Key architecture facts for contributors:

- **Governance has two paths:** fast-path actions are evaluated by the security governor only; escalation-path actions go to the full 7-governor council (ethics, logic, resource, security, continuity, utility, compliance) with supermajority voting. A separate code-review governor runs as a preflight gate for `create_skill` actions only.
- **Hard constraints run before governance** — deterministic, non-LLM safety checks that cannot be bypassed.
- **Execution receipts are appended after execution** — each approved action produces a tamper-evident receipt with output and vote digests, hash-chained to the prior receipt.
- **Clones are not sub-agents** — they are governed satellite identities with role overlays, spawn limits, and merge governance. They do not get independent orchestrator instances.
- **2 runtime dependencies** (`ws`, `onnxruntime-node`). Everything else uses Node.js built-ins.

## Getting Started

```bash
npm install
npm run build
npm test
npm run check:docs
npm run dev -- "summarize current repo status"
```

## Architecture Boundaries

1. Keep shared domain shapes in `src/core/types.ts`.
2. Keep orchestration decisions in `src/core/orchestrator.ts` and per-action loop logic in `src/core/taskRunner.ts`.
3. Keep deterministic hard constraints in `src/core/hardConstraints.ts`.
4. Keep execution-mode routing decisions in `src/core/executionMode.ts`.
5. Keep deterministic cost enforcement in `src/core/actionCostPolicy.ts`.
6. Keep model provider calls in `src/models/` behind `ModelClient`.
7. Keep governors single-lens, deterministic-first, and decoupled from executor details.
8. Keep interface ingress routed through orchestrator-governed execution flow.
9. Keep user-facing truth/overclaim policy centralized in `src/interfaces/userFacingResult.ts`.

## Deterministic Safety Rules

1. **Zero-Trust AI:** Treat all model output as untrusted and validate at the model boundary.
2. Preserve fail-closed behavior for planner, governance, and constraints.
3. Preserve protected-path and identity/privacy communication guards.
4. Preserve local-first persistence and immutable control-plane protections.

## User Experience and Capability Principles

1. **Do not ban live-run workflows; model them properly.**
   - Do not solve `npm start`, dev servers, previews, or similar live-run tasks by broadly shutting them off.
   - Prefer properly governed capability expansion: managed-process lifecycle, readiness checks, browser verification, bounded cleanup, and truthful completion criteria.
   - Avoid one-off special cases when the real issue is a missing runtime abstraction.
2. **Keep user-facing communication human-first.**
   - Normal user replies should explain what happened in plain language before exposing technical details.
   - Lead with practical meaning and next steps, not internal telemetry or raw reason codes.
   - Preserve typed codes for debug and audit surfaces, but do not make users parse them in normal conversation.
3. **Maximize helpfulness without overclaiming.**
   - If something failed or was blocked, say what happened, why it happened, and what the user can do next.
   - Prefer solution-oriented wording over terse failure statements.
   - Never claim a side effect happened unless it was actually approved and executed.
4. **Favor natural, supportive responses over robotic phrasing.**
   - Responses should feel clear, direct, and conversational rather than mechanical.
   - Avoid unnecessary jargon when a simpler explanation will do.
   - Keep the tone grounded and practical; helpfulness should come from clarity and actionable guidance.
5. **Aim for accessible middle-ground language.**
   - As a communication guardrail, aim roughly around a **1300-1400L lexicon level** when writing normal user-facing responses.
   - Assume users can range from high-school level to graduate-level technical ability.
   - Do not speak over people, but do not flatten the explanation so much that it becomes vague or patronizing.
   - Prefer common words first, explain specialized terms when they matter, and keep enough precision that a technical reader still learns something useful.
   - Optimize for understanding: the user should leave knowing what happened, why it mattered, and what they can do next.
6. **Use determinism for guarantees, not as a blanket restriction on learning.**
   - Keep deterministic behavior strict where the runtime makes hard promises: security boundaries, truthfulness, governance decisions, receipts, typed outcomes, and auditability.
   - Do not overextend determinism into every problem-solving path if that would prevent the system from learning, adapting, retrying, or discovering a safe workaround.
   - Within approved safety envelopes, prefer bounded experimentation, iterative verification, and strategy adaptation over premature shutdown.
   - When a workflow is inherently dynamic or live (for example dev servers, previews, browser checks, or environment-specific troubleshooting), the answer is usually better modeling and better verification, not less capability.
   - The goal is a brain that stays safe and truthful while still learning how to get unstuck.

## Operational Gates

1. **Determinism gate:** Do not add nondeterministic sources (`Date.now()`, `Math.random()`, unstable iteration order) without injected boundaries and tests proving determinism at the contract layer. For runtime time/random boundaries, route through `src/core/runtimeEntropy.ts`.
2. **Resource lifecycle gate:** Use `using` / `await using` for resources implementing `Symbol.dispose` / `Symbol.asyncDispose` (e.g., SQLite `DatabaseSync` and file handles). Otherwise use deterministic `try/finally` teardown with explicit `release()` where available.
3. **ActionType change gate:** If you add or change `ActionType` or action params, you must update, at minimum:
   - `src/core/types.ts` (shape contracts)
   - `src/core/hardConstraints.ts` (typed deterministic blocks)
   - `src/core/executionMode.ts` (fast vs escalation routing)
   - `src/core/actionCostPolicy.ts` (deterministic cost model)
   - `src/organs/executor.ts` (handlers)
   - `src/interfaces/userFacingResult.ts` (truthfulness/overclaim rendering)
   - runtime-path tests for the full loop (planner -> constraints -> vote -> execute -> receipts)
4. **Schema contract gate:** For structured schema changes (`src/models/schemaValidation.ts` and provider contracts), update provider-side contracts and local validation together; add malformed-shape fail-closed tests.
5. **Canonicalization gate:** Any hashing/fingerprinting/idempotency key must use canonical JSON with declared ordering rules:
   - object keys sorted lexicographically at every nesting level
   - arrays are ordered only if schema-declared ordered; unordered arrays require a centralized stable sort-key declaration
   - missing or conflicting canonicalization rules must fail closed with a typed code
6. **Schema envelope gate:** New persistent artifacts must be wrapped in `SchemaEnvelopeV1` and carry deterministic fingerprints derived from canonical JSON.
7. **Receipt-chain integrity gate:** Do not introduce parallel receipt chains for new receipt types. Extend the existing `ExecutionReceiptStore` chain when adding receipt payloads (e.g., memory mutation receipts).
8. **SQLite parity gate:** For runtime ledgers with `json|sqlite` backends, preserve deterministic bootstrap/parity/export behavior and refresh `npm run audit:ledgers` evidence when relevant.
9. **User-facing truth gate:** Never emit success language for side effects unless a matching action was approved and executed (simulated execution must be labeled as simulated).
10. **Sensitive egress gate:** Never log or emit secrets/personal data; update redaction tests when adding fields that can contain sensitive values.
11. **Typed outcomes gate:** Use stable typed error/block codes for new constraint/governance/runtime-limit outcomes; do not rely on free-text parsing.
12. **No new background loops gate:** No new always-on schedulers/daemons or "background state changes" without:
    - explicit enable latch
    - deterministic suppression rules (mission/job priority)
    - runtime-path evidence
13. **Module size gate:** Trigger decomposition when modules exceed ~800 lines or mix multiple concerns; extract focused helpers with no behavior drift and tests.

## Documentation Rules

1. Every source file in `src/` must begin with a `@fileoverview` JSDoc comment describing the module's responsibility.
2. Every function, method, and constructor in `src/` must include a JSDoc block following the codebase pattern:

   ```typescript
   /**
    * [One-line summary of what the function does.]
    *
    * **Why it exists:**
    * [Design rationale — why this function needs to exist as a separate unit.]
    *
    * **What it talks to:**
    * - Uses `DependencyName` (import `DependencyName`) from `./module`.
    * - [or] Uses local constants/helpers within this module.
    *
    * @param paramName - [Description of the parameter's role.]
    * @returns [Description of the return value.]
    */
   ```

3. The `**Why it exists:**` block must explain the design reason, not restate what the code does. For example: "Keeps construction of bounds decision consistent across call sites" or "Fails fast when clone queue request is invalid so later control flow stays safe and predictable."
4. The `**What it talks to:**` block must list all imported dependencies used by the function, with import paths. Use "Uses local constants/helpers within this module" when the function only uses module-local definitions.
5. Tests must have clear naming and minimal intent comments only when behavior is non-obvious.
6. Update `README.md` and `docs/ARCHITECTURE.md` for externally observable behavior changes.

## Testing Rules

1. Add tests for new core/governance/model-routing/interface behavior.
2. Place all test files under `tests/` (never under `src/`). Mirror the `src/` directory structure:
   - `src/core/` → `tests/core/`
   - `src/governors/` → `tests/governors/`
   - `src/organs/` → `tests/organs/`
   - `src/models/` → `tests/models/`
   - `src/interfaces/` → `tests/interfaces/`
   - `src/tools/` → `tests/tools/`
3. Run `npm run build`.
4. Run `npm test`.
5. Run `npm run check:docs`.
6. Use mocks only for external dependencies; do not replace core control flow with mocks.
7. **CRITICAL:** NEVER claim unexecuted tests pass, and NEVER generate unverifiable evidence.

## Integrity Rules

1. Claim only behaviors that were executed and observed in this workspace/session.
2. For every behavior claim, include evidence references: command(s) run, pass/fail status, and artifact/test path.
3. Label evidence state explicitly as `VERIFIED`, `PARTIALLY VERIFIED`, or `UNVERIFIED`; never present `UNVERIFIED` as complete.
4. If any required validation command fails, do not claim completion; report failure and remaining gap.
5. Never fabricate command output, benchmark values, logs, or test outcomes.
6. If environment limits prevent verification, state the exact blocker and the specific commands/artifacts still pending.

## Definition of Done

1. Code compiles (`npm run build`).
2. Tests pass (`npm test`).
3. Function documentation checks pass (`npm run check:docs`).
4. PR description explains what changed and why.
