# Projection Runtime

## Responsibility
This subsystem owns the external memory-projection boundary for AgentBigBrain. It turns canonical
runtime state into read-only mirror outputs for operator inspection without making those external
targets the source of truth.

The first sink is an Obsidian vault mirror. The same core contract also supports non-Obsidian sinks
such as the JSON mirror used to prove the seam stays generic.

## Inputs
- canonical runtime snapshots built from profile memory, Stage 6.86 runtime state, the entity
  graph, governance memory, execution receipts, workflow learning, and media artifacts
- canonical projection change sets emitted by runtime-owned write seams
- projection runtime config from `config.ts`
- guarded review-action notes for the write-back lane

## Outputs
- deterministic projected notes, `.base` files, and mirrored asset copies for Obsidian
- projection sync state for rebuild and incremental fanout
- review-action mutation routing through canonical profile-memory and Stage 6.86 seams
- optional non-Obsidian mirror artifacts such as the JSON sink output

## Invariants
- AgentBigBrain stays the source of truth. Projection targets never become canonical memory stores.
- Projection config, policy, and sink fanout stay centralized here instead of being reimplemented
  inside stores or transport runtimes.
- Read-only mirror behavior comes first. Guarded write-back happens only through structured review
  actions and canonical mutation seams.
- Raw media assets are mirrored as artifacts plus companion notes. They are not treated as current
  truth by themselves.
- Rebuild and incremental sync must preserve deterministic note paths, stable metadata, and
  operator-authored review-action notes.
- The sink interface must stay generic enough for non-Obsidian targets.

## Related Tests
- `tests/core/projectionService.test.ts`
- `tests/core/mediaArtifactStore.test.ts`
- `tests/core/obsidianVaultSink.test.ts`
- `tests/core/projectionReviewActions.test.ts`
- `tests/core/jsonMirrorSink.test.ts`
- `tests/tools/obsidianProjectionTools.test.ts`

## When to Update This README
Update this README when:
- the projection sink contract changes
- a new projection sink is added or removed
- the canonical snapshot surfaces change
- review-action write-back changes meaningfully
- asset mirroring or redaction policy changes
- the related-test surface changes because projection ownership moved
