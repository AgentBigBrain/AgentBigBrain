# Error Code to Environment Map

This page helps operators answer one practical question:

**When the runtime blocks, stalls, or stops, which settings can actually change the outcome?**

Not every code has an environment-variable fix. Some codes mean:

- change a timeout or budget
- enable a runtime capability
- install a local dependency
- rewrite the request
- or accept that the policy is intentionally hard-coded

For setup and full environment wiring, use [docs/SETUP.md](SETUP.md).

## 1) How To Use This Page

- If a code has environment knobs, change those in `.env` and restart the runtime.
- If a code has **no environment knob**, fix the request, action payload, artifact, or policy path.
- If a code is an autonomous stop reason, remember that it may describe the loop state, not a
  single tool failure.

## 2) Common Runtime and Autonomous Codes

| Code | What it means in plain language | Primary env knobs | Typical operator fix |
|---|---|---|---|
| `GLOBAL_DEADLINE_EXCEEDED` | One governed task ran out of per-turn time before the remaining actions could finish. | `BRAIN_PER_TURN_DEADLINE_MS` | Raise the per-turn deadline for heavier build or verification flows. |
| `MODEL_SPEND_LIMIT_EXCEEDED` | The task exhausted its allowed model-spend budget. | `BRAIN_MAX_MODEL_SPEND_USD`, `OPENAI_PRICE_*`, `BRAIN_MODEL_BACKEND` | Raise the spend cap, adjust pricing estimates, or route to a cheaper backend. |
| `COST_LIMIT_EXCEEDED` | A single proposed action exceeded the allowed per-action cost ceiling. | `BRAIN_MAX_ACTION_COST_USD` | Raise the cap or narrow the requested action. |
| `CUMULATIVE_COST_LIMIT_EXCEEDED` | The task’s projected total action cost exceeded the cumulative ceiling. | `BRAIN_MAX_CUMULATIVE_COST_USD` | Raise the cumulative cap or split the work into smaller runs. |
| `AUTONOMOUS_MAX_ITERATIONS_REACHED` | The autonomous loop hit its iteration cap before finishing. | `BRAIN_MAX_AUTONOMOUS_ITERATIONS` | Raise the cap, or use `-1` / `0` for unbounded `--autonomous`. |
| `AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT` | The loop kept making no real execution progress for too many iterations. | `BRAIN_AUTONOMOUS_MAX_CONSECUTIVE_NO_PROGRESS`, `BRAIN_RUNTIME_MODE`, `BRAIN_ALLOW_FULL_ACCESS`, `BRAIN_ENABLE_REAL_SHELL` | Increase the stall threshold or enable the runtime profile needed for the requested side effects. |
| `AUTONOMOUS_EXECUTION_STYLE_TARGET_PATH_EVIDENCE_REQUIRED` | The goal named a target path, but approved side effects never actually touched that path. | none | Keep the target path explicit and make sure the execution path really writes there. |
| `AUTONOMOUS_EXECUTION_STYLE_MUTATION_EVIDENCE_REQUIRED` | The mission asked for a real modification, but no approved typed mutation action happened. | none | Ensure the run includes a real mutation action like `write_file`, `delete_file`, `create_skill`, `run_skill`, or `memory_mutation`. |
| `AUTONOMOUS_EXECUTION_STYLE_PROCESS_NEVER_READY` | A managed process started but never became HTTP-ready for the required localhost proof. | none | Fix the app/server startup path, wrong port, or readiness logic; this is usually not an env issue. |
| `AUTONOMOUS_EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED` | The environment blocked the remaining localhost or browser-proof steps required for a truthful live verification. | `BRAIN_RUNTIME_MODE`, `BRAIN_ALLOW_FULL_ACCESS`, `BRAIN_ENABLE_REAL_SHELL` | Use a runtime profile that actually allows the live verification path, or rerun in a less restricted environment. |
| `AUTONOMOUS_TASK_EXECUTION_FAILED` | One autonomous iteration failed before it could complete cleanly. | `OPENAI_TIMEOUT_MS`, `OLLAMA_TIMEOUT_MS`, `BRAIN_MODEL_BACKEND` | Increase provider timeout or switch backend while diagnosing latency or provider failures. |
| `AUTONOMOUS_LOOP_RUNTIME_ERROR` | The loop hit an unexpected runtime-level failure path. | `OPENAI_TIMEOUT_MS`, `OLLAMA_TIMEOUT_MS`, `BRAIN_MODEL_BACKEND` | Treat it like a runtime/provider failure first, then inspect task traces. |
| `SHELL_DISABLED_BY_POLICY` | The runtime profile does not currently allow `shell_command`. | `BRAIN_RUNTIME_MODE`, `BRAIN_ALLOW_FULL_ACCESS`, `BRAIN_ENABLE_REAL_SHELL` | Use `full_access` with its latch and enable real shell execution. |
| `SHELL_PROFILE_MISMATCH` | The request asked for a shell kind that does not match the configured runtime shell profile. | `BRAIN_SHELL_PROFILE`, `BRAIN_SHELL_EXECUTABLE`, `BRAIN_SHELL_WSL_DISTRO` | Align the requested shell with the actual runtime shell profile. |
| `SHELL_COMMAND_TOO_LONG` | The proposed shell command exceeded the configured command-length bound. | `BRAIN_SHELL_COMMAND_MAX_CHARS` | Raise the bound or break the command into smaller steps. |
| `SHELL_TIMEOUT_INVALID` | The requested shell timeout was outside the allowed range. | `BRAIN_SHELL_TIMEOUT_MS` | Keep the request within the configured timeout policy. |
| `SHELL_CWD_OUTSIDE_SANDBOX` | The requested shell working directory violates the cwd policy. | `BRAIN_SHELL_CWD_POLICY_DENY_OUTSIDE_SANDBOX`, `BRAIN_SHELL_CWD_POLICY_ALLOW_RELATIVE` | Relax the cwd policy only if that broader access is intentional. |
| `NETWORK_WRITE_DISABLED` | The runtime profile does not currently allow real network-write side effects. | `BRAIN_RUNTIME_MODE`, `BRAIN_ALLOW_FULL_ACCESS`, `BRAIN_ENABLE_REAL_NETWORK_WRITE` | Enable the real network-write path or rerun in a profile that allows it. |
| `BROWSER_VERIFY_RUNTIME_UNAVAILABLE` | Browser proof was requested, but the local Playwright runtime is not installed or not usable. | none | Install local Playwright and browser binaries, or rerun without claiming browser proof. |
| `RUN_SKILL_ARTIFACT_MISSING` | The runtime could not find the skill artifact it was asked to run. | none | Fix the skill name, build/promote the skill artifact, or recreate it. |

