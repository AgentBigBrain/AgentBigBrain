# Commit Rules

1. Use Conventional Commit style for every commit header:
   - `type(scope): imperative summary`
2. Preferred commit types:
   - `feat` for new user-facing capability or new externally observable behavior
   - `fix` for bug fixes or regression fixes
   - `refactor` for behavior-preserving structural cleanup
   - `docs` for documentation-only changes
   - `test` for test-only changes
   - `chore` for repo maintenance, script cleanup, dependency/admin work, or non-product tooling work
3. Prefer the most honest type. Do not use `feat` for pure refactors, and do not use `refactor` if the change intentionally alters product behavior.
4. Use a concrete scope when it helps:
   - examples: `core`, `interfaces`, `models`, `organs`, `runtime`, `docs`, `repo`
5. Keep the header short and descriptive. Use imperative mood and avoid filler like "update stuff" or "misc cleanup".
6. Use a body for any non-trivial commit. Prefer short bullet points describing the highest-signal changes.
7. Commit bodies should explain:
   - the main structural or behavioral changes
   - important compatibility or stability notes
   - validation that was actually run
8. Only mention tests or validation commands that were actually executed successfully.
9. If a change is intentionally behavior-preserving, say that plainly in the body instead of making reviewers infer it.
10. If the work spans many files but one real theme, use one honest commit with a clear body instead of a vague summary.
11. If the work contains multiple unrelated themes, split it into multiple commits rather than hiding unrelated work under one broad header.
12. When the user asks only for staging or a proposed commit message, do not create the commit.
