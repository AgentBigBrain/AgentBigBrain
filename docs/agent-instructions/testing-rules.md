# Testing Rules

1. Add tests for new core, governance, model-routing, or interface behavior.
2. Place all test files under `tests/` and mirror the `src/` directory structure:
   - `src/core/` -> `tests/core/`
   - `src/governors/` -> `tests/governors/`
   - `src/organs/` -> `tests/organs/`
   - `src/models/` -> `tests/models/`
   - `src/interfaces/` -> `tests/interfaces/`
   - `src/tools/` -> `tests/tools/`
3. Run `npm run build`.
4. Run `npm test`.
5. Run `npm run check:docs`.
6. Use mocks only for external dependencies; do not replace core control flow with mocks.
7. Never claim unexecuted tests pass, and never generate unverifiable evidence.
8. For conversation-routing, conversational interpretation, workflow continuity, or identity-path
   changes, add transcript-shaped tests that cover mixed personal and workflow turns instead of
   only isolated unit phrases.
9. When a behavior depends on live runtime sequencing or transport timing, extend the relevant
   smoke or evidence scenario as well; do not assume unit coverage alone is enough.
10. For workflow, scaffold, shell, path, filesystem, process, or browser changes, prove the logic
    is not accidentally Windows-only.
   - Add or update tests that cover Windows-style and POSIX-style paths when path handling matters.
   - When host OS and target OS can differ, cover that mismatch explicitly instead of relying only
     on the local development machine.
   - Do not mark a workflow as done if it only passes on one OS because generic runtime code leaked
     platform assumptions.
