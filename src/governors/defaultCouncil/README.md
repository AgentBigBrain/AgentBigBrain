# Default Governor Council

## Responsibility
This subsystem owns the default governor council that evaluates governance proposals before
execution. It keeps model-advisory handling, bounded localhost live-run exemptions, and the
deterministic governor policies out of the entrypoint file.

Key files:
- `contracts.ts`
- `common.ts`
- `liveRunExemptions.ts`
- `trackedArtifactExemptions.ts`
- `userOwnedBuildExemptions.ts`
- `modelAdvisory.ts`
- `ethicsGovernor.ts`
- `logicGovernor.ts`
- `resourceGovernor.ts`
- `securityGovernor.ts`
- `continuityGovernor.ts`
- `utilityGovernor.ts`
- `complianceGovernor.ts`

## Inputs
- `GovernanceProposal` values from the planner or runtime.
- `GovernorContext` values from the active brain configuration, task, and model client.
- Safety lexicon signals and deterministic config limits.

## Outputs
- `GovernorVote` results for each default governor.
- Model-advisory vetoes when a governor-specific advisory model rejects a proposal.
- Deterministic localhost live-run exemption decisions for bounded proof actions.
- Deterministic tracked-artifact and user-owned build exemptions for safe follow-up edits or
  browser-control flows.

## Invariants
- Model-advisory drift must not re-ban bounded localhost `start_process`, `check_process`,
  `stop_process`, `probe_http`, `probe_port`, or `verify_browser` flows.
- Tracked artifact or clearly user-owned build follow-ups may soften advisory vetoes, but they must
  stay scoped to the active workspace or tracked runtime resource.
- Each governor file owns one dominant policy concern.
- `src/governors/defaultGovernors.ts` stays a composition entrypoint, not the main policy home.
- Deterministic checks remain authoritative when model-advisory calls fail.

## Related Tests
- `tests/governors/defaultGovernors.test.ts`
- `tests/governors/defaultCouncil.test.ts`

## When to Update This README
Update this README whenever you add, remove, rename, or materially change files in this folder, or
when the live-run exemption contract, advisory model behavior, or per-governor ownership changes.
