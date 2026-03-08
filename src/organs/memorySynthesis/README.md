# Memory Synthesis

## Responsibility
This subsystem owns bounded cross-memory synthesis used to reconcile profile facts, remembered
situations, and continuity/open-loop signals into one evidence-backed hypothesis for inline recall
and planner-context enrichment.

## Inputs
- `contracts.ts`
- `episodeFactReconciliation.ts`
- `continuitySynthesis.ts`
- `recallSynthesis.ts`
- `plannerContextSynthesis.ts`

## Outputs
- one bounded synthesis hypothesis or suppression
- supporting evidence records with confidence
- planner-facing synthesis block

## Invariants
- synthesis stays bounded and typed
- weak support suppresses output instead of inventing a hypothesis
- evidence must remain explainable from the contributing facts/episodes/open loops
- this subsystem must not bypass sensitivity or approval gates; callers only pass already-safe data

## Related Tests
- `tests/organs/memorySynthesis.test.ts`
- `tests/interfaces/contextualRecall.test.ts`
- `tests/organs/memoryBroker.test.ts`

## When to Update This README
- when synthesis contracts or evidence shape change
- when planner-context or recall integration changes
- when suppression thresholds or confidence rules materially change
