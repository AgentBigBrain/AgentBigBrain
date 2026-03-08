# Proactive Runtime

## Responsibility
This subsystem owns the bounded utility, cooldown, and delivery-selection logic for human-centric
proactive follow-up. It exists so generic pulse behavior does not drift into scattered local
heuristics across the conversation runtime.

Canonical ownership here:
- `contracts.ts` owns the bounded proactive runtime contracts
- `userValueScoring.ts` owns deterministic user-value scoring for relationship clarification
- `followupQualification.ts` owns qualification/suppression for low-value relationship-clarification
  pulses
- `cooldownPolicy.ts` owns the human-scale pulse gap plus contextual topic cooldown helpers
- `deliveryPolicy.ts` owns provider routing, session skipping, and target-session selection

Stable conversation-runtime entrypoints continue to orchestrate proactive behavior:
- `pulseScheduling.ts`
- `pulseDynamicEvaluation.ts`
- `pulseEvaluation.ts`
- `pulseContextualFollowup.ts`

## Inputs
- conversation sessions from `sessionStore.ts`
- recent pulse history and queued/recent jobs from interface runtime state
- Stage 6.86 pulse candidates and entity graph data
- bounded contextual topic keys derived from contextual follow-up prompts

## Outputs
- deterministic proactive utility scores
- deterministic suppression decisions for weak relationship-clarification pulses
- deterministic pulse-gap and contextual-topic cooldown decisions
- deterministic provider/session routing for proactive delivery

## Invariants
- This subsystem must stay bounded and utility-first; silence is better than a weak generic nudge.
- It must not create new proactive classes on its own; it only qualifies and routes existing ones.
- It must not bypass the stable conversation-runtime pulse entrypoints.
- Relationship-clarification qualification here must stay evidence-backed and suppressible.
- Cooldown policy here must remain human-scale and deterministic.

## Related Tests
- `tests/interfaces/pulseScheduling.test.ts`
- `tests/interfaces/agentPulseScheduler.test.ts`
- `tests/interfaces/proactiveRuntime.test.ts`

## When to Update This README
Update this README when:
- a new file is added to `src/interfaces/proactiveRuntime/`
- proactive utility scoring or suppression rules change materially
- cooldown or delivery-selection ownership changes materially
- stable pulse entrypoints move additional canonical ownership into or out of this subsystem
