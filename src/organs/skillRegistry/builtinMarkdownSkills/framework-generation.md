---
kind: markdown_instruction
name: framework-generation
description: Guidance for building framework apps with bounded proof steps.
tags: framework, app, react, vite, nextjs, generation, build
capabilities: framework, generation, build
memoryPolicy: candidate_only
projectionPolicy: review_safe_excerpt
---
# Framework Generation

Use the smallest framework path that satisfies the request. Prefer existing project scripts and
package metadata over inventing one-off commands.

## Inspect First

For an existing workspace, inspect `package.json`, framework config, source directories, and
available scripts before choosing files or commands. Preserve the user's requested destination and
the existing framework conventions instead of replacing the project with a template.

For a fresh app, choose a package-safe folder name from the request and emit explicit,
reviewable shell/file actions for scaffold, install, build, and preview steps. If a scaffold
already exists in the target folder, inspect it and continue from the existing files instead of
blindly overwriting it.

When a human-facing destination name is not safe for package tooling, keep that exact destination as
the final workspace but use a separate package-safe identifier for any package bootstrap step. The
runtime still owns the package-name safety check; this guidance only describes how to preserve user
intent while satisfying it.

## Build Procedure

For a new framework app, plan finite proof before live preview: scaffold or create files, install
dependencies only when needed, run the normal build command, then use a managed preview only if the
user asked to run, verify, or leave the app open.

For existing projects, inspect package files first. Use workspace-native commands such as
`npm run build`, `npm run dev`, `npm run preview`, or equivalent scripts from the exact project
folder. Avoid ad-hoc local servers when the framework already provides a preview path.

Use direct file edits for source files. Do not use long shell heredocs or generated scripts as the
primary way to create React, Vue, Svelte, or Vite source when ordinary file writes are clearer and
more reviewable.

When a preview is requested, keep it attached to a managed runtime process and tracked browser
session. When a preview is not requested, stop after source changes and build proof.

Do not treat browser or process control as proof by itself. A truthful completion needs a relevant
file/build/runtime signal from the workspace.

## Boundaries

This skill is guidance only. Runtime code still owns destination safety, package-name validation,
dependency command allowlists, build-proof enforcement, process ownership, and browser ownership.
