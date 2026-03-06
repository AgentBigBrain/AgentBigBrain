# Command Examples

This page is for operators who want prompts and commands that match the current runtime behavior, not aspirational behavior.

The current planner only treats shell execution as explicitly requested when the prompt includes terms such as `shell`, `terminal`, `powershell`, `bash`, `cmd`, `command line`, `run a command`, or `execute a command`. The examples below intentionally use those terms where real shell execution matters.

## Quick Rules That Matter

- For real shell work, name the shell directly: **`PowerShell`**, **`cmd`**, **`bash`**, **`terminal`**, or **`command line`**.
- For real side effects, say **`execute now`**.
- For guidance only, say **`guidance only`** or **`without executing anything`**.
- There is no separate `/skill` slash command right now. Use **`/chat create skill ...`**, **`/chat run skill ...`**, or the same phrasing through CLI prompts.
- If you want draft-first behavior, use **`/propose`** and ask for the exact approval diff before writes or shell commands.

## When To Use Which Command

### Use `/chat` when

- You have one direct request and do not need a draft first.
- You want a summary, explanation, or read-oriented task.
- You want to create or run a skill through natural language.
- You want one concrete side effect handled now.

Examples:

```text
/chat summarize runtime/state.json
/chat create skill repo_status that reads package.json and runtime/state.json and returns a short repo summary
/chat run skill repo_status on this repo
```

### Use `/propose` when

- You want to inspect a plan before anything executes.
- You expect writes, shell commands, or a non-trivial change set.
- You want an approval boundary you can review and adjust.

Examples:

```text
/propose create a React app at C:\Users\<you>\Desktop\finance-dashboard. Show the exact approval diff before any write or shell command.
/draft
/adjust keep the first pass small and add a watchlist panel
/approve
```

### Use `/auto` when

- The goal is multi-step and may require several iterations.
- You want the runtime to keep working toward the goal without waiting after every substep.
- You are comfortable with autonomous progression within the configured limits.

Important:
- If you want real side effects, still say **`execute now`**.
- If shell execution matters, still name the shell explicitly, for example **`PowerShell`**.

Examples:

```text
/auto create a React app at C:\Users\<you>\Desktop\finance-dashboard. Execute now using PowerShell. Create files directly; if blocked, stop and tell me exactly why.
/auto guidance only: outline a release checklist for this repo without executing anything
```

### Use `/draft`, `/adjust`, `/approve`, and `/cancel` when

- `/draft`: you want to inspect the current pending plan.
- `/adjust`: you want to modify the pending plan without starting over.
- `/approve`: you are satisfied with the draft and want execution to begin.
- `/cancel`: the draft is wrong, stale, or no longer wanted.

## What The Runtime Will Tell You

- **Executed** means side-effect actions actually ran in that run.
- **Guidance only** means the runtime answered with instructions or analysis but did not execute side effects.
- **Blocked** means policy, governance, or runtime constraints denied execution.

Use those labels as a quick truth check before assuming anything was created, changed, or run.

## Telegram / Discord Slash-Command Examples

### Guidance only

```text
/chat guidance only: show me how to create a React app without executing anything
```

Why this works:
- **`guidance only`** makes the non-executing intent explicit.
- **`without executing anything`** reduces the chance of side-effect planning.

### Plain direct request

```text
/chat summarize runtime/state.json
```

Why this works:
- It is a normal direct request with no draft required.
- It is naturally read-oriented rather than execution-heavy.

### Draft first, explicit approval

```text
/propose create a React app at C:\Users\<you>\Desktop\finance-dashboard. Show the exact approval diff before any write or shell command.
```

Why this works:
- **`/propose`** keeps the request in draft/approval flow.
- **`before any write or shell command`** makes the approval boundary concrete.

### Draft lifecycle sequence

```text
/propose create a React app at C:\Users\<you>\Desktop\finance-dashboard. Show the exact approval diff before any write or shell command.
/draft
/adjust add a watchlist panel and keep the first pass small
/approve
```

Why this works:
- **`/draft`** lets you inspect the pending plan before execution.
- **`/adjust`** changes the draft without crossing the execution boundary.
- **`/approve`** is the explicit go signal.

### Cancel a stale draft

```text
/cancel
```

Why this works:
- It clears the active draft deterministically.
- It is the right command when you do not want an old approval candidate hanging around.

### Direct file creation without shell

```text
/chat create a file at C:\Users\<you>\Desktop\todo.txt with today's top three priorities. Execute now.
```

