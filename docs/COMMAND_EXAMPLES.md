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

Media note:

- Telegram screenshots, voice notes, and short videos can be used as input context with safe limits.
- Rich screenshot understanding requires a vision-capable model.
- Rich voice-note understanding requires transcription.
- Short video currently uses file metadata and captions, so captions or follow-up text are still helpful when the clip is ambiguous.

Voice command note:

- In voice notes, you can use `command <name>` as the spoken version of a slash command.
- Examples: `command skills`, `command status`, `command auto fix the planner test now`
- If a voice note does not start with a clear `command <name>` phrase, it stays normal conversation text.

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

### Screenshot correction in Telegram

```text
[send a screenshot]
Caption: BigBrain you did this wrong. The screenshot shows the actual issue. Please fix it now instead of only explaining it.
```

Why it works:
- the screenshot provides visual context
- the caption makes the execution intent explicit
- the runtime can treat this like a direct corrective request

### Voice note with direct execution intent

```text
[send a voice note]
Spoken content: Please go fix this now. The planner test is still failing on the branch behavior, and I want you to repair it instead of just describing it.
```

Why it works:
- the voice note can become transcript-backed context
- the request is explicit enough that the runtime does not need `execute now` as magic wording

### Voice note with explicit command mode

```text
[send a voice note]
Spoken content: BigBrain, command skills and tell me which reusable tools you already trust for planner failure work because I do not want to rediscover the same fix again.
```

Why it works:
- `command skills` is the voice-safe version of `/skills`
- the rest of the sentence can stay natural and conversational
- it avoids false positives because ordinary speech does not get promoted into slash commands

### Voice note with autonomous command mode

```text
[send a voice note]
Spoken content: BigBrain, command auto fix the failing planner branch test now and stop if policy blocks any write or shell step.
```

Why it works:
- `command auto` is the voice-safe version of `/auto`
- the goal can still be spoken in one natural sentence
- the runtime keeps the same safety and stop behavior as text `/auto`

### Short video with ambiguous intent

```text
[send a short video]
Caption: BigBrain I recorded this because the dashboard feels off right after the menu opens. Use the clip and help me with the next step.
```

What should happen:
- the runtime should ask a clarifying question such as whether you want it planned first or built now
- it should not act as if the clip got deep analysis when the current video path only uses metadata and captions

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

### Ask for the current skill inventory in normal conversation

```text
/chat Before we jump back into the planner failure, tell me what reusable skills you already have available right now. I want to know which ones are safe to trust before I ask you to use one.
```

Why it works:
- users do not need to know the internal architecture to inspect available skills
- the runtime should answer with the same canonical inventory as `/skills`

### Ask to reuse a proven workflow without jargon

```text
/chat This feels like the same planner failure we dealt with last week. If you already have a reusable tool or a proven workflow for it, use that instead of rediscovering the fix.
```

Why it works:
- it sounds like a natural human request
- it gives the runtime room to prefer a trusted skill or a proven workflow
- the user does not need to say whether the answer should come from a skill or workflow memory

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
- Want media to carry most of the context: screenshots and voice notes work best today; video is accepted but still relies on file metadata and captions
