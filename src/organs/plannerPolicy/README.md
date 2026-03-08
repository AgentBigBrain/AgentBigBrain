# Planner Policy Subsystem

## Responsibility
This folder owns the canonical policy files that decide when the planner must produce executable
steps, live verification, explicit browser proof, and repair behavior instead of inspection-only
responses.

`src/organs/planner.ts` remains the orchestration entrypoint, but detailed execution-style policy
belongs here.

## Primary Files
- `executionStyleContracts.ts`
- `buildExecutionPolicy.ts`
- `liveVerificationPolicy.ts`
- `actionNormalization.ts`
- `explicitActionIntent.ts`
- `plannerFailurePolicy.ts`
- `skillActionNormalization.ts`
- `explicitActionRepair.ts`
- `promptAssembly.ts`
- `responseSynthesisFallback.ts`

## Inputs
- current user request text
- planner model output and repair output
- routing and live-build prompt classification
- planner action schema requirements
- explicit-action intent and skill scaffolding rules

## Outputs
- execution-style classification decisions
- live-verification requirements
- planner action normalization and alias cleanup
- explicit-action intent classification and filtering
- planner failure cooldown/fingerprint helpers
- skill-name extraction and create/run-skill param normalization
- explicit-action repair decisions
- planner system prompts and repair prompts
- synthesized fallback respond messages when fail-closed repair still cannot produce executable work

## Invariants
- Explicit browser/UI verification requests must require `verify_browser`.
- Execution-style build requests must not silently pass with inspection-only plans.
- Planner repair must fail closed when required executable actions never appear.
- Action normalization, explicit-action intent inference, and skill fallback scaffolding must stay
  owned here rather than drifting back into `src/organs/`.
- Prompt assembly rules should stay centralized here rather than drifting back into
  `src/organs/planner.ts`.

## Related Tests
- `tests/organs/plannerPolicy.test.ts`
- `tests/organs/plannerActionNormalization.test.ts`
- `tests/organs/plannerExplicitActionIntent.test.ts`
- `tests/organs/plannerSkillActionNormalization.test.ts`
- `tests/organs/planner.test.ts`

## When to Update This README
Update this README when:
- a new execution-style requirement or repair rule is added
- prompt assembly moves to different files
- planner fallback rules change enough to alter the canonical edit path
- new policy modules are added to this folder
