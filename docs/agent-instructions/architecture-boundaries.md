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
