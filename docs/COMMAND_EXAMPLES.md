# Command Examples

This page shows the current command surface as an operator would actually use it. The goal is not
to be exhaustive. The goal is to make the common paths easy to use correctly.

If you want setup and environment wiring, use [docs/SETUP.md](SETUP.md). If you want architecture,
use [docs/ARCHITECTURE.md](ARCHITECTURE.md).

## 1) Quick Mental Model

- Use `/chat` for a direct request.
- Use `/propose` when you want a draft and explicit approval before execution.
- Use `/auto` for a multi-step goal.
- Use `/memory` in a private conversation to review or correct remembered situations.
- Use `/pulse` to control proactive check-ins.
- Use `/status` for the normal human summary. Use `/status debug` only when you need delivery
  internals.

Three execution labels matter:

- `Executed`: the runtime actually ran side effects in that run.
- `Guidance only`: the runtime gave instructions or analysis without side effects.
- `Blocked`: policy, governance, or runtime limits denied execution.

## 2) Quick Rules That Matter

- If you want real side effects, say `execute now`.
- If shell selection matters, name it directly: `PowerShell`, `cmd`, `bash`, `zsh`, `terminal`, or
  `command line`.
- For build/scaffold requests, you do not need shell keywords just to unlock executable planning.
- If you want draft-first behavior, use `/propose`.
- There is no separate `/skill` slash command. Use natural language through `/chat` or `/propose`:
  `create skill ...` or `run skill ...`.
- `/memory` is private-only. It is for reviewing or correcting remembered situations, not dumping
  raw memory internals.

## 3) Natural Invocation

When name-call mode is enabled, the alias does not have to be the first word. Natural greeting
forms are accepted.

Examples:

```text
Hi BigBrain
Hey BigBrain, help me think through this
Morning BigBrain, summarize the current repo state
BigBrain what can you help me with
```

If name-call is required and you send only the alias, the runtime will treat that as incomplete and
ask for actual content.

## 4) When To Use Which Command

### Use `/chat` when

- you want one direct request
- you do not need a draft first
- you want a read, explanation, summary, or one-off side effect

Examples:

```text
/chat summarize runtime/state.json
/chat create skill repo_status that reads package.json and runtime/state.json and returns a short repo summary
/chat run skill repo_status on this repo
/chat create a file at C:\Users\<you>\Desktop\todo.txt with today's top three priorities. Execute now.
```

### Use `/propose` when

- you want to inspect the plan before execution
- the task is likely to write files, run shell commands, or produce a non-trivial change set
- you want a clean approval boundary

Examples:

```text
/propose create a React app at C:\Users\<you>\Desktop\finance-dashboard. Show the exact approval diff before any write or shell command.
/draft
/adjust keep the first pass small and add a watchlist panel
/approve
```

### Use `/auto` when

- the task is multi-step
- you want the runtime to keep working within the configured limits
- you want execution to continue without waiting after every substep

Examples:

```text
/auto create a React app at C:\Users\<you>\Desktop\finance-dashboard. Execute now using PowerShell. Create files directly; if blocked, stop and tell me exactly why.
/auto guidance only: outline a release checklist for this repo without executing anything
```

### Use `/memory` when

- you are in a private conversation
- you want to inspect remembered situations
- you want to mark something resolved, wrong, or forgotten

Examples:

```text
/memory
/memory list
/memory resolve episode_abc123 Billy recovered and is doing well now
/memory wrong episode_abc123 That situation was about Ben, not Billy
/memory forget episode_abc123
```

### Use `/pulse` when

- you want to opt in or out of proactive check-ins
- you want to change whether those check-ins stay private or can use the current conversation

Examples:

```text
/pulse on
/pulse private
/pulse public
/pulse status
/pulse off
```

### Use `/status` when

- you want the normal human summary of what is running
- you want to know whether work is queued
- you want to know whether a draft is waiting for approval

Examples:

```text
/status
/status debug
```

### Use `/review` when

- you want a live checkpoint review command
- you want the artifact path and pass/fail summary for a supported checkpoint

Examples:

```text
/review 6.11
/review 6.75
/review 6.85.A
```

## 5) Human-Centric Examples

### Guidance only

```text
/chat guidance only: show me how to create a React app without executing anything
```

Why it works:
- it explicitly asks for advice rather than execution
- it avoids accidental side-effect planning

### Direct file work

```text
/chat write a short handoff note to C:\Users\<you>\Desktop\handoff.txt. Execute now.
```

Why it works:
- it gives the runtime a clear target path
- it makes the side-effect request explicit

### Live app verification

```text
/chat create a tiny local test site in C:\Users\<you>\Desktop\playwright-proof-smoke, start it, prove localhost readiness, verify the homepage UI in a real browser, then stop the process. Execute now using PowerShell.
```

Why it works:
- it asks for the full finite live-run flow
- it makes readiness proof and browser proof explicit
- it asks for shutdown instead of leaving a background process behind

### Context-aware follow-up

```text
Hi BigBrain, Billy came up again today. I was thinking about that whole thing from a few weeks ago and realized I never told you how it ended.
```

Why it works:
- it sounds like a real human conversation
- it gives the runtime a natural place to use bounded contextual recall
- it avoids needing a special memory-specific command

## 6) CLI Examples

### Single governed task

```bash
npm run dev -- "summarize current repo status"
```

### Guidance only

```bash
npm run dev -- "guidance only: show me how to create a React app without executing anything"
```

### Approval-first planning

```bash
npm run dev -- "create a React app at C:\Users\<you>\Desktop\finance-dashboard. Show the exact approval diff before any write or shell command."
```

### Autonomous build

```bash
npm run dev -- --autonomous "create a React app at C:\Users\<you>\Desktop\finance-dashboard. Execute now using PowerShell. Create files directly; if blocked, stop and tell me exactly why."
```

### Skill workflow from CLI

```bash
npm run dev -- "create skill repo_status that reads package.json and runtime/state.json and returns a short repo summary"
npm run dev -- "run skill repo_status on this repo"
```

## 7) Weak Prompt vs Better Prompt

### Weak

```text
/auto create a React app on my Desktop
```

Problem:
- unclear about execution vs guidance
- vague destination
- no shell preference if shell matters

### Better

```text
/auto create a React app at C:\Users\<you>\Desktop\finance-dashboard. Execute now using PowerShell. Create files directly; if blocked, stop and tell me exactly why.
```

Why it is better:
- `execute now` makes the execution expectation explicit
- the target path is concrete
- the shell is named
- the blocked-path clause asks for a truthful failure explanation

### Weak

```text
/chat make me a skill
```

Problem:
- no name
- no scope
- no output contract

### Better

```text
/chat create skill repo_status that reads package.json and runtime/state.json and returns a short repo summary
```

Why it is better:
- the skill name is explicit
- the inputs are explicit
- the output expectation is explicit

## 8) Operator Shortcut

If you want a short checklist, remember this:

- Want explanation only: say `guidance only`
- Want a draft first: use `/propose`
- Want a multi-step governed run: use `/auto`
- Want real side effects: say `execute now`
- Want a specific shell: name it directly
- Want remembered-situation review: use `/memory` in a private conversation
- Want proactive control: use `/pulse`
- Want the normal progress view: use `/status`
- Want internal delivery detail: use `/status debug`
