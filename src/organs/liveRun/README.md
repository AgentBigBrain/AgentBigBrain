# Live-Run Subsystem

## Responsibility
This folder owns the canonical runtime handlers for managed-process lifecycle, localhost readiness
proof, and browser proof.

`src/organs/executor.ts` remains the dispatch entrypoint, but the behavior for live-run actions is
implemented here.

## Primary Files
- `contracts.ts`
- `liveRunMetadataBuilders.ts`
- `processLiveness.ts`
- `browserSessionRegistry.ts`
- `browserSessionRegistryPersistence.ts`
- `managedProcessRegistry.ts`
- `playwrightBrowserProcessIntrospection.ts`
- `startProcessHandler.ts`
- `managedProcessTargetResolution.ts`
- `checkProcessHandler.ts`
- `stopProcessHandler.ts`
- `probeHttpHandler.ts`
- `probePortHandler.ts`
- `openBrowserHandler.ts`
- `closeBrowserHandler.ts`
- `inspectPathHoldersHandler.ts`
- `inspectWorkspaceResourcesHandler.ts`
- `inspectWorkspaceResourcesRecovery.ts`
- `untrackedPreviewCandidateInspection.ts`
- `untrackedPreviewCandidateRecoverySelectors.ts`
- `browserVerifier.ts`
- `browserVerificationHandler.ts`
- `playwrightRuntime.ts`

## Inputs
- approved executor actions such as `start_process`, `check_process`, `stop_process`,
  `probe_http`, `probe_port`, `verify_browser`, `open_browser`, `close_browser`,
  `inspect_path_holders`, and `inspect_workspace_resources`
- loopback targets, expected status codes, and browser proof expectations
- shell/runtime configuration from `src/core/config.ts`

## Outputs
- typed managed-process lease metadata
- trusted loopback-target resolution for generic workspace-native dev or preview commands when the
  workspace config pins a concrete localhost target
- tracked browser-session metadata and close/open control handles
- browser-session ownership metadata including runtime-managed browser pid plus linked preview
  lease, cwd, and pid when a visible browser belongs to a local preview stack
- exact Playwright Chrome-for-Testing process discovery and cleanup helpers for PID-backed
  restart-safe browser reclamation
- canonical browser-session persistence and normalization helpers so the stable registry entrypoint
  can stay focused on live control and liveness reconciliation
- shared browser-session and holder-inspection metadata builders reused by live-run handlers
- runtime-owned holder-inspection metadata for one local path or tracked workspace, including
  current tracked, stale tracked, and orphaned-attributable classifications
- bounded likely untracked preview-holder candidates with explicit confidence, attributable
  ownership hints, holder kinds, and next safe action
- explicit manual-cleanup recommendations when older assistant browser windows are still
  attributable to a workspace but no longer directly controllable by the runtime
- explicit manual-cleanup recommendations when inspection finds editor, shell, sync, or other
  non-preview local holders instead of exact preview resources
- targeted exact-holder confirmation guidance when inspection finds one or a small exact
  non-preview local holder set, including exact editor, shell, or sync holders with narrow path
  evidence
- a targeted likely-holder clarification lane when inspection finds a still-local editor/shell
  holder set, or a still-bounded mixed local holder set across editor, shell, and sync processes,
  that is too uncertain for automatic shutdown but too specific for vague manual cleanup
- holder-specific manual release guidance for non-preview local holders, such as closing the IDE,
  shell/file window, or sync client that still owns the folder
- typed linked-browser cleanup metadata when exact preview-holder shutdown also closes runtime-
  managed browser sessions tied to that same preview lease
- readiness results (`PROCESS_READY`, `PROCESS_NOT_READY`)
- browser verification results and proof metadata
- typed runtime-unavailable or expectation-failure outcomes

## Invariants
- Loopback proof actions must stay bounded to localhost-only targets.
- Local static-preview browser control may use tracked `file://` URLs, but proof claims still require
  truthful local file or loopback metadata instead of pretending localhost verification happened.
- `start_process` must fail early on occupied requested loopback ports instead of pretending the
  process started cleanly.
- Generic workspace-native server commands such as `npm run dev` or `npm run preview` must keep a
  typed loopback target when trusted workspace config pins one, so later readiness and browser
  proof stays on the actual app instead of drifting to planner defaults.
- Browser proof must never overclaim: runtime-unavailable and expectation failures must remain
  typed.
- Browser open/close follow-ups must operate on tracked sessions instead of guessing from free-form
  text.
