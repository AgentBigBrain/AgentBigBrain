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
10. Folder-level `README.md` files under `src/` are part of the code contract, not optional prose.
11. Use the standard folder README structure: `## Responsibility`, `## Inputs`, `## Outputs`,
    `## Invariants`, `## Related Tests`, and `## When to Update This README`.
12. Apply that structure to older source folders as well as newly extracted subsystems when the
    folder owns a meaningful runtime or tooling boundary.
13. If a code change alters a folder's responsibility, public entrypoints, invariants, required
    tests, or related modules, update that folder's `README.md` in the same change.
14. If a folder-level `README.md` exists, do not leave it stale. Either update it to match the code
    or remove it if the folder no longer needs a dedicated subsystem contract document.
15. If a folder has become a real change surface and still has no README contract, add one instead
    of relying on unwritten conventions.
16. Folder-level `README.md` files under `src/` must not contain absolute local filesystem paths or
    personal workspace links. Use inline code identifiers or repo-relative references instead.
