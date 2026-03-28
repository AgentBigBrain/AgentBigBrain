# Stage 6.85 Runtime

## Responsibility
This subsystem owns the canonical clustered Stage 6.85 runtime policy helpers as they move out of
the legacy top-level `stage6_85*` files.

The current extracted slice moves mission-UX, latency, observability, playbook-policy/playbook-runtime,
quality-gate, recovery, clone-workflow, workflow-replay, and runtime-guard ownership behind:
- `cloneWorkflow.ts`
- `contracts.ts`
- `latency.ts`
- `missionUx.ts`
- `observability.ts`
- `playbookIntent.ts`
- `playbookPolicy.ts`
- `playbookRegistry.ts`
- `playbookRuntime.ts`
- `playbookSeeds.ts`
- `qualityGates.ts`
- `recovery.ts`
- `structuredRecoveryExecution.ts`
- `runtimeGuards.ts`
- `workflowReplay.ts`

The stable compatibility entrypoints remain:
- `stage6_85CloneWorkflowPolicy.ts`
- `stage6_85MissionUxPolicy.ts`
- `stage6_85LatencyPolicy.ts`
- `stage6_85ObservabilityPolicy.ts`
- `stage6_85PlaybookPolicy.ts`
- `stage6_85PlaybookRuntime.ts`
- `stage6_85QualityGatePolicy.ts`
- `stage6_85RecoveryPolicy.ts`
- `stage6_85RuntimeGuards.ts`
- `stage6_85WorkflowReplayPolicy.ts`

Canonical behavior for those entrypoints now lives here.

## Inputs
- Stage 6.85 runtime state and approval-tier inputs from `src/core/` orchestrators and evidence
  tools
- Stage 6.85 mission/result-envelope contracts from `src/core/types.ts`
- test fixtures that assert deterministic mission state precedence and approval defaults

## Outputs
- deterministic latency budgets and cache-equivalence checks
- deterministic mission-UX state transitions
- deterministic observability summaries and bounded evidence-bundle profiles
- deterministic playbook intent extraction, seed compilation, registry validation, and planner fallback context
- deterministic quality-gate profiles, verification gates, and truthfulness checks
- deterministic retry-budget, resume-safety, and postmortem shaping
- deterministic bounded structured-recovery execution builders for first-wave repair classes
- deterministic parallel-spike bounds, clone queue validation, packet envelopes, and merge eligibility
- deterministic workflow capture, replay compilation, conflict detection, and workflow receipts
- deterministic runtime-guard enforcement for resume safety and workflow replay
- deterministic approval granularity decisions
- stable approval diff formatting
- normalized mission result envelopes

## Invariants
- `stage6_85CloneWorkflowPolicy.ts`, `stage6_85MissionUxPolicy.ts`, `stage6_85LatencyPolicy.ts`,
  `stage6_85ObservabilityPolicy.ts`, `stage6_85PlaybookPolicy.ts`,
  `stage6_85PlaybookRuntime.ts`, `stage6_85QualityGatePolicy.ts`,
  `stage6_85RecoveryPolicy.ts`, `stage6_85RuntimeGuards.ts`, and
  `stage6_85WorkflowReplayPolicy.ts` remain stable thin entrypoints unless a dedicated migration
  renames them.
- Extraction here changes ownership, not Stage 6.85 product semantics.
- Stage 6.85 policy helpers here must remain deterministic and fail-closed.
- Additional Stage 6.85 helpers should move into this folder by concern instead of growing new
  top-level `stage6_85*` catch-all files.

## Related Tests
- `tests/core/stage6_85CloneWorkflowPolicy.test.ts`
- `tests/core/stage6_85CloneWorkflowRuntime.test.ts`
- `tests/core/stage6_85LatencyPolicy.test.ts`
- `tests/core/stage6_85MissionUxPolicy.test.ts`
- `tests/core/stage6_85MissionUxRuntime.test.ts`
- `tests/core/stage6_85ObservabilityPolicy.test.ts`
- `tests/core/stage6_85PlaybookIntent.test.ts`
- `tests/core/stage6_85PlaybookPolicy.test.ts`
- `tests/core/stage6_85PlaybookRegistry.test.ts`
- `tests/core/stage6_85PlaybookRuntime.test.ts`
- `tests/core/stage6_85PolicyRuntime.test.ts`
- `tests/core/stage6_85QualityGatePolicy.test.ts`
- `tests/core/stage6_85RecoveryPolicy.test.ts`
- `tests/core/stage6_85RecoveryRuntime.test.ts`
- `tests/core/stage6_85RuntimeGuards.test.ts`
- `tests/core/stage6_85RuntimeGuardsRuntime.test.ts`
- `tests/core/stage6_85WorkflowReplayPolicy.test.ts`
- `tests/core/stage6_85WorkflowReplayRuntime.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed under `src/core/stage6_85/`
- canonical Stage 6.85 mission-UX, latency, observability, playbook, quality-gate, recovery,
  clone-workflow, workflow-replay, or runtime-guard ownership moves
- any stable `stage6_85*Policy.ts` compatibility entrypoint changes role
- deterministic Stage 6.85 runtime behavior changes materially
- the related-test surface changes because Stage 6.85 ownership moved
