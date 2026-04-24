# Core Orchestration

## Responsibility
This subsystem owns the shared orchestration contracts and the mission-checkpoint or failure-summary
helpers that support the top-level `orchestrator.ts` and `taskRunner.ts` entrypoints.

The goal is to keep runtime coordination discoverable without forcing edits through giant mixed
files.

## Inputs
- task-level runtime types from `src/core/types.ts`
- playbook and recovery contracts from `src/core/stage6_85*.ts`
- model usage and failure-taxonomy inputs from the core runtime

## Outputs
- shared orchestration contracts in `contracts.ts`
- local orchestrator governance-driven replanning helpers in `orchestratorGovernance.ts`
- local orchestrator retry-loop, postmortem, and summary assembly in `orchestratorExecution.ts`
- local orchestrator continuity, recall, intent, and remembered-situation access in
  `orchestratorContinuation.ts`
- local orchestrator continuity read-session opening in `orchestratorContinuityReadSession.ts`
- local orchestrator outbound federated delegation flow in `orchestratorFederation.ts`
- local orchestrator planner-input enrichment, hint loading, and per-attempt planning in
  `orchestratorPlanning.ts`
- local orchestrator workflow/judgment learning persistence in `orchestratorLearning.ts`
- mission checkpoint, postmortem, and failure-taxonomy helpers in `orchestratorReceipts.ts`
- task-runner proposal construction and governor-context helpers in `taskRunnerProposal.ts`
- task-runner deadline, spend, hard-constraint, and connector approval preflight in
  `taskRunnerPreflight.ts`
- task-runner `network_write` connector consistency, egress, and JIT approval gating in
  `taskRunnerNetworkPreflight.ts`
- task-runner governance preflight and council evaluation in `taskRunnerGovernance.ts`
- task-runner approved-action execution normalization in `taskRunnerExecution.ts`
- task-runner live-run override extraction and request-scoped browser/process guard helpers in
  `taskRunnerLiveRunOverrides.ts`
- deterministic framework-lifecycle planning caps and evidence gates in
  `deterministicFrameworkLifecyclePolicy.ts`
- task-runner live-run approval guards and browser/process follow-up gating in
  `taskRunnerLiveRunGuards.ts`
- task-runner lifecycle bookkeeping in `taskRunnerLifecycle.ts`
- task-runner governance-event and execution-receipt persistence in `taskRunnerPersistence.ts`
- canonical task-runner result builders in `taskRunnerSummary.ts`
- stable imports for `orchestrator.ts` and `taskRunner.ts`, with only shared normalization or usage
  helpers remaining at the root in `taskRunnerSupport.ts`

## Invariants
- `orchestrator.ts` and `taskRunner.ts` stay as stable coordination entrypoints.
- Mission checkpoint and failure-summary policy should have one canonical home.
- New orchestration helpers belong here when they are shared execution-flow concerns, not planner,
  user-facing, or live-run policy concerns.
- Orchestrator continuity read sessions here must stay request-scoped, bounded, and reuse the
  stable `ProfileMemoryStore` seam instead of inventing a second persistence or caching layer.
- `taskRunnerSupport.ts` should stay limited to genuinely shared helpers that are also used outside
  the orchestration subsystem.

## Related Tests
- `tests/core/orchestrationModules.test.ts`
- `tests/core/orchestratorLearning.test.ts`
- `tests/core/orchestrator.profileMemory.test.ts`
- `tests/core/orchestratorPlanning.test.ts`
- `tests/core/orchestratorGovernance.test.ts`
- `tests/core/taskRunnerPersistence.test.ts`
- `tests/core/taskRunnerPreflight.test.ts`
- `tests/core/taskRunnerProposal.test.ts`
- `tests/core/taskRunnerExecution.test.ts`
- `tests/core/taskRunnerGovernance.test.ts`
- `tests/core/taskRunnerLifecycle.test.ts`
- `tests/core/taskRunnerSummary.test.ts`
- `tests/core/orchestrator.test.ts`
- `tests/core/orchestrator.stage6_75RuntimeWiring.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed in `src/core/orchestration/`
- orchestration contracts move between this folder and `orchestrator.ts` or `taskRunner.ts`
- local orchestrator governance-feedback or replan-prompt ownership changes
- local orchestrator retry-loop or mission-summary ownership changes
- local orchestrator continuity, recall, or remembered-situation ownership changes
- local orchestrator outbound federated delegation ownership changes
- local orchestrator planner-attempt assembly or learning-persistence ownership changes
- mission-checkpoint or postmortem ownership changes
- task-runner proposal construction or governor-context ownership changes
- task-runner preflight constraint or connector approval ownership changes
- task-runner `network_write` connector consistency or JIT approval ownership changes
- task-runner governance-event or receipt-persistence ownership changes
- task-runner lifecycle or result-builder ownership changes
- task-runner approved-action execution ownership changes
- task-runner live-run guardrails start depending on different browser/process ownership metadata or
  exact-resource follow-up semantics
- related orchestration tests move materially
