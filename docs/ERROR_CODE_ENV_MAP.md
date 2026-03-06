# Error Code to Environment Mapping

This page maps common runtime error/block/reason codes to the `.env` settings that influence them.

Use this when you see:

- `blockedBy` codes in technical summaries,
- `violations.code` in traces/state artifacts,
- autonomous stop reasons like `[reasonCode=...]`.

## How to Read This

- If a code has env knobs, change those values in `.env` and restart the runtime.
- If a code has no env knobs, fix the request/action payload or policy path.
- Some codes are hard-constraint blocks (before governance), others are autonomous-loop stop reasons.

## High-Signal Mapping

| Code | Meaning | Primary env knobs | Typical fix |
|---|---|---|---|
| `GLOBAL_DEADLINE_EXCEEDED` | Task action loop exceeded per-turn deadline; remaining actions blocked in that task. | `BRAIN_PER_TURN_DEADLINE_MS` | Increase deadline for heavy build/scaffold runs (for example `120000`). |
| `MODEL_SPEND_LIMIT_EXCEEDED` | Per-task model spend cap exceeded. | `BRAIN_MAX_MODEL_SPEND_USD`, `OPENAI_PRICE_*`, `BRAIN_MODEL_BACKEND` | Raise spend cap or lower model pricing estimates/routing. |
| `COST_LIMIT_EXCEEDED` | One action's deterministic estimated cost exceeds per-action cap. | `BRAIN_MAX_ACTION_COST_USD` | Raise cap or reduce high-cost action planning. |
| `CUMULATIVE_COST_LIMIT_EXCEEDED` | Projected cumulative action cost exceeds task cap. | `BRAIN_MAX_CUMULATIVE_COST_USD` | Raise cumulative cap or split task into smaller runs. |
| `AUTONOMOUS_MAX_ITERATIONS_REACHED` | Autonomous loop hit iteration cap. | `BRAIN_MAX_AUTONOMOUS_ITERATIONS` | Increase cap, or use `-1`/`0` for unbounded `--autonomous`. |
| `AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT` | Execution-style mission had too many consecutive no-progress iterations. | `BRAIN_AUTONOMOUS_MAX_CONSECUTIVE_NO_PROGRESS`, `BRAIN_ENABLE_REAL_SHELL`, `BRAIN_RUNTIME_MODE`, `BRAIN_ALLOW_FULL_ACCESS` | Increase stall threshold and/or enable runtime profile that can execute requested side effects. |
| `AUTONOMOUS_EXECUTION_STYLE_TARGET_PATH_EVIDENCE_REQUIRED` | Goal completion was deferred because approved real side effects did not touch the explicit target path in the mission goal. | none (prompt/evidence contract) | Keep target path explicit and require execution in that path; avoid silent path drift. |
| `AUTONOMOUS_EXECUTION_STYLE_MUTATION_EVIDENCE_REQUIRED` | Goal completion was deferred because mission asked for customization/editing but required typed mutation evidence is missing. Shell-command text is intentionally excluded from mutation proof. | none (prompt/evidence contract) | Ensure at least one typed mutation action executes (`write_file`, `delete_file`, `self_modify`, `memory_mutation`, `network_write`, `create_skill`, `run_skill`). |
| `AUTONOMOUS_TASK_EXECUTION_FAILED` | Iteration failed before completion (for example provider timeout/exception). | `OPENAI_TIMEOUT_MS`, `OLLAMA_TIMEOUT_MS`, `BRAIN_MODEL_BACKEND` | Increase provider timeout or switch backend while diagnosing provider latency. |
| `AUTONOMOUS_LOOP_RUNTIME_ERROR` | Adapter-level fallback reason when autonomous loop throws unexpectedly. | `OPENAI_TIMEOUT_MS`, `OLLAMA_TIMEOUT_MS`, `BRAIN_MODEL_BACKEND` | Same as above; treat as runtime/provider failure path. |
| `SHELL_DISABLED_BY_POLICY` | `shell_command` actions denied by runtime profile policy. | `BRAIN_RUNTIME_MODE`, `BRAIN_ALLOW_FULL_ACCESS`, `BRAIN_ENABLE_REAL_SHELL` | Use `full_access` with explicit acknowledgment and enable real shell if intended. |
| `SHELL_PROFILE_MISMATCH` | Requested shell kind does not match resolved runtime shell profile. | `BRAIN_SHELL_PROFILE`, `BRAIN_SHELL_EXECUTABLE`, `BRAIN_SHELL_WSL_DISTRO` | Align requested shell and runtime shell profile. |
| `SHELL_COMMAND_TOO_LONG` | Shell command exceeded command-length bound. | `BRAIN_SHELL_COMMAND_MAX_CHARS` | Raise bound or break command into smaller steps. |
| `SHELL_TIMEOUT_INVALID` | Requested per-action shell timeout invalid for configured bounds. | `BRAIN_SHELL_TIMEOUT_MS` | Keep requested timeout in configured allowed range. |
| `SHELL_CWD_OUTSIDE_SANDBOX` | Shell cwd policy denied requested cwd. | `BRAIN_SHELL_CWD_POLICY_DENY_OUTSIDE_SANDBOX`, `BRAIN_SHELL_CWD_POLICY_ALLOW_RELATIVE` | Relax cwd policy only if intentional and safe. |
| `NETWORK_WRITE_DISABLED` | `network_write` action denied by runtime profile policy. | `BRAIN_RUNTIME_MODE`, `BRAIN_ALLOW_FULL_ACCESS`, `BRAIN_ENABLE_REAL_NETWORK_WRITE` | Use `full_access` profile and enable real network write if intended. |
| `WRITE_PROTECTED_PATH` / `READ_PROTECTED_PATH` / `DELETE_PROTECTED_PATH` / `LIST_PROTECTED_PATH` | Path intersects protected path list. | `BRAIN_USER_PROTECTED_PATHS` | Remove/adjust protected prefixes only if policy permits. |
| `DELETE_OUTSIDE_SANDBOX` / `LIST_OUTSIDE_SANDBOX` | Sandbox boundary enforcement denied path. | `BRAIN_RUNTIME_MODE`, `BRAIN_ALLOW_FULL_ACCESS` | Use a profile where sandbox list/delete enforcement matches your use case. |

