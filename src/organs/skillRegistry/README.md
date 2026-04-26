## Responsibility
This subsystem owns the canonical manifest, lifecycle, verification, inventory, and planner-guidance
contracts for governed runtime skills. It supports two skill kinds:

- `executable_module`: runtime-created JavaScript/TypeScript artifacts that may be invoked through
  `run_skill` after normal constraints and governors.
- `markdown_instruction`: advisory Markdown guidance loaded into planner context when relevant.
  These skills are never executable `run_skill` targets and never grant authorization.

## Primary Files
- `contracts.ts`
- `skillInspection.ts`
- `skillLifecycle.ts`
- `skillManifest.ts`
- `skillManifestNormalization.ts`
- `skillMarkdownManifest.ts`
- `skillRegistryStore.ts`
- `skillSuggestionPolicy.ts`
- `skillVerification.ts`
- `skillVerificationContracts.ts`
- `workflowSkillBridge.ts`
- `builtinMarkdownSkills/`

## Inputs
- create/run skill actions from `src/organs/executionRuntime/skillRuntime.ts`
- built-in Markdown instruction files from `builtinMarkdownSkills/`
- repeated-workflow summaries from `src/core/workflowLearningRuntime/`
- text and voice discovery requests from the interface runtime

## Outputs
- canonical skill manifests with lifecycle, verification, side-effect, and user-facing summary metadata
- deterministic skill inventory entries for `/skills`, `command skills`, and natural-language discovery
- workflow-linked preferred-skill and suggestion summaries used by planner/orchestrator surfaces
- bounded planner guidance entries selected from Markdown skills by request relevance

## Invariants
- Runtime user skill manifests are stored next to runtime artifacts under `runtime/skills`.
- Built-in Markdown skills are source-controlled under `builtinMarkdownSkills/` and are read-only at
  runtime.
- Runtime user skills take precedence over built-ins with the same name.
- Inventory surfaces only show active skills.
- Verification state is explicit and never implied from file presence alone.
- Markdown instruction skills default to `candidate_only` memory policy and
  `review_safe_excerpt` projection policy.
- The registry may suggest or prefer skills, but it never bypasses planner, governor, or executor checks.
- Projected skill notes, when added later, are review surfaces only and never become authoritative
  runtime inputs.

## Related Tests
- `tests/organs/skillRegistry.test.ts`
- `tests/organs/skillWorkflowBridge.test.ts`
- `tests/organs/executor.test.ts`

## When to Update This README
- Update this README when manifest fields, verification semantics, inventory behavior, or the stable
  skill-runtime entrypoints change.
