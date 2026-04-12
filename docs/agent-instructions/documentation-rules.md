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
10. `CHANGELOG.md` is the canonical repo-level change history.
    - Update `[Unreleased]` when a change alters user-visible behavior, setup, compatibility,
      operator guidance, or recovery behavior that belongs in release notes.
    - Keep entries concise, grouped under `### Added`, `### Changed`, `### Fixed`, or
      `### Security`, and written in terms a maintainer or operator would care about.
    - Do not dump internal refactor inventories or file-by-file implementation notes into the
      changelog.
11. Folder-level `README.md` files under `src/` are part of the code contract, not optional prose.
12. Use the standard folder README structure: `## Responsibility`, `## Inputs`, `## Outputs`,
    `## Invariants`, `## Related Tests`, and `## When to Update This README`.
13. Apply that structure to older source folders as well as newly extracted subsystems when the
    folder owns a meaningful runtime or tooling boundary.
14. If a code change alters a folder's responsibility, public entrypoints, invariants, required
    tests, or related modules, update that folder's `README.md` in the same change.
15. If a folder-level `README.md` exists, do not leave it stale. Either update it to match the code
    or remove it if the folder no longer needs a dedicated subsystem contract document.
16. If a folder has become a real change surface and still has no README contract, add one instead
    of relying on unwritten conventions.
17. Folder-level `README.md` files under `src/` must not contain absolute local filesystem paths or
    personal workspace links. Use inline code identifiers or repo-relative references instead.
18. Every implementation plan created under `docs/plans/` must include a top-level section titled
    `## Plan Status`.
19. `## Plan Status` must state the current overall status plainly, for example: `Not started`,
    `In progress`, `Blocked`, or `Done`.
20. Every implementation plan created under `docs/plans/` must include a section titled
    `## When another agent picks this up:`.
21. That section must say what is already done, what is next, what not to restart, and what files
    or README contracts the next agent should read first.
22. Every implementation plan created under `docs/plans/` must end with a final section titled
    `## Last Worked On`.
23. `## Last Worked On` must be updated whenever the plan changes and must include:
    - current phase or focus
    - what changed last
    - what still feels clunky, blocked, or unfinished
    - the next clean seam to continue from
    - the latest validation or evidence state, if any
24. If a plan is actively being executed, keep `## Plan Status`, `## When another agent picks this
    up:`, and `## Last Worked On` updated in the same change as phase/status updates so handoff
    does not depend on guesswork.
25. In public-facing docs such as `README.md`, `docs/SETUP.md`, `docs/COMMAND_EXAMPLES.md`, and
    `docs/ERROR_CODE_ENV_MAP.md`, prefer clear plain-English wording over internal jargon.
26. Technical terms are allowed when they improve accuracy, but do not let them become a barrier
    to understanding. If you use terms like `bounded`, `provenance`, `semantic`, or other internal
    shorthand, either make the meaning obvious from context or explain it right away in simpler
    language.
