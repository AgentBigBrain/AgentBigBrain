# Deterministic Speech

1. Keep state and safety deterministic, not exact wording.
   - The runtime must deterministically know what route was chosen, whether clarification is
     required, what options are valid, what side effects are allowed, and what the truthful status
     is.
   - The exact user-facing sentence does not need to be fixed text every time.
2. Prefer model-rendered wording inside deterministic communication contracts.
   - The model may phrase confirmations, clarifications, brief progress updates, and normal replies
     naturally as long as the underlying state, facts, and allowed options stay constrained.
   - The runtime should provide the direction, required facts, and allowed choices, then let the
     model render natural wording from that structure.
   - The goal is to smooth the user-facing surface. Direction should be deterministic, but the
     sentence should not feel like a hardcoded branch table unless exact wording is required for
     safety or consent.
3. Do not hardcode repetitive robotic clarification speech when the runtime already knows the
   choice space.
   - Example: if the system knows the ambiguity is `plain HTML` vs `framework app`, it should store
     that clarification contract deterministically and let the model ask naturally, such as
     `Do you want this as a plain HTML page or a framework app?`
   - The runtime should still resolve the answer deterministically once the user replies.
4. Clarification state must be machine-readable.
   - Store clarification kind, valid options, and the reason clarification was needed.
   - Do not rely on the user-facing sentence alone to recover state on the next turn.
   - The next-turn answer resolution should match against the stored structured options, not
     against one prior canned sentence.
   - Clarification state should tell the model what it must ask, not force one exact utterance.
     Deterministic state owns the choice space; the model owns the natural phrasing.
5. Keep deterministic speech for exact-risk moments only.
   - Use fixed or tightly bounded wording when policy, consent, or safety requires explicit
     unambiguous phrasing.
   - Examples include destructive-action warnings, privacy-sensitive disclosures, exact approval
     boundaries, or machine-audited operator instructions.
   - Ordinary conversation, help text, clarifications, and status updates should not sound like
     hardcoded system prompts unless exact wording is truly necessary.
6. User-facing language should describe outcome, not internal mechanism.
   - Prefer `I created the page and put it on your Desktop` over a rigid template that exposes
     implementation details first.
   - Debug, telemetry, typed codes, and audit fields belong in logs, tests, or explicit diagnostic
     surfaces unless the user specifically asked for them.
7. Deterministic speech should still be truthful and reviewable.
   - The model may vary wording, but it must not claim a side effect happened unless execution
     evidence proves it.
   - The model may not invent options that are not present in the deterministic clarification
     contract.
   - The model may not weaken or broaden constraints such as `do not open`, `do not run`, or exact
     target ownership.
8. Optimize for natural human interaction without losing control.
   - The system should feel like it understands the user, not like it is replaying canned workflow
     templates.
   - The right balance is deterministic control over state, options, and safety, with model
     flexibility over phrasing, explanation, and tone.
   - If the runtime starts solving wording problems with more canned text or more lexical speech
     branches, that is drift away from this objective and should be corrected.
