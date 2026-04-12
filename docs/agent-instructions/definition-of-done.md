# Definition Of Done

1. Code compiles with `npm run build`.
2. Tests pass with `npm test`.
3. Function documentation checks pass with `npm run check:docs`.
4. If the change touches version numbers, release metadata, or changelog release sections,
   `npm run check:versioning` passes.
5. If the change affects externally observable behavior, setup, compatibility guidance, operator
   recovery behavior, or release notes, `CHANGELOG.md` `[Unreleased]` is updated in the same change.
6. The PR description explains what changed and why.
7. For plan-phase completion claims, include grep evidence that the phase's key symbols exist in
   the target files listed by the plan. Paste the raw grep command and output. If no key symbols
   from the plan appear in the target files, the phase is not done regardless of build/test status.
8. For plan-phase completion claims, include the raw `git diff --stat` output showing which files
   were modified. If zero target files show changes, the phase is not done.
9. Plan status may only be changed to `Completed` by `benac` or reviewer after independent verification.
   Agents may mark individual phases as `Done` but must not change overall plan status beyond
   `In progress`.
