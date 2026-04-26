---
kind: markdown_instruction
name: nextjs-generation
description: Guidance for Next.js generation and preview workflows.
tags: nextjs, next.js, react, app, framework, generation, browser
capabilities: nextjs, framework, generation
memoryPolicy: candidate_only
projectionPolicy: review_safe_excerpt
---
# Next.js Generation

Use Next.js conventions instead of generic static-site assumptions. Check whether the workspace uses
the App Router, Pages Router, TypeScript, Tailwind, or a custom package script before editing.

## Inspect First

Look for `app/`, `pages/`, `src/app/`, `src/pages/`, `components/`, `styles/`, `tailwind.config.*`,
`next.config.*`, and package scripts. Let the discovered router and styling system decide the edit
surface.

If both App Router and Pages Router cues exist, prefer the route that already owns the relevant
home page. Do not create a competing route tree unless the user explicitly asks to migrate.

For new work, keep changes in normal Next.js locations such as `app`, `pages`, `components`, and
global styles. Use `npm run build` as finite proof. Use `npm run dev` as a managed process only when
live preview or browser verification is requested.

Prefer editing source files over shell-generating large files. If the model can write the component
or page directly, use file writes and a build proof instead of a long scripted generation path.

## Preview

Do not use a generic static file server for a Next.js app. If the user asks to see it, run the
workspace's normal dev or preview script under the managed process runtime, wait for the loopback
URL, open that tracked URL, and close only that tracked browser session when cleanup is requested.

## Boundaries

This skill is guidance only. Runtime code still owns destination safety, command governance,
build-proof requirements, managed process leases, browser sessions, and final claims.
