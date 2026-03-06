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
