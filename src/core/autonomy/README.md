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
- `frameworkContinuationContext.ts`
- `liveRunRecovery.ts`
- `liveRunRecoveryPromptSupport.ts`
- `workspaceRecoveryPolicy.ts`
- `workspaceRecoveryContextClassification.ts`
- `workspaceRecoveryNarration.ts`
- `workspaceRecoveryExactNonPreviewSupport.ts`
- `workspaceRecoveryLikelyNonPreviewSupport.ts`
- `workspaceRecoveryContextualManualCleanupSupport.ts`
- `workspaceRecoveryCommandBuilders.ts`
- `workspaceRecoverySignalBuilders.ts`
- `workspaceRecoveryRuntimeContext.ts`
- `agentLoopProgress.ts`
- `structuredRecoveryRuntime.ts`
- `agentLoopRuntimeSupport.ts`
- `agentLoopUserTurnGate.ts`
- `workspaceRecoveryBlockedPathParsing.ts`
- `workspaceRecoveryInspectionMetadata.ts`
- `loopCleanupPolicy.ts`
- `stopReasonText.ts`
- `agentLoopModelPolicy.ts`

## Inputs
- `TaskRunResult` action outcomes and mission state
- autonomous-goal text and loop iteration state
- managed-process lease metadata and loopback target hints
- typed autonomous reason codes from `src/core/autonomy/contracts.ts`

## Outputs
- next-step recovery prompts
- workspace-lock recovery signals for exact tracked holders, inspect-first retries, and
  clarification-required, targeted exact non-preview-holder confirmation, likely-non-preview
  holder confirmation, manual-browser-cleanup, non-preview-holder cleanup, or stale-record abort
  stops
- local-organization classification reused by workspace-lock recovery instead of embedding that
  parsing inline in the main policy file
- shared parsing helpers for exact tracked workspace-recovery context embedded in execution input
  so recovery classification can reuse the same bounded root and preview-lease extraction across
  planner, retry, and clarification paths
- shared typed recovery-signal builders so autonomous clarification, retry, and abort paths stay
  normalized and easier to validate
- shared exact non-preview holder wording helpers so one or more exact local holders can stay on a
  narrow confirmation path without bloating the main recovery policy file
- holder-specific manual cleanup guidance for editor, shell/file-window, sync, and other
  non-preview local folder locks
- blocked-folder parsing and inspection-metadata extraction reused by workspace-lock recovery
- human-first autonomous working, retrying, and verification progress text
- loop-level structured recovery resolution that turns typed repair budgets into bounded retry or
  fail-closed abort actions before the model next-step path runs
- model-backed next-step and proactive-goal policy decisions
- completion-gate decisions
- missing-evidence classifications
- cleanup decisions for tracked managed processes
- human-readable stop explanations

## Invariants
- Completion must stay fail-closed: missing required evidence means the goal is not done.
- Live-run recovery must preserve tracked lease and loopback-target continuity across iterations.
- Workspace-lock recovery must prefer exact tracked holder evidence, then bounded inspection, and
  must stop instead of guessing when only untracked candidates remain.
- Workspace-lock recovery must not loop forever on stale-only inspection results; if the runtime
  finds only stale assistant-owned records and no live holder, it must stop and explain that the
  remaining blocker is still unknown.
- Workspace-lock recovery must also stop cleanly when it only finds older assistant browser
  windows that are still attributable to the workspace but no longer directly controllable; that
  case should recommend manual cleanup instead of another generic inspect loop.
- Workspace-lock recovery must also stop cleanly when inspection finds likely editor, shell, sync,
  or other non-preview local holders without proving an exact preview holder the runtime can stop
  safely.
- Workspace-lock recovery may ask one targeted confirmation before stopping one exact high-
  confidence non-preview local holder, or a small exact set of them when the runtime can still
  prove those exact path-matched holders safely enough, including exact editor, shell, or sync
  holders when the runtime has a narrow local path match, but that exact-stop path must remain
  marker-bound and must not reopen broad shutdown by process name.
- Workspace-lock recovery may also ask one targeted confirmation before stopping a still-local
  editor/shell holder set, or a still-bounded mixed local holder set across editor, shell, and
  sync processes, when the runtime can keep that inspected set narrow enough to explain, but it
  must still stay confirmation-gated and must not broaden into process-name shutdown.
- Workspace-lock recovery may also keep a small mixed holder set on that same clarification lane
  when one nearby local process is only proven by exact path evidence and the rest of the set
  stays within the bounded editor, shell, or sync families; that path remains confirmation-only
  and must not be upgraded into automatic shutdown.
- Workspace-lock recovery may also keep a broader but still-bounded mixed holder set on that same
  clarification lane when a single nearby local process is only proven by exact path evidence and
  the rest of the set stays within the bounded editor, shell, or sync families; that path remains
  confirmation-only and must not be upgraded into automatic shutdown or broad process-name
  intervention. That broader lane may now extend to an eight-holder mixed local family, including
  sync clients, but it still must remain confirmation-gated.
- When workspace-lock recovery finds a broader but still-local non-preview holder family beyond the
  confirmation lane, it should keep the stop text contextual and human-readable instead of
  flattening back to generic manual-cleanup wording, but that path must remain stop-only and must
  not reopen shutdown.
- When that broader still-local family only exceeds the raw contextual cap because it repeats the
  same bounded holder families, the runtime may keep it on the contextual manual-cleanup lane, but
  only when the grouped holder-family and named-process limits stay bounded enough to explain.
- That grouped contextual manual-cleanup lane may also include two nearby exact-path local
  processes when the total still-local holder set stays inside the bounded grouped-family budget;
  it must still remain stop-only and never reopen shutdown.
- That same repeated-family contextual manual-cleanup lane may continue past the previous grouped
  cap when the inspected holder set still collapses into the same bounded editor, shell, sync, and
  nearby local-process families with a bounded named-process set; it must remain stop-only and
  must not reopen shutdown.
- When workspace-lock recovery stops on non-preview local holders, it should name the most useful
  next human step for that holder kind instead of falling back to vague manual-cleanup wording.
- When a broader non-preview local holder set mixes sync clients with editor, shell, or nearby
  local-process evidence, the stop text should keep mixed close-or-pause guidance instead of
  flattening the whole set into sync-only wording.
- Stop text must stay truthful and solution-oriented; it should explain what happened and what to do
  next.
- New autonomy reason codes should humanize through `stopReasonText.ts`, not ad hoc call-site text.

## Related Tests
- `tests/core/autonomyModules.test.ts`
- `tests/core/liveRunRecovery.test.ts`
- `tests/core/loopCleanupPolicy.test.ts`
- `tests/core/agentLoop.test.ts`
- `tests/interfaces/conversationWorkerLifecycle.test.ts`
- `tests/interfaces/autonomousMessagePolicy.test.ts`

## When to Update This README
Update this README when:
- a new autonomy contract or reason code is added
- completion-gate requirements change
- live-run recovery or cleanup rules move to different files
- the validation path for autonomous stop language changes