## 3) Protected Path and Sandbox Codes

These are usually policy or target-path problems, not model problems.

| Code | Meaning | Primary env knobs | Typical operator fix |
|---|---|---|---|
| `WRITE_PROTECTED_PATH` | The write target hit a protected path prefix. | `BRAIN_USER_PROTECTED_PATHS` | Adjust the protected-path list only if policy allows it. |
| `READ_PROTECTED_PATH` | The read target hit a protected path prefix. | `BRAIN_USER_PROTECTED_PATHS` | Same as above. |
| `DELETE_PROTECTED_PATH` | The delete target hit a protected path prefix. | `BRAIN_USER_PROTECTED_PATHS` | Same as above. |
| `LIST_PROTECTED_PATH` | The list target hit a protected path prefix. | `BRAIN_USER_PROTECTED_PATHS` | Same as above. |
| `DELETE_OUTSIDE_SANDBOX` | The delete target fell outside the allowed sandbox boundary. | `BRAIN_RUNTIME_MODE`, `BRAIN_ALLOW_FULL_ACCESS` | Use a runtime profile that matches the intended path scope. |
| `LIST_OUTSIDE_SANDBOX` | The list target fell outside the allowed sandbox boundary. | `BRAIN_RUNTIME_MODE`, `BRAIN_ALLOW_FULL_ACCESS` | Same as above. |