## Timeout and Deadline Distinction

- `OpenAI request timed out after <n>ms` is provider timeout (`OPENAI_TIMEOUT_MS`).
- `GLOBAL_DEADLINE_EXCEEDED` is task action-loop deadline (`BRAIN_PER_TURN_DEADLINE_MS`).

A run can hit both in different phases.

## Example Tuning Block for Heavy `/auto` Builds

```env
OPENAI_TIMEOUT_MS=45000
BRAIN_PER_TURN_DEADLINE_MS=120000
BRAIN_AUTONOMOUS_MAX_CONSECUTIVE_NO_PROGRESS=10
```

If shell/network side effects are expected:

```env
BRAIN_RUNTIME_MODE=full_access
BRAIN_ALLOW_FULL_ACCESS=true
BRAIN_ENABLE_REAL_SHELL=true
BRAIN_ENABLE_REAL_NETWORK_WRITE=true
```

## Codes With No `.env` Knob

Some codes are deterministic payload/policy failures and are not env-tunable, for example:

- `RUN_SKILL_MISSING_NAME`
- `RUN_SKILL_INVALID_NAME`
- `RUN_SKILL_ARTIFACT_MISSING`
- `RUN_SKILL_INVALID_EXPORT`
- `RUN_SKILL_LOAD_FAILED`
- `ACTION_EXECUTION_FAILED`

For these, fix request shape, skill artifact/export correctness, or runtime code path rather than env.
