# Regex And Intent Boundaries

1. Treat regex as a narrow utility layer, not the primary meaning engine.
   - Regex, parsers, and exact token matching are appropriate for strict commands, bounded
     validation, exact identifiers, paths, URLs, dates, email addresses, file extensions, and
     similar rigid structures.
   - Regex may also support fail-closed safety checks where false positives or false negatives have
     clear bounded consequences and the pattern is intentionally exact.
   - Exact token matching is only acceptable when it is serving a rigid machine contract. It is
     not an excuse to rebuild semantic routing through token packs, phrase lists, or token-sequence
     detectors under a different name.
2. Do not use regex as the main router for semantic user intent.
   - Do not decide chat vs workflow, answer-thread continuation vs stale workflow continuity,
     relationship recall vs identity follow-up, or saved-work resume vs new work mainly through
     phrase packs or broad lexical heuristics.
   - If a bug depends on paraphrase, recent assistant turns, mixed continuity, or ambiguity in what
     the user means, the preferred fix is stronger typed intent or bounded model interpretation,
     not more regex.
   - Token sets, keyword packs, and token-sequence helpers that decide semantic route are still
     lexical routing. Replacing `/pattern/` with `Set<string>` or hand-authored token arrays does
     not solve the architectural problem by itself.
   - The model should decide whether the user means things like `review feedback`,
     `build-format ambiguity`, `fresh build request`, `status recall`, or `chat follow-up`. It
     should not be reduced to checking whether the message "matches" internal helper names or
     lexical tables.
3. Keep the control split explicit.
   - The model should decide what the user most likely means and which route best matches that
     meaning.
   - Deterministic policy should decide what is allowed, what must be clarified, and what proof or
     ownership is required before side effects.
   - Understanding must not silently become permission.
4. Prefer typed route contracts over growing lexical trees.
   - Introduce explicit route families such as `chat_answer`, `relationship_recall`,
     `status_recall`, `static_html_build`, `framework_app_build`, `resume_work`, or
     `clarify_build_format` instead of encoding those concepts through overlapping phrase rules.
   - Route selection should stay inspectable through typed mode outputs, not hidden across many
     narrow lexical helpers.
   - The objective is to smooth the front-door surface, so small wording changes do not constantly
     break execution behavior. If a route only works because of a fragile lexical tree, that route
     is not stable enough yet.
5. Clarification should resolve ambiguity, not lexical indecision.
   - When the system can see multiple plausible routes with materially different execution behavior,
     it should ask a short clarification instead of guessing.
   - The need for clarification is deterministic state. The exact wording of the clarification does
     not need to be deterministic.
6. Keep regex where it is strongest.
   - Explicit commands such as `/help`, `/memory`, or exact control phrases with one stable
     contract.
   - Rigid extraction such as `ABC-1234`, `file:///...`, `C:\...`, or `2026-04-18`.
   - Validation of structured payloads, machine-authored envelopes, and exact governance markers.
   - High-precision safety boundaries such as protected paths, exact resource ownership markers, or
     disallowed broad process-name shutdown commands.
7. Avoid regex-shaped understanding in memory and continuity when the meaning is fuzzy.
   - Broad real-life relationships, identity nuance, and long-form narrative updates should prefer
     bounded structured extraction, typed memory families, or model-assisted interpretation over
     giant phrase packs.
   - Regex extraction is acceptable when the phrasing is intentionally narrow and the stored fact
     family is clearly defined.
8. Changes should reduce regex authority over time.
   - When touching a front-door routing bug, first ask whether the current regex should be removed,
     narrowed, or replaced with typed intent/context.
   - New regex added for a semantic bug must justify why a stricter parser or stronger typed intent
     signal is not the better fix.
   - New token-sequence or keyword heuristics added for a semantic bug carry the same burden of
     proof. Do not bypass this rule by changing the implementation shape while keeping the same
     lexical ownership of meaning.