## 4) Timeout and Dependency Distinctions

These are easy to confuse:

- `OpenAI request timed out after <n>ms`
  - provider timeout
  - controlled by `OPENAI_TIMEOUT_MS`

- `GLOBAL_DEADLINE_EXCEEDED`
  - governed task deadline
  - controlled by `BRAIN_PER_TURN_DEADLINE_MS`

- `BROWSER_VERIFY_RUNTIME_UNAVAILABLE`
  - local browser runtime problem
  - **not** fixed by a timeout or budget env var

## 5) Media Interpretation Reality Check

Not every media issue shows up as a dedicated reason code. Some of the most common operator questions are really capability-limit questions.

- `The screenshot reply is generic and does not seem to use OCR or visual detail.`
  - likely causes:
    - `OPENAI_API_KEY` missing
    - `BRAIN_MEDIA_VISION_MODEL` unset or mapped to a non-vision-capable model
    - provider timeout/failure causing a simple fallback summary
  - relevant env:
    - `OPENAI_API_KEY`
    - `BRAIN_MEDIA_VISION_MODEL`
    - `OPENAI_MODEL_SMALL_FAST`
    - `BRAIN_MEDIA_REQUEST_TIMEOUT_MS`

- `The voice note was accepted, but the reply says transcription is unavailable.`
  - likely causes:
    - `OPENAI_API_KEY` missing
    - transcription path unavailable
    - provider timeout/failure causing a simple fallback summary
  - relevant env:
    - `OPENAI_API_KEY`
    - `BRAIN_MEDIA_TRANSCRIPTION_MODEL`
    - `BRAIN_MEDIA_REQUEST_TIMEOUT_MS`

- `The short video only produced a simple summary or metadata-style description.`
  - this is the expected current behavior
  - there is no env knob today that enables full semantic video understanding
  - the runtime currently uses file metadata and captions for video instead of full clip analysis

## 6) Example Tuning Blocks

### Heavier autonomous build and verification runs

```env
OPENAI_TIMEOUT_MS=45000
BRAIN_PER_TURN_DEADLINE_MS=120000
BRAIN_AUTONOMOUS_MAX_CONSECUTIVE_NO_PROGRESS=10
```

### Real shell and network side effects

```env
BRAIN_RUNTIME_MODE=full_access
BRAIN_ALLOW_FULL_ACCESS=true
BRAIN_ENABLE_REAL_SHELL=true
BRAIN_ENABLE_REAL_NETWORK_WRITE=true
```

### More permissive long autonomous runs

```env
BRAIN_MAX_AUTONOMOUS_ITERATIONS=100
BRAIN_MAX_MODEL_SPEND_USD=20
BRAIN_MAX_CUMULATIVE_COST_USD=20
```

## 7) Codes With No `.env` Knob

These are mostly request-shape, artifact, or deterministic-policy issues. Changing `.env` will not
help:

- `RUN_SKILL_MISSING_NAME`
- `RUN_SKILL_INVALID_NAME`
- `RUN_SKILL_ARTIFACT_MISSING`
- `RUN_SKILL_INVALID_EXPORT`
- `RUN_SKILL_LOAD_FAILED`
- `ACTION_EXECUTION_FAILED`
- `AUTONOMOUS_EXECUTION_STYLE_TARGET_PATH_EVIDENCE_REQUIRED`
- `AUTONOMOUS_EXECUTION_STYLE_MUTATION_EVIDENCE_REQUIRED`

For these, fix the request, the artifact, or the runtime path itself.

## 8) Practical Rule

If you are not sure whether the code is env-tunable:

- budget, timeout, iteration, shell, network, and interface-provider problems often are
- artifact shape, target-path truthfulness, skill correctness, and browser-runtime installation
  problems usually are not
