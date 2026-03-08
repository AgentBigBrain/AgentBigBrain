# Intent Runtime

## Responsibility
This subsystem owns the detailed pulse-lexical rulepack, override loading, and bounded
model-fallback helpers used by the stable `intentInterpreter.ts` and
`pulseLexicalClassifier.ts` entrypoints.

## Inputs
- raw user text and recent conversational turns
- pulse lexical override files and rule-context settings
- structured model clients for nuanced pulse-intent fallback

## Outputs
- shared contracts from `contracts.ts`
- deterministic lexical classifications from `pulseLexicalRules.ts`
- bounded model-assisted intent decisions from `intentModelFallback.ts`

## Invariants
- `intentInterpreter.ts` remains the stable coordinator for pulse intent interpretation.
- `pulseLexicalClassifier.ts` remains the stable lexical-classification entrypoint.
- `pulseLexicalRules.ts` owns the canonical pulse rulepack and override loading behavior.
- `intentModelFallback.ts` owns bounded model prompting and normalization for nuanced pulse intent.
- This subsystem is not the long-term home for human-centric proactive utility scoring; those
  richer usefulness decisions should stay separate from deterministic pulse lexical gating.

## Related Tests
- `intentInterpreter.test.ts`
- `pulseLexicalClassifier.test.ts`
- `intentModelFallback.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed inside `src/organs/intentRuntime/`
- the stable ownership boundary between the top-level intent entrypoints and this subsystem changes
- the pulse rulepack or model-fallback contract moves to a different home
- the related-test surface changes because intent-runtime ownership moved
