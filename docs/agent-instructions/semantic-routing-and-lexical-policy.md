# Semantic Routing And Lexical Policy

1. This policy applies to the whole codebase, not just to literal regex syntax.
   - The problem is broader than `/.../` patterns.
   - Any hand-authored lexical mechanism that chooses semantic meaning or route belongs under this
     policy.
   - That includes:
     - regex
     - keyword packs
     - token sets
     - token-sequence detectors
     - phrase lists
     - lexical scorecards
     - negative-verb exclusion tables
     - helper functions that infer meaning from wording shape alone
2. Treat lexical routing as an implementation smell when it owns meaning.
   - If a helper decides things like:
     - chat vs workflow
     - status recall vs new work
     - answer-thread continuation vs resume-work
     - build-format ambiguity
     - relationship meaning from natural prose
     - whether a user is giving feedback, asking for review, or asking to edit
     then it is semantic routing, even if it does not use regex syntax.
   - Replacing regex with token arrays or `Set<string>` does not fix the architecture if lexical
     heuristics still own the decision.
3. Lexical logic is allowed only in narrow deterministic roles.
   - Exact commands and machine contracts:
     - slash commands
     - exact tool intents
     - machine-authored envelopes
     - structured payload validation
   - Exact extraction:
     - paths
     - URLs
     - dates
     - IDs
     - file extensions
     - bounded platform markers
   - Safety and authorization:
     - path ownership
     - browser/process ownership
     - destructive-action gating
     - explicit `do not run` / `do not open` constraints
   - Active clarification answer resolution:
     - once the system already knows the valid options, deterministic matching may resolve the
       user's answer against those options
4. Lexical logic must not be the primary route owner for ambiguous human language.
   - Front-door semantic routing should not mainly depend on wording packs.
   - Ambiguous build requests should not be resolved by token tables pretending to understand
     intent.
   - Conversational follow-ups should not depend on brittle phrase trees.
   - Memory and continuity interpretation for fuzzy real-life facts should not be driven mainly by
     broad lexical inference.
5. Preferred decision stack for user-facing routing:
   - narrow deterministic preprocessing for exact signals
   - model-led semantic route selection
   - typed route metadata for execution mode, continuation kind, memory intent, runtime-control
     intent, explicit constraints, and build format
   - deterministic clarification state when ambiguity materially changes behavior
   - model-rendered natural clarification wording
   - deterministic post-intent safety and execution enforcement
6. Clarification is the preferred smoothing mechanism for ambiguous surfaces.
   - If multiple routes are plausible and those routes materially change execution behavior, ask a
     clarification instead of building another lexical workaround.
   - The clarification contract should stay deterministic:
     - kind
     - reason
     - valid options
   - The exact wording of the clarification should remain model-rendered unless policy requires a
     fixed sentence.
7. Code review standard for new lexical helpers:
   - First ask whether the bug is really a semantic-routing problem.
   - If the issue depends on paraphrase, mixed context, ambiguity, or recent turns, prefer:
     - improving route contracts
     - improving clarification policy
     - improving model-facing route descriptions
     - improving transcript-shaped tests
   - Do not add lexical helpers as the first fix unless the requirement is truly rigid and exact.
8. If a lexical helper is temporarily necessary, keep it visibly temporary and tightly bounded.
   - Scope it to one narrow contract.
   - Document why deterministic exact matching is required there.
   - Do not let it silently become the canonical route chooser for broader semantics.
   - Add tests that prove both:
     - the narrow contract works
     - nearby paraphrases still rely on semantic interpretation instead of the helper
9. Memory and graph systems must follow the same rule.
   - Lexical extraction is acceptable for narrow, explicit, well-defined fact families.
   - Lexical extraction is not an acceptable long-term substitute for rich relationship meaning,
     temporal life events, or broad entity interpretation from natural conversation.
   - Conversation context, continuity hints, and document-derived summaries can only expand memory
     surfaces after a typed memory intent allows the relevant lane.
   - If the meaning changes materially with paraphrase or narrative context, prefer typed
     extraction design or bounded model assistance.
10. The implementation goal is a smoother surface, not a different lexical implementation.
   - A route is not stable if small wording changes break it.
   - A system is not meaning-led if semantic ownership merely moved from regex into token helpers.
   - The codebase should move toward:
     - stable route contracts
     - model-led semantic choice
     - deterministic safety and state
     - transcript-based validation
