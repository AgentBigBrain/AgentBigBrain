# Built-In Markdown Skills

This folder stores source-controlled Markdown instruction skills. They are loaded as built-in
guidance and merged with user-created runtime skills from `runtime/skills`.

Built-ins are advisory planner context only. They do not authorize side effects, do not bypass
governors, and do not become canonical memory.

Current built-ins cover framework generation, Next.js repair, static-site creation, browser
recovery, and generic document reading.

Use this folder for reusable procedural guidance that would otherwise become hard-coded generation
logic. Good candidates include framework conventions, static-site structure, preview recovery, and
document-reading heuristics. Bad candidates include safety authorization, protected-path policy,
governor decisions, or anything that should be enforced deterministically.

Built-ins should stay generic. They must not encode one-off customer data, private fixture content,
or a single example document shape as if it were a universal rule.