- Managed-process cleanup must operate through the registry contract instead of shell-side guesswork.
- Exact preview-holder shutdown must close any still-controllable linked browser sessions tied to
  that same lease and emit typed cleanup metadata instead of leaving those windows falsely
  remembered as open.
- Holder inspection must stay side-effect free and prefer exact runtime-owned matches over guessed
  system-wide process names.
- Holder inspection must distinguish between current tracked resources, stale tracked records, and
  orphaned-attributable matches so older assistant work is not mistaken for current control.
- Orphaned attributable browser sessions must not be flattened into generic "inspect more"
  guidance when the real next step is manual cleanup of older assistant browser windows the runtime
  no longer controls.
- Untracked candidate inspection must stay bounded, read-only, and recommendation-only. It may
  suggest likely preview holders, but it must not itself authorize stopping them.
- Bounded likely non-preview clarification may now cover a broader eight-holder mixed local family
  when exactly one nearby local process is only proven by exact path evidence and the rest stay in
  the editor, shell, or sync families, but that lane must remain confirmation-only.
- Broader still-local non-preview holder families that exceed the clarification lane may still keep
  contextual manual-cleanup wording when the inspected set is bounded enough to explain, but that
  path must remain stop-only and must not surface as shutdown-safe.
- That broader contextual manual-cleanup lane may also keep grouped still-local families beyond the
  raw candidate cap when the repeated holder families and named process set are still bounded
  enough to explain, but it must remain stop-only and never become a broader shutdown lane.
- That grouped contextual manual-cleanup lane may also include two nearby exact-path local
  processes when the total holder set still stays inside the bounded grouped-family limits, but it
  must remain stop-only and never surface as shutdown-safe.
- That same repeated-family contextual manual-cleanup lane may continue beyond the older grouped
  cap when the inspected holder set still collapses into the same bounded editor, shell, sync, and
  nearby local-process families with a bounded named-process set, but it must remain stop-only and
  never surface as shutdown-safe.
- Untracked candidate inspection must distinguish preview-like holders from editor, shell, sync,
  and other non-preview local holders so recovery can stop cleanly instead of pretending they are
  more preview candidates.
- When non-preview local holders are detected, inspection output must guide the user toward the
  most likely release step for that holder kind instead of only saying "manual cleanup".
- When broader non-preview local holder sets mix sync clients with editor, shell, or nearby local
  processes, inspection output should keep mixed close-or-pause guidance instead of flattening the
  whole set into sync-only wording.
- When one exact non-preview local holder, or a small exact set of them, can be proven from narrow
  path evidence, inspection should stay on the targeted confirmation lane instead of flattening the
  case into manual cleanup.
- When a still-local editor/shell holder set, or a still-bounded mixed local holder set across
  editor, shell, and sync processes, is narrow enough for a targeted user confirmation, inspection
  should surface that clarification lane instead of flattening it into generic manual cleanup.
- That same clarification lane may also include a small nearby local-process candidate when the
  runtime only has exact path evidence for that extra process and the rest of the inspected set
  stays within the bounded editor, shell, or sync families; inspection must still keep that case
  confirmation-gated and must not treat it as exact-stop proof.
- That same clarification lane may also include one nearby local-process candidate in a broader but
  still-bounded mixed set when the runtime only has exact path evidence for that extra process and
  the rest of the inspected set stays within the bounded editor, shell, or sync families;
  inspection must still keep that case confirmation-gated and must not treat it as exact-stop
  proof.
- Browser-session metadata here must preserve the last known runtime-managed browser pid and linked
  preview-process ownership details so later follow-up control and cleanup stay exact.
- When Playwright handle control is lost, exact runtime-owned browser pids should still be enough
  to reclaim smoke-owned or restart-recovered browser windows instead of leaving them running on
  the host.
- Persisted managed-process and runtime-managed browser-session records must reconcile dead local
  pids fail-closed so restart churn does not leave ghost `PROCESS_STARTED` or `open` resources in
  the runtime's canonical state.

## Related Tests
- `tests/organs/liveRunHandlers.test.ts`
- `tests/organs/browserVerifier.test.ts`
- `tests/organs/executor.test.ts`
- `tests/core/agentLoop.test.ts`
- `scripts/evidence/managedProcessLiveSmoke.ts`

## When to Update This README
Update this README when:
- a live-run action type is added or removed
- lease metadata or readiness result contracts change
- browser verification launch semantics or proof metadata change
- executor dispatch ownership for live-run actions moves to different files
