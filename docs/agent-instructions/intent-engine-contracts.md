# Intent Engine Contracts

1. The intent engine owns semantic route selection, not safety authorization.
   - Its job is to decide what the user most likely means and which bounded route best matches the
     request.
   - It must not by itself authorize risky actions, destructive actions, cross-workspace access,
     or broad recovery behavior.
   - The long-term direction is to reduce semantic dependence on lexical helpers. The intent engine
     should move route choice toward model-led classification with bounded context, while
     deterministic logic remains responsible for safety and state.
   - The model should classify semantic intent such as `review_feedback`, `build_request`,
     `build_format_ambiguous`, `status_recall`, or `chat_follow_up`. It should not be treated as a
     scorer over internal lexical tables like token-sequence lists, excluded-verb sets, or keyword
     packs.
2. Route outputs must stay typed and inspectable.
   - Prefer explicit route families such as:
     - `chat_answer`
     - `relationship_recall`
     - `status_recall`
     - `capability_discovery`
     - `static_html_build`
     - `framework_app_build`
     - `resume_work`
     - `clarify_build_format`
     - `clarify_execution_mode`
   - Route ids should describe execution shape, not just wording cues.
   - Route results should carry a typed metadata payload, not only a route id. The payload should
     include execution mode, continuation kind, memory intent, runtime-control intent, explicit
     constraints, and optional build-format metadata.
   - Build routes should carry explicit build-format metadata, such as static single-file output,
     framework app output, or ambiguous format requiring clarification. That metadata can select
     relevant Markdown instruction skills, but it should not trigger hidden deterministic content
     generation.
   - Memory routes should carry explicit memory intent. Relationship, contextual, profile-update,
     and document-derived memory surfaces must not expand from lexical cues alone.
3. Deterministic preprocessing should remain narrow.
   - Before intent resolution, deterministic logic may still detect:
     - explicit slash commands
     - exact machine-readable payloads
     - strict safety or ownership markers
     - exact clarification answers
     - exact structured tokens such as paths, URLs, dates, or identifiers
   - Deterministic preprocessing should not become a second semantic router.
   - Token-sequence detectors, keyword packs, and lexical scoring helpers count as semantic routing
     when they choose routes by meaning. They should be treated with the same skepticism as regex
     when they begin owning route selection.
   - Internal helpers such as review-feedback phrase lists, excluded-verb sets, or build-format
     token packs may exist as bounded fallback hints or diagnostics, but they must not become the
     primary route chooser.
4. The intent engine should prefer clarification over silent guessing when route choice materially
   changes execution behavior.
   - Examples:
     - plain HTML vs framework app
     - explanation only vs execution now
     - review saved work vs resume saved work
   - If multiple routes are plausible and lead to different side effects, the runtime should ask a
     clarification instead of choosing one silently.
   - Clarification is the preferred smoothing mechanism for ambiguous surfaces. It is better to ask
     a short natural question than to keep adding brittle lexical rules so the runtime can pretend
     the ambiguity does not exist.
5. Clarification contracts must be structured.
   - A clarification should carry:
     - `kind`
     - `reason`
     - `valid options`
     - optional `default` only when a safe default is truly policy-approved
   - The model may phrase the clarification naturally, but the stored clarification state must stay
     machine-readable and deterministic.
   - The clarification contract should guide the model, not script exact wording. Deterministic
     state should provide the options and reason; the model should render the question naturally.
   - Once clarification is active, deterministic logic may resolve the user's answer against the
     stored options. Before clarification is active, semantic route choice should come from the
     model's understanding, not from lexical option-proxy heuristics.
6. Low confidence should degrade gracefully.
   - If the model cannot pick one route confidently and no clarification-safe contract exists, the
     runtime should fail closed to a bounded conversational reply rather than drifting into hidden
     execution.
   - Low confidence must not silently promote the turn into autonomy.
7. Post-intent enforcement remains deterministic.
   - After route selection, deterministic policy must still enforce:
     - execution constraints such as `do not open` or `do not run`
     - exact path ownership
     - exact browser/process ownership
     - governor and hard-constraint rules
     - required proof or verification steps
   - The model chooses the route; the runtime chooses whether the route may execute.
8. Memory and continuity are support inputs, not route owners.
   - Profile memory, continuity, and knowledge-graph state may improve context and recall.
   - They must not destabilize route selection for simple requests when their internal extraction or
     schema changes.
   - Basic execution lanes such as plain HTML build should remain stable even when memory internals
     evolve.
9. The intent engine should keep simple routes simple.
   - Narrow requests such as a single self-contained static page should prefer a bounded route with
     a small execution contract and static-site Markdown guidance.
   - Open-ended multi-step work may still escalate into planner or autonomous execution when the
     route contract requires it.
   - A route is not simple if it only appears stable under one wording. Simple routes should remain
     stable across normal paraphrase because the intent engine, not lexical pattern drift, owns the
     semantic choice.
10. Changes to the intent engine should reduce hidden coupling.
   - New routes should come with:
     - a typed contract
     - a clarification rule if ambiguity is expected
     - deterministic post-intent enforcement rules
     - transcript-shaped tests
   - Do not add a new route family if the behavior is really just a presentation variant of an
     existing route.
   - When a route bug appears, prefer fixing the route contract, clarification policy, or
     model-facing route descriptions before adding another lexical helper.
