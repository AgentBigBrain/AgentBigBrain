# Architecture Boundaries

1. Keep shared domain shapes in `src/core/types.ts`.
2. Keep orchestration decisions in `src/core/orchestrator.ts` and per-action loop logic in
   `src/core/taskRunner.ts`.
3. Keep deterministic hard constraints in `src/core/hardConstraints.ts`.
4. Keep execution-mode routing decisions in `src/core/executionMode.ts`.
5. Keep deterministic cost enforcement in `src/core/actionCostPolicy.ts`.
6. Keep model provider calls in `src/models/` behind `ModelClient`.
7. Keep governors single-lens, deterministic-first, and decoupled from executor details.
8. Keep interface ingress routed through orchestrator-governed execution flow.
9. Keep user-facing truth or overclaim policy centralized in `src/interfaces/userFacingResult.ts`.
10. Treat cross-platform execution as a core runtime boundary, not a later polish step.
   - New workflow, scaffold, shell, browser, filesystem, or live-run logic should work on Windows,
     macOS, and Linux unless a platform limit is explicitly unavoidable.
   - Keep platform-specific shims narrow and isolated behind shared helpers or adapters; do not let
     Windows-only path, shell, or process assumptions leak through generic runtime code.
   - When a workflow is intentionally platform-limited, make that constraint explicit in the owning
     contract, README, and user-facing behavior instead of silently assuming Windows.
