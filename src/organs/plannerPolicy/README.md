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
- `staticArtifactOpenSupport.ts`
- `staticHtmlPreviewActionNormalization.ts`
- `staticHtmlRuntimeActionFallback.ts`
- `staticHtmlRuntimeActionFallbackSupport.ts`
- `staticHtmlRuntimeActionFallbackContent.ts`
- `frameworkBuildActionHeuristics.ts`
- `frameworkRequestPathParsing.ts`
- `frameworkActionRepairSupport.ts`
- `frameworkPathSupport.ts`
- `buildExecutionRecoveryPolicy.ts`
- `liveVerificationPolicy.ts`
- `liveVerificationSemanticRouteSupport.ts`
- `userOwnedPathHints.ts`
- `actionNormalization.ts`
- `explicitActionIntent.ts`
- `explicitActionRepairSupport.ts`
- `learningPromptGuidance.ts`
- `plannerFirstPrinciplesSupport.ts`
- `plannerFailurePolicy.ts`
- `skillActionNormalization.ts`
- `explicitActionRepair.ts`
- `explicitRuntimeActionFallback.ts`
- `desktopRuntimeProcessSweepFallback.ts`
- `frameworkRuntimeActionFallback.ts`
- `frameworkRuntimeActionFallbackLifecycleSupport.ts`
- `frameworkRuntimeActionFallbackCityThemeVariants.ts`
- `frameworkRuntimeActionFallbackGoalSupport.ts`
- `frameworkRuntimeActionFallbackLayoutSupport.ts`
- `frameworkRuntimeActionFallbackOpenBrowserSupport.ts`
- `localOrganizationRuntimeActionFallback.ts`
- `frameworkRuntimeActionFallbackSupport.ts`
- `frameworkRuntimeActionFallbackContent.ts`
- `frameworkRuntimeActionFallbackEditSupport.ts`
- `frameworkRuntimeActionFallbackThemeSupport.ts`
- `frameworkRuntimeActionFallbackThemeVariants.ts`
- `frameworkRuntimeActionFallbackTrackedContextSupport.ts`
- `frameworkRuntimeActionFallbackWriteSupport.ts`
- `namedWorkspaceLaunchSupport.ts`
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
- deterministic already-built local static-artifact reopen helpers so `open this exact file`
  follow-ups stay on a single-file browser-open lane instead of drifting into rebuild or dev-server
  behavior
- deterministic static HTML preview normalization so execution-style browser-open steps stay aligned
  with no-framework single-page requests
- deterministic static HTML build fallback synthesis so clarified `static_html_build` lanes can
  write one bounded `index.html`, prove it exists, and optionally open the exact local file
  without drifting into framework scaffolding
- deterministic static HTML workspace-resolution, browser-open gating, and content-building helper
  modules so the bounded static lane stays reviewable without rebloating the main fallback file
- framework-app specific scaffold/preview heuristics used to require native preview commands,
  reject directory-only reuse guards, and keep oversized shell/start commands fail-closed
- framework-app repair normalization that rewrites unsafe scaffold commands and keeps Next.js route
  writes pinned to the active `app/` tree instead of drifting into stale `src/app/` duplicates
- path-style-aware framework helpers so Windows workspace roots, route rewrites, and fallback write
  targets stay stable even when tests or recovery run on non-Windows hosts
- deterministic framework landing-page fallback content, write-target resolution, and runtime
  action synthesis split into focused helper files so planner fallback stays reviewable and under
  the subsystem size budget
- deterministic framework live-lifecycle action assembly so start/probe/verify/open action shapes
  stay centralized without regrowing the main framework fallback entrypoint
- deterministic framework city-theme, layout, goal, named-workspace launch, tracked-context, and
  browser-open helper modules so fallback synthesis can vary safely without rebloating the main
  policy entrypoints
- deterministic Desktop-folder runtime process sweep fallback for bounded requests like `Desktop
  folders starting with drone -> stop only exact listening servers tied to those folders`, emitted
  as the native `stop_folder_runtime_processes` action so broad process-management turns stay out
  of scaffold/build lanes
- user-owned path and destination hints for safer continuity-aware local execution
- planner action normalization and alias cleanup
- explicit-action intent classification and filtering
- planner failure cooldown/fingerprint helpers
- skill-name extraction and create/run-skill param normalization
- workflow-learning preferred-skill and repeated-workflow suggestion guidance injected into planner
  prompt assembly and repair notes
- first-principles trigger and rubric helpers extracted from the planner entrypoint so high-risk
  planning policy stays deterministic without regrowing the main planner module
- explicit-action repair decisions
- explicit runtime fallback precedence so tracked runtime inspect or shutdown turns stay on their
  bounded runtime lane instead of drifting into framework-build fallback
- planner system prompts and repair prompts
- deterministic repair-guidance snippets reused by prompt assembly
- deterministic workspace-recovery grounding snippets reused by planner prompt assembly so exact
  tracked workspace ids, browser session ids, preview URLs, and lease ids are reused instead of
  being replaced with broad recovery guesses
- deterministic local-organization fallback synthesis for explicit user-owned folder-move requests
  that remain invalid after repair, keeping the move scoped and proving destination/root state in
  the same command
- synthesized fallback respond messages when fail-closed repair still cannot produce executable work

## Invariants
- Explicit browser/UI verification requests must require `verify_browser`.
- Tracked browser-control follow-ups should stay distinct from build/live-verification repair rules.
- Explicit tracked runtime inspection or shutdown turns should outrank framework-build fallback when
  planner repair fails.
- Explicit Desktop folder runtime sweeps must stay on deterministic bounded process-management
  fallback instead of drifting into unrelated scaffold/build work.
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
