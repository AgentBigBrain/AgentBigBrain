# Autonomy Subsystem

## Responsibility
This folder owns the canonical contracts and decision helpers for bounded autonomous execution.
It decides:
- what evidence a goal still needs
- when the loop may declare completion
- how live-run recovery steps are phrased
- how cleanup behaves for tracked managed-process leases
- how raw stop reasons become human-facing text

`src/core/agentLoop.ts` remains the public orchestration entrypoint, but the policy ownership lives
here.

## Primary Files
- `contracts.ts`
- `missionContract.ts`
- `missionEvidence.ts`
- `completionGate.ts`
- `liveRunRecovery.ts`
- `loopCleanupPolicy.ts`
- `stopReasonText.ts`

## Inputs
- `TaskRunResult` action outcomes and mission state
- autonomous-goal text and loop iteration state
- managed-process lease metadata and loopback target hints
- typed autonomous reason codes from `src/core/autonomy/contracts.ts`

## Outputs
- next-step recovery prompts
- completion-gate decisions
- missing-evidence classifications
- cleanup decisions for tracked managed processes
- human-readable stop explanations

## Invariants
- Completion must stay fail-closed: missing required evidence means the goal is not done.
- Live-run recovery must preserve tracked lease and loopback-target continuity across iterations.
- Stop text must stay truthful and solution-oriented; it should explain what happened and what to do
  next.
- New autonomy reason codes should humanize through `stopReasonText.ts`, not ad hoc call-site text.

## Related Tests
- `tests/core/autonomyModules.test.ts`
- `tests/core/liveRunRecovery.test.ts`
- `tests/core/loopCleanupPolicy.test.ts`
- `tests/core/agentLoop.test.ts`
- `tests/interfaces/autonomousMessagePolicy.test.ts`

## When to Update This README
Update this README when:
- a new autonomy contract or reason code is added
- completion-gate requirements change
- live-run recovery or cleanup rules move to different files
- the validation path for autonomous stop language changes
