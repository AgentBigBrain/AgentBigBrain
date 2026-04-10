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
- `temporalSynthesisAdapter.ts`
- `temporalSynthesisAdapterCompatibilitySupport.ts`
- `temporalSynthesisAdapterLegacySupport.ts`

## Outputs
- one bounded synthesis hypothesis or suppression
- supporting evidence records with confidence
- additive bounded decision records copied from inspected supporting facts when available
- planner-facing synthesis block
- explicit `legacy_adapter_only` marking on `BoundedMemorySynthesis` until touched consumers are
  cut over to temporal synthesis
- canonical temporal synthesis adapted into the legacy bounded output through
  `temporalSynthesisAdapter.ts`
- typed lane-boundary metadata derived from canonical temporal synthesis for broker and continuity
  boundary consumers during the Phase 6.5 cutover

## Invariants
- synthesis stays bounded and typed
- weak support suppresses output instead of inventing a hypothesis
- evidence must remain explainable from the contributing facts/episodes/open loops
- this subsystem must not bypass sensitivity or approval gates; callers only pass already-safe data
- `BoundedMemorySynthesis` remains a legacy compatibility adapter and must not become a co-equal
  truth contract beside later temporal synthesis outputs
- bounded decision records carried on the legacy adapter remain proof-only metadata; they must not
  create new authority, visibility, or mutation paths inside synthesis
- lane-boundary metadata emitted here must stay derived from canonical temporal synthesis rather
  than rendered memory text, and downstream routing must not treat rendered synthesis text as a
  second co-equal boundary signal

## Related Tests
- `tests/organs/memorySynthesis.test.ts`
- `tests/organs/memorySynthesisTemporalAdapter.test.ts`
- `tests/interfaces/contextualRecall.test.ts`
- `tests/organs/memoryBroker.test.ts`

## When to Update This README
- when synthesis contracts or evidence shape change
- when planner-context or recall integration changes
- when suppression thresholds or confidence rules materially change
