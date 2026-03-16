# Deterministic Safety Rules

1. Zero-Trust AI: treat all model output as untrusted and validate at the model boundary.
2. Preserve fail-closed behavior for planner, governance, and constraints.
3. Preserve protected-path and identity or privacy communication guards.
4. Preserve local-first persistence and immutable control-plane protections.
5. Keep meaning and authorization separate.
   - The intent engine may classify what the user appears to want, but it must not by itself
     authorize ambiguous holder shutdown, broad recovery actions, or unrelated cross-workspace
     access.
   - Safety-sensitive actions still require deterministic policy, hard-constraint, and governor
     approval.
6. Do not replace one unsafe shortcut with another.
   - Avoid solving natural-language flexibility by adding large phrase libraries that act like a
     hidden permission system.
   - Prefer typed runtime facts, explicit recovery tiers, and deterministic checks over fuzzy
     authorization by wording alone.
7. Broad process-name shutdown is not an acceptable default repair.
   - Do not use shell commands like `Stop-Process -Name ...`, `taskkill /IM ...`, `pkill`, or
     `killall` as a generic way to recover from local workspace friction.
   - Prefer exact tracked `stop_process` actions, exact browser-session control, later holder
     inspection, or a clarification step when confidence is not high enough.
   - If the system cannot prove which process is safe to stop, it should fail closed rather than
     widening the blast radius.
   - Safe stale-workspace example: resume one attributable older landing-page workspace when the
     runtime can still prove that exact workspace ownership and preview linkage.
   - Safe shape example: close the exact tracked landing-page browser session and stop its linked
     preview lease.
   - Clarify-first example: the user says `organize those folders`, but the runtime cannot prove
     which untracked process holds one of them open.
   - Forbidden shape example: stop `node`, `Code`, `OneDrive`, or `explorer` by name just because
     a folder move failed.
