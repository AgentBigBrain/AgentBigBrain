# User Experience And Capability Principles

1. Do not ban live-run workflows; model them properly.
   - Do not solve `npm start`, dev servers, previews, or similar live-run tasks by broadly shutting
     them off.
   - Prefer properly governed capability expansion: managed-process lifecycle, readiness checks,
     browser verification, bounded cleanup, and truthful completion criteria.
   - Avoid one-off special cases when the real issue is a missing runtime abstraction.
2. Keep user-facing communication human-first.
   - Normal user replies should explain what happened in plain language before exposing technical
     details.
   - Lead with practical meaning and next steps, not internal telemetry or raw reason codes.
   - Preserve typed codes for debug and audit surfaces, but do not make users parse them in normal
     conversation.
3. Maximize helpfulness without overclaiming.
   - If something failed or was blocked, say what happened, why it happened, and what the user can
     do next.
   - Prefer solution-oriented wording over terse failure statements.
   - Never claim a side effect happened unless it was actually approved and executed.
4. Favor natural, supportive responses over robotic phrasing.
   - Responses should feel clear, direct, and conversational rather than mechanical.
   - Avoid unnecessary jargon when a simpler explanation will do.
   - Keep the tone grounded and practical; helpfulness should come from clarity and actionable
     guidance.
5. Aim for accessible middle-ground language.
   - As a communication guardrail, aim roughly around a 1300-1400L lexicon level when writing normal
     user-facing responses.
   - Assume users can range from high-school level to graduate-level technical ability.
   - Do not speak over people, but do not flatten the explanation so much that it becomes vague or
     patronizing.
   - Prefer common words first, explain specialized terms when they matter, and keep enough
     precision that a technical reader still learns something useful.
   - Optimize for understanding: the user should leave knowing what happened, why it mattered, and
     what they can do next.
6. Use determinism for guarantees, not as a blanket restriction on learning.
   - Keep deterministic behavior strict where the runtime makes hard promises: security boundaries,
     truthfulness, governance decisions, receipts, typed outcomes, and auditability.
   - Do not overextend determinism into every problem-solving path if that would prevent the system
     from learning, adapting, retrying, or discovering a safe workaround.
   - Within approved safety envelopes, prefer bounded experimentation, iterative verification, and
     strategy adaptation over premature shutdown.
   - When a workflow is inherently dynamic or live, the answer is usually better modeling and better
     verification, not less capability.
   - The goal is a brain that stays safe and truthful while still learning how to get unstuck.