Why this works:
- The file path gives the runtime a deterministic target.
- **`Execute now`** makes the side-effect request explicit.

### Autonomous React app build

```text
/auto create a React app at C:\Users\<you>\Desktop\finance-dashboard. Execute now using PowerShell. Create files directly; if blocked, stop and tell me exactly why.
```

Why this works:
- **`Execute now`** makes the side-effect expectation explicit.
- **`PowerShell`** matches the current explicit-shell guardrail.
- The full destination path reduces ambiguity.
- `if blocked, stop and tell me exactly why` asks for a truthful failure explanation instead of a vague success claim.

### Pulse controls

```text
/pulse on
/pulse status
/pulse private
/pulse public
/pulse off
```

Why this works:
- These are deterministic slash-command controls, not planner-generated free-form prompts.
- `private` and `public` change how proactive check-ins are routed.
- `status` gives you a direct pulse-state read without needing a separate diagnostic prompt.

### Create a skill

```text
/chat create skill repo_status that reads package.json and runtime/state.json and returns a short repo summary
```

Why this works:
- There is **no `/skill` command** to discover or memorize.
- `create skill repo_status` clearly names the artifact and its purpose.

### Run a skill

```text
/chat run skill repo_status on this repo
```

Why this works:
- `run skill <name>` is direct and easy for the planner to route.
- It avoids inventing a different command surface.

### Review and status

```text
/review 6.85.A
/status
```

Why this works:
- These are deterministic slash-command surfaces handled directly by the interface layer.

## CLI Examples

### Single governed task

```bash
npm run dev -- "summarize current repo status"
```

### Guidance only from CLI

```bash
npm run dev -- "guidance only: show me how to create a React app without executing anything"
```

Why this works:
- The same guidance-only phrasing that helps in Telegram/Discord also helps in CLI mode.

### Approval-first planning from CLI

```bash
npm run dev -- "create a React app at C:\Users\<you>\Desktop\finance-dashboard. Show the exact approval diff before any write or shell command."
```

Why this works:
- It asks for an approval-first path without requiring slash commands.
- The approval-diff wording keeps the execution boundary explicit.

### Autonomous build with explicit shell wording

```bash
npm run dev -- --autonomous "create a React app at C:\Users\<you>\Desktop\finance-dashboard. Execute now using PowerShell. Create files directly; if blocked, stop and tell me exactly why."
```

Why this works:
- **`Execute now`** requests real side effects.
- **`PowerShell`** makes shell intent explicit to the planner.
- The path makes the target concrete.

### Create a skill from CLI

```bash
npm run dev -- "create skill repo_status that reads package.json and runtime/state.json and returns a short repo summary"
```

### Run a skill from CLI

```bash
npm run dev -- "run skill repo_status on this repo"
```

### Compiled runtime parity check

```bash
npm start -- "run skill repo_status on this repo"
```

Use this when you want to verify behavior under the compiled runtime instead of only the `tsx` development path.

## Weak Prompt vs Better Prompt

### Weak

```text
/auto create a React app on my Desktop
```

Problem:
- It does not clearly say whether you want guidance or executed side effects.
- It does not name a shell.
- It leaves the destination vague.

### Better

```text
/auto create a React app at C:\Users\<you>\Desktop\finance-dashboard. Execute now using PowerShell. Create files directly; if blocked, stop and tell me exactly why.
```

Why it is better:
- **`Execute now`** asks for real execution.
- **`PowerShell`** satisfies the current shell-explicit guardrail.
- The explicit path anchors the target location.
- The blocked-path clause pushes the runtime toward a truthful explanation if it cannot proceed.

### Weak

```text
/chat make me a skill
```

Problem:
- It does not name the skill.
- It does not describe what the skill should do.
- It leaves too much room for planner drift.

### Better

```text
/chat create skill repo_status that reads package.json and runtime/state.json and returns a short repo summary
```

Why it is better:
- The skill name is explicit.
- The inputs are explicit.
- The output expectation is explicit.

## Operator Shortcut

If you want a fast mental model, remember this:

- Want explanation only: say **`guidance only`**.
- Want approval first: use **`/propose`**.
- Want to inspect or change a draft: use **`/draft`** and **`/adjust ...`**.
- Want shell execution: say **`Execute now using PowerShell`** or the equivalent shell for your platform.
- Want skills: use **`create skill ...`** and **`run skill ...`**, not `/skill`.
- Want pulse control: use **`/pulse on|off|private|public|status`**.
