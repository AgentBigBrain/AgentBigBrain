# AI-First Maintainability

1. Treat this repository as AI-first: a low-context agent should be able to discover the correct
   edit surface, contract, and validation path without guessing.
2. Before changing a behavior, check the nearest folder `README.md` under `src/`, then the active
   plan or contract docs that define the change surface, especially
   `docs/plans/AI_FIRST_MAINTAINABILITY_PLAN.md` when the work is structural.
3. Thin entrypoints such as `src/core/agentLoop.ts`, `src/organs/executor.ts`,
   `src/organs/planner.ts`, `src/governors/defaultGovernors.ts`, and
   `src/interfaces/userFacingResult.ts` should stay stable; prefer editing the canonical modules
   behind them.
4. If a folder owns a real subsystem boundary, its `README.md` is part of the code contract and
   should explain responsibility, inputs, outputs, invariants, related tests, and when to update
   the README.
5. Add or split a docs module in `docs/agent-instructions/` when one instruction topic becomes a
   separate stable concern, when a single file starts mixing unrelated rules, or when an agent
   would otherwise need to infer workflow from scattered notes.
6. Reduce guessing by making ownership explicit. If a code or docs change introduces a new
   canonical edit path, update the nearest folder `README.md` and the shared agent instructions
   when contributors would otherwise need to infer the rule.
7. Prefer explicit machine-checkable structure over prose-only guidance. If a convention matters
   repeatedly, enforce it with tooling or a sync check instead of relying on memory.
