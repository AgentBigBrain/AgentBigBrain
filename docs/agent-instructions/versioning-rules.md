# Versioning Rules

1. Treat `package.json` as the single source of truth for the current release version.
2. Treat `CHANGELOG.md` as release history, not as the source of the active version number.
3. Keep unreleased work under `CHANGELOG.md` in the `[Unreleased]` section until a real release is
   being cut.
4. Treat `CHANGELOG.md` as a maintained operator-facing summary, not a release-day backlog dump.
   - Update `[Unreleased]` in the same change when work affects user-visible behavior, interface
     flow, setup steps, compatibility guidance, operational recovery behavior, or anything a human
     reviewer would reasonably call out in release notes.
   - Do not add internal-only refactors, test-only cleanup, or file-by-file implementation diary
     bullets when they do not change what operators, users, or maintainers need to know.
5. Do not bump the version number for ordinary feature work, bug fixes, refactors, or doc edits
   unless the task is explicitly a release or version-bump task.
6. When a release or version-bump task is in scope, follow `VERSIONING.md` for the bump policy
   (`patch`, `minor`, `major`) instead of guessing from commit type alone.
7. Use these trigger rules:
   - Update `package.json` only when the task is explicitly to cut a release or bump the version.
   - Update `CHANGELOG.md` `[Unreleased]` when work changes externally observable behavior, setup,
     compatibility guidance, or release-relevant operator behavior.
   - If the change is externally observable and the agent decides not to touch `CHANGELOG.md`, it
     must explain why that omission is correct instead of silently skipping it.
   - Update `VERSIONING.md` only when version policy, bump criteria, source-of-truth rules, checks,
     or release workflow change.
   - Do not update `VERSIONING.md` just because a normal feature or fix shipped.
   - Do not auto-bump a version number just because a commit uses `feat`, `fix`, or `refactor`.
8. If the task is not explicitly a release task, keep version-impact analysis in notes or PR text
   instead of changing `package.json`.
9. When cutting a release:
   - update `package.json`
   - create the matching released section in `CHANGELOG.md`
   - keep the latest released changelog heading aligned with `package.json`
10. Keep `[Unreleased]` in the standard Keep a Changelog shape:
    - `### Added`
    - `### Changed`
    - `### Fixed`
    - `### Security`
11. If a change touches release metadata, changelog release headings, or version numbers, run:

```bash
npm run check:versioning
```

12. If you need a quick answer for the current version, use:

```bash
npm run version:current
```

13. If versioning rules or release workflow change, update `VERSIONING.md` in the same change.
14. If an agent cannot tell whether a change is breaking for operators, it should not bump the
    version automatically. It should flag the release impact clearly and ask for confirmation during
    a release task.
