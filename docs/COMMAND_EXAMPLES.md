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

One more practical rule:

- Slash commands are still the clearest way to force a mode, but clear natural wording can also
  start autonomous work, resume saved work, or ask for a review-ready checkpoint.

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
- For site, app, browser-recovery, and document-reading work, reusable Markdown instruction skills
  are the default guidance path. They shape the plan but do not authorize side effects.
- If you want draft-first behavior, use `/propose`.
- If a real saved checkpoint already exists, natural prompts like `show me the rough draft`, `pick
  that back up`, or `leave the rest for later` can work without a slash command.
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
/propose create a static HTML site at C:\Users\<you>\Desktop\sample-site for a sample service company with placeholder images. Show the exact approval diff before any write or shell command.
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
/auto create a static HTML site at C:\Users\<you>\Desktop\sample-site for a sample service company with placeholder images. Execute now using PowerShell. Create files directly; if blocked, stop and tell me exactly why.
/auto guidance only: outline a release checklist for this repo without executing anything
```

Natural front-door equivalents can also work when the intent is already clear:

```text
BigBrain, build me a landing page for a sample company, keep going until it's done, put it on my Desktop in a folder called sample-company, and leave the preview open for me.
Keep refining that saved draft from where you left off.
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

### Natural autonomous start

```text
BigBrain, build a small local landing page for a sample company, keep going until it's done, put it on my Desktop in a folder called sample-company, and leave the preview open for review.
```

Why it works:
- it gives a real end-to-end goal instead of a tiny one-step request
- it makes the autonomous expectation explicit with `keep going until it's done`
- it gives the runtime a concrete destination and review handoff
- the runtime should use the relevant Markdown generation guidance, then execute normal governed
  file, preview, and verification actions

### Skill-guided static site creation

```text
/auto create a static HTML site at C:\Users\<you>\Desktop\sample-site for a sample service company with placeholder images. Execute now using PowerShell. Use the static-site Markdown guidance instead of a hard-coded template.
```

Why it works:
- it names the target format and destination
- it keeps content generation in the model-guided path
- it still requires normal write, open, and verification actions to pass runtime checks

### Natural clarification answer

```text
BigBrain, create a landing page with a hero and call to action.
Build it now.
```

Why it works:
- the first turn is naturally ambiguous enough that the runtime can ask whether to plan first or
  build now
- the second turn is a direct clarification answer, not a brand-new task
- it keeps the approval and execution boundary readable for a normal human conversation

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

## 6) Obsidian Projection Tooling

These are operator commands, not normal conversation commands. Use them when you want to inspect
the external mirror or apply pending review actions.

### Rebuild the Obsidian mirror

```bash
npm run projection:export:obsidian
```

Use this when:
- you want a clean rebuild from canonical runtime state
- you are validating the vault schema
- you want recovery after the mirror fell behind

### Apply review-action notes

```bash
npm run projection:apply-review-actions
```

Use this when:
- you have pending notes under `AgentBigBrain/40 Review Actions/`
- you want those structured corrections to flow back through the canonical runtime mutation seams

### Open the dashboard in Obsidian

```bash
npm run projection:open:obsidian
```

Open a specific mirrored note by exact path:

```bash
npm run projection:open:obsidian -- "C:\Users\<you>\Documents\ObsidianVault\AgentBigBrain\10 Entities\person_owen.md"
```

Why these commands exist:
- they keep rebuild, write-back, and navigation deterministic
- they avoid turning Obsidian into the source of truth
- they make the projection seam usable without requiring custom Obsidian plugin code

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

### Review what is ready from a saved checkpoint

```text
Show me the rough draft.
What did you get done while I was away?
Show me what is ready to review.
```

Why it works:
- these prompts are meant for a chat that already has a real saved checkpoint or return handoff
- they should pull from the saved work summary instead of queueing a brand-new job
- the reply should stay human and review-oriented, not dump raw runtime internals

### Ask what to review first or next

```text
What should I look at first?
What should I review next from that draft?
What should I look at after that?
```

Why it works:
- the runtime can answer from the saved preview URL, primary artifact, and changed files
- these are normal human review prompts, not special debugger syntax
- they help the user re-enter the work without restating the whole task

### Resume saved work naturally

```text
Pick that back up and keep going from where you left off.
Resume that and keep going.
When you get a chance, keep refining that draft from where you left off.
```

Why it works:
- these prompts can resume from a durable saved checkpoint when the prior workspace is still known
- if the prior mode was autonomous, the runtime can continue in autonomous mode instead of falling
  back to generic chat
- the user does not need to restate the whole goal every time

### Pause and keep the checkpoint

```text
Okay, leave the rest for later.
Stop here and keep the latest checkpoint ready for me.
```

Why it works:
- it asks for a controlled pause instead of an unbounded background run
- the runtime can preserve the workspace, preview, and next suggested step for later return
- it gives the user a clean re-entry point instead of making them reconstruct the state manually

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
npm run dev -- "create a static HTML site at C:\Users\<you>\Desktop\sample-site for a sample service company with placeholder images. Show the exact approval diff before any write or shell command."
```

### Autonomous build

```bash
npm run dev -- --autonomous "create a static HTML site at C:\Users\<you>\Desktop\sample-site for a sample service company with placeholder images. Execute now using PowerShell. Create files directly; if blocked, stop and tell me exactly why."
```

### Skill workflow from CLI

```bash
npm run dev -- "create skill repo_status that reads package.json and runtime/state.json and returns a short repo summary"
npm run dev -- "run skill repo_status on this repo"
```

### Natural autonomous start from CLI

```bash
npm run dev -- --autonomous "build a small sample-company landing page on my Desktop, keep going until it is done, and leave the preview open for review"
```

### Natural return-handoff phrasing in chat

```text
/chat Show me the rough draft.
/chat What should I look at first?
/chat Pick that back up and keep going from where you left off.
/chat Okay, leave the rest for later.
```

Why it works:
- the slash command is optional here; these examples are shown with `/chat` only to make the entry
  path obvious
- the meaning comes from the saved checkpoint and current session state, not from magic keywords
- the runtime should treat them as review, resume, or pause requests instead of generic chat

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
/auto create a static HTML site at C:\Users\<you>\Desktop\sample-site for a sample service company with placeholder images. Execute now using PowerShell. Create files directly; if blocked, stop and tell me exactly why.
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
- Want to return to saved work naturally: say things like `show me the rough draft`, `what did you
  get done while I was away`, `pick that back up`, or `leave the rest for later`
- Want media to carry most of the context: screenshots and voice notes work best today; video is accepted but still relies on file metadata and captions
