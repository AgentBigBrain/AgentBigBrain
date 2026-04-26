---
kind: markdown_instruction
name: browser-recovery
description: Guidance for recovering browser, preview, and local runtime state.
tags: browser, preview, recovery, localhost, process
capabilities: browser, recovery, preview
memoryPolicy: candidate_only
projectionPolicy: review_safe_excerpt
---
# Browser Recovery

For browser follow-ups, prefer tracked browser session ids and tracked preview process leases from
the current execution context. Do not guess a page, port, or process when the tracked context already
names the exact target.

Closing a browser window does not imply a local preview process stopped. If the same context links a
preview process lease, close the browser first and then stop that exact lease.

Opening or reopening a preview should use the same verified loopback URL or local file URL from the
tracked workspace when available. Only start a new process when no tracked preview can satisfy the
request.

For framework apps, prefer the preview or runtime command declared by the workspace itself. Do not
replace a framework preview with a generic static server unless the user explicitly asked for a
static artifact preview and the runtime can prove that target.

## Procedure

1. Inspect the current execution context for a tracked browser session, preview URL, workspace root,
   primary artifact, and linked process lease.
2. If the user asks to reopen or show the page, use the tracked URL or exact local file URL. Do not
   choose a nearby port, a stale URL, or a similar file by name.
3. If the user asks to close the browser, close the exact tracked browser session. If the request
   also asks to stop the app or server, stop only the exact linked process lease.
4. If ownership cannot be proven, explain the missing proof and leave unrelated browser windows or
   processes alone.
5. Treat browser state as evidence about visibility, not as proof that a build, edit, or cleanup was
   completed.

## Boundaries

This skill is guidance only. Runtime code still owns session ids, process lease ids, URL ownership,
safe close behavior, and fail-closed process shutdown.
