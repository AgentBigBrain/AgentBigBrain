# Reflection Runtime

## Responsibility
This subsystem owns the detailed reflection-runtime contracts, model-facing lesson extraction, and
deterministic signal-classification policy used by the stable `reflection.ts` coordinator.

## Inputs
- completed `TaskRunResult` payloads with blocked or approved actions
- structured reflection model clients and schema names
- existing semantic-memory lesson text for duplicate/signal checks

## Outputs
- typed reflection config and signal-classification contracts from `contracts.ts`
- failure lesson extraction from `failureLessons.ts`
- success lesson extraction from `successLessons.ts`
- deterministic persistence decisions from `signalClassification.ts`

## Invariants
- `reflection.ts` remains the stable coordinator and owns distiller-aware lesson persistence.
- `contracts.ts` is the canonical home for reflection rulepack metadata and config types.
- `failureLessons.ts` and `successLessons.ts` own model prompt assembly, not semantic-memory writes.
- `signalClassification.ts` owns deterministic lesson-signal scoring and duplicate rejection.

## Related Tests
- `reflection.test.ts`
- `reflectionSignalClassifier.test.ts`
- `reflectionFailureLessons.test.ts`
- `reflectionSuccessLessons.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed inside `src/organs/reflectionRuntime/`
- the stable ownership boundary between `reflection.ts` and this subsystem changes
- the rulepack contract or reflection model schemas move to a different home
- the related-test surface changes because reflection runtime ownership moved
