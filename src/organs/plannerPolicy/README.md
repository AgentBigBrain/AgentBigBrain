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
- `buildExecutionPlanMessaging.ts`
- `buildExecutionActionHeuristics.ts`
- `frameworkBuildActionHeuristics.ts`
- `frameworkActionRepairSupport.ts`
- `buildExecutionRecoveryPolicy.ts`
- `liveVerificationPolicy.ts`
- `userOwnedPathHints.ts`
- `actionNormalization.ts`
- `explicitActionIntent.ts`
- `explicitActionRepairSupport.ts`
- `learningPromptGuidance.ts`
- `plannerFailurePolicy.ts`
- `skillActionNormalization.ts`
- `explicitActionRepair.ts`
- `explicitRuntimeActionFallback.ts`
- `frameworkRuntimeActionFallback.ts`
- `frameworkRuntimeActionFallbackSupport.ts`
- `frameworkRuntimeActionFallbackContent.ts`
- `frameworkRuntimeActionFallbackEditSupport.ts`
- `frameworkRuntimeActionFallbackWriteSupport.ts`
- `promptAssembly.ts`
- `promptAssemblyRepairGuidance.ts`
- `promptAssemblyRecoveryGuidance.ts`
- `responseSynthesisFallback.ts`
- `workspaceRecoveryFallback.ts`
- `workspaceRecoveryParsing.ts`

## Inputs
- current user request text
- tracked path or browser-session hints carried forward from the active conversation
- planner model output and repair output
- routing and live-build prompt classification
- planner action schema requirements
- explicit-action intent and skill scaffolding rules

## Outputs
- execution-style classification decisions
- live-verification requirements
- shared recovery and destination guardrails used by execution-style build assessment, including
  shared-desktop denial, broad-shutdown denial, candidate-holder inspect-first policy, and
  destination self-nesting denial for organization moves
- shared execution-style policy messaging used by prompt assembly and fail-closed repair surfaces
- shared build/organization action-shape heuristics used by execution-style build assessment,
  including real move-command detection, Windows shell validation, open-browser target checks, and
  tracked artifact-edit preview allowance
- framework-app specific scaffold/preview heuristics used to require native preview commands,
  reject directory-only reuse guards, and keep oversized shell/start commands fail-closed
- framework-app repair normalization that rewrites unsafe scaffold commands and keeps Next.js route
  writes pinned to the active `app/` tree instead of drifting into stale `src/app/` duplicates
- deterministic framework landing-page fallback content, write-target resolution, and runtime
  action synthesis split into focused helper files so planner fallback stays reviewable and under
  the subsystem size budget
- user-owned path and destination hints for safer continuity-aware local execution
- planner action normalization and alias cleanup
- explicit-action intent classification and filtering
- planner failure cooldown/fingerprint helpers
- skill-name extraction and create/run-skill param normalization
- workflow-learning preferred-skill and repeated-workflow suggestion guidance injected into planner
  prompt assembly and repair notes
- explicit-action repair decisions
- planner system prompts and repair prompts
- deterministic repair-guidance snippets reused by prompt assembly
- deterministic workspace-recovery grounding snippets reused by planner prompt assembly so exact
  tracked workspace ids, browser session ids, preview URLs, and lease ids are reused instead of
  being replaced with broad recovery guesses
- synthesized fallback respond messages when fail-closed repair still cannot produce executable work

## Invariants
- Explicit browser/UI verification requests must require `verify_browser`.
- Tracked browser-control follow-ups should stay distinct from build/live-verification repair rules.
- Execution-style build requests must not silently pass with inspection-only plans.
- Local organization requests must not pass with destination-creation-only shell steps; they need a
  real move command that retries the scoped move.
- Local organization requests must not pass with bare move-only retries; they need bounded proof of
  what landed in the destination and what remained at the original root.
- Local organization requests must not let the named destination folder match the same move selector
  unless the plan explicitly excludes that destination first.
- Build and organization policy heuristics should stay split into focused modules instead of
  regrowing into one oversized validator file.
- Framework-app scaffold and preview heuristics should stay isolated enough that shell-budget or
  native-preview fixes do not force unrelated organization-policy edits.
- Planner repair must fail closed when required executable actions never appear.
- Action normalization, explicit-action intent inference, and skill fallback scaffolding must stay
  owned here rather than drifting back into `src/organs/`.
- Workflow-learning preferred-skill guidance should stay explicit and inspectable here rather than
  becoming hidden model-only behavior.
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
