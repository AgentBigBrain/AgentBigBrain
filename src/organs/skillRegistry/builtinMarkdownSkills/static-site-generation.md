---
kind: markdown_instruction
name: static-site-generation
description: Guidance for simple static HTML/CSS/JS site creation.
tags: static, html, css, website, site, generation, browser
capabilities: static-site, generation, browser
memoryPolicy: candidate_only
projectionPolicy: review_safe_excerpt
---
# Static Site Generation

Use a single self-contained `index.html` when the request asks for a simple static page and does not
require a framework, dependency install, local server, or build step.

## Procedure

1. Resolve the requested destination before writing. If the user named Desktop, Documents,
   Downloads, or an exact folder, keep the artifact inside that user-owned destination and use the
   runtime path rules to prove ownership.
2. Prefer one `index.html` with embedded CSS for simple landing pages, portfolios, flyers,
   one-page demos, and quick design proofs. Add separate assets only when the user asks for them or
   when the page genuinely needs reusable media files.
3. Use placeholder images when the user asks for placeholders or when real assets are not supplied.
   Use inspectable placeholders from deterministic URLs or simple local placeholder blocks; do not
   invent private brand assets.
4. Write the file directly through governed file actions. Avoid shell-generated source when normal
   file writes can express the HTML and CSS clearly.
5. Include enough visual structure for the requested subject: hero, supporting sections, calls to
   action, footer, and responsive behavior when the request implies a complete page.

## Preview

For static previews, opening the exact generated file with a local file URL is enough when the user
only wants to see it. Use localhost only when the user asks for server behavior, framework runtime,
network-style proof, or browser verification that requires a loopback URL.

When the user asks to open the page, use the governed `open_browser` action for the exact generated
`index.html` with an absolute `file://` URL unless a server is required. Do not use shell commands
such as `start`, `open`, `xdg-open`, or `Start-Process` for static preview browser launches, and do
not use `verify_browser` for local file previews. If the user also asks to close the browser
afterward, close only the tracked browser session created for that preview.

Keep generated assets inspectable. Avoid hiding core content in opaque scripts when plain HTML and
CSS can satisfy the request.

## Boundaries

This skill is guidance only. Runtime code still owns write authorization, protected-path checks,
browser session ownership, proof collection, and final reporting.
