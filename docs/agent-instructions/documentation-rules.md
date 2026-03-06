# Documentation Rules

1. Every source file in `src/` must begin with a `@fileoverview` JSDoc comment describing the
   module's responsibility.
2. Every function, method, and constructor in `src/` must include a JSDoc block following the
   codebase pattern:

```typescript
/**
 * [One-line summary of what the function does.]
 *
 * **Why it exists:**
 * [Design rationale - why this function needs to exist as a separate unit.]
 *
 * **What it talks to:**
 * - Uses `DependencyName` (import `DependencyName`) from `./module`.
 * - [or] Uses local constants/helpers within this module.
 *
 * @param paramName - [Description of the parameter's role.]
 * @returns [Description of the return value.]
 */
```

3. The `Why it exists` block must explain the design reason, not restate what the code does.
4. The `What it talks to` block must list all imported dependencies used by the function, with import
   paths. Use "Uses local constants/helpers within this module" when the function only uses
   module-local definitions.
5. Tests must have clear naming and minimal intent comments only when behavior is non-obvious.
6. Update `README.md` and `docs/ARCHITECTURE.md` for externally observable behavior changes.
7. `README.md` and `docs/ARCHITECTURE.md` are polished product or architecture references, not
   changelogs.
8. Do not write branch-status notes, implementation diaries, "now does X" rollout phrasing, or
   patch-by-patch history into `README.md` or `docs/ARCHITECTURE.md`.
9. Put change history, rollout notes, and active status in plan docs, evidence artifacts, PR
   descriptions, or other explicitly operational documents instead.
