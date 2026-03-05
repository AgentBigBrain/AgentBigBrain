# Full Setup Guide

This is the full operator setup for AgentBigBrain.
The README is intentionally quick-start; this document is the detailed wiring guide.

## What This Covers

- Exact environment setup flow.
- What key settings mean and when to change them.
- Where to create Telegram and Discord bots, and which values map to which env vars.
- How to verify each runtime mode.

## 1) Prerequisites

- Node.js `22.x` or newer.
- npm (uses `package-lock.json`).
- Git.

Optional by mode:

- OpenAI API key (if `BRAIN_MODEL_BACKEND=openai`).
- Local Ollama runtime (if `BRAIN_MODEL_BACKEND=ollama`).
- Telegram bot token and/or Discord bot token (if using `dev:interface`).

## 2) Install and Build

```bash
npm install
npm run build
```

## 3) Create `.env`

Bash:

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

Start with safe local defaults:

```env
BRAIN_MODEL_BACKEND=mock
BRAIN_RUNTIME_MODE=isolated
```

## 4) How Env Loading Works

AgentBigBrain loads env files through `src/core/envLoader.ts`:

- Reads `.env`, then `.env.local` (unless `BRAIN_DISABLE_DOTENV=true`).
- Load is non-destructive: if a variable is already in `process.env`, file values do not overwrite it.

Operational implication:

- Prefer setting local overrides before process start.
- If a value appears "stuck", check whether it is already set in your shell session.

## 5) Core Runtime Settings (Most Important)

| Setting | Meaning | Typical Value |
|---|---|---|
| `BRAIN_RUNTIME_MODE` | Runtime profile: `isolated` or `full_access`. | `isolated` |
| `BRAIN_ALLOW_FULL_ACCESS` | Safety latch required when using `full_access`. | `false` unless explicitly needed |
| `BRAIN_MODEL_BACKEND` | Model provider selector (`mock`, `openai`, `ollama`). | `mock` for local bring-up |
| `BRAIN_ENABLE_REAL_SHELL` | Enables real shell-command execution path. | `false` until you need live shell actions |
| `BRAIN_ENABLE_REAL_NETWORK_WRITE` | Enables real network-write side effects. | `false` by default |
| `BRAIN_MAX_ACTION_COST_USD` | Per-action estimated budget cap. | `1.25` |
| `BRAIN_MAX_CUMULATIVE_COST_USD` | Per-task cumulative action budget cap. | `10` |
| `BRAIN_MAX_MODEL_SPEND_USD` | Per-task cumulative model spend cap. | `10` |
| `BRAIN_MAX_AUTONOMOUS_ITERATIONS` | Iteration cap for autonomous loops. | `.env.example` sets `100`; code fallback is `15` if unset |

## 6) Model Backend Setup

### Mock backend (local deterministic dev)

```env
BRAIN_MODEL_BACKEND=mock
```

### OpenAI backend

```env
BRAIN_MODEL_BACKEND=openai
OPENAI_API_KEY=<your_openai_api_key>
OPENAI_TIMEOUT_MS=15000
```

Optional model routing overrides:

- `OPENAI_MODEL_SMALL_FAST`
- `OPENAI_MODEL_SMALL_POLICY`
- `OPENAI_MODEL_MEDIUM_GENERAL`
- `OPENAI_MODEL_MEDIUM_POLICY`
- `OPENAI_MODEL_LARGE_REASONING`

### Ollama backend (local provider)

```env
BRAIN_MODEL_BACKEND=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_TIMEOUT_MS=60000
```

## 7) Install ONNX Embedding Assets

Semantic memory embeddings use local ONNX artifacts (`all-MiniLM-L6-v2`).
The installer command is defined in `package.json` as `setup:embeddings`.

Install:

```bash
npm run setup:embeddings
```

Optional:

```bash
npm run setup:embeddings -- --dir models/all-MiniLM-L6-v2 --force
```

Expected files:

- `models/all-MiniLM-L6-v2/model.onnx`
- `models/all-MiniLM-L6-v2/tokenizer.json`

If you intentionally run without embeddings:

```env
BRAIN_ENABLE_EMBEDDINGS=false
```

## 8) Telegram Setup (Where and What to Configure)

Official references:

- https://core.telegram.org/bots
- https://core.telegram.org/bots/api
- https://core.telegram.org/bots/tutorial

### A) Create bot and token (Telegram side)

1. Open Telegram and message `@BotFather`.
2. Run `/newbot` and complete name + username prompts.
3. Copy the bot token from BotFather.

This token maps to:

```env
TELEGRAM_BOT_TOKEN=<botfather_token>
```

### B) Find your chat ID (optional but recommended allowlist)

1. Send a message to your bot (for example `/start`).
2. Query updates:

```bash
curl -sS "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates"
```

3. Read `message.chat.id` from the payload.

This maps to:

```env
TELEGRAM_ALLOWED_CHAT_IDS=<chat_id_1,chat_id_2>
```

### C) Interface runtime settings for Telegram

Required:

```env
BRAIN_INTERFACE_PROVIDER=telegram
BRAIN_INTERFACE_SHARED_SECRET=<long_random_secret>
BRAIN_INTERFACE_ALLOWED_USERNAMES=<telegram_username_without_at>
TELEGRAM_BOT_TOKEN=<botfather_token>
```

Username format note:

- `BRAIN_INTERFACE_ALLOWED_USERNAMES` is normalized by runtime to lowercase with any leading `@` removed.

Useful optional controls:

```env
TELEGRAM_POLL_TIMEOUT_SECONDS=25
TELEGRAM_POLL_INTERVAL_MS=500
TELEGRAM_STREAMING_TRANSPORT_MODE=edit
```

`TELEGRAM_STREAMING_TRANSPORT_MODE`:

- `edit`: edits a single progress message (default).
- `native_draft`: Telegram draft transport (kept for compatibility; disabled in non-private chats by runtime policy).

### D) Run and verify Telegram interface

```bash
npm run dev:interface
```

Expected:

- Startup succeeds with no missing-env error.
- Sending a message from an allowlisted username routes to orchestrator execution.

## 9) Discord Setup (Where and What to Configure)

Official references:

- https://docs.discord.com/developers/quick-start/getting-started
- https://discord.com/developers/applications
- https://docs.discord.com/developers/events/gateway
- https://docs.discord.com/developers/topics/oauth2
- https://docs.discord.com/developers/topics/permissions
- https://support.discord.com/hc/en-us/articles/206346498

### A) Create application and bot (Discord side)

1. Open Discord Developer Portal.
2. Create an application.
3. Add a bot user under the Bot section.
4. Reset/copy bot token.

This maps to:

```env
DISCORD_BOT_TOKEN=<discord_bot_token>
```

### B) Enable required gateway intent

In the Bot settings, enable Message Content Intent.

Why: the runtime reads inbound message text; without this, guild message content may be unavailable.

### C) Invite bot to server

In OAuth2 URL generator:

- Scopes: `bot`
- Permissions: message read/send needed for your channel policy

Authorize against your target server.

### D) Get target channel IDs (optional strict allowlist)

1. Enable Developer Mode in Discord.
2. Right-click channel -> Copy Channel ID.

This maps to:

```env
DISCORD_ALLOWED_CHANNEL_IDS=<channel_id_1,channel_id_2>
```

### E) Interface runtime settings for Discord

Required:

```env
BRAIN_INTERFACE_PROVIDER=discord
BRAIN_INTERFACE_SHARED_SECRET=<long_random_secret>
BRAIN_INTERFACE_ALLOWED_USERNAMES=<discord_username>
DISCORD_BOT_TOKEN=<discord_bot_token>
```

Username format note:

- `BRAIN_INTERFACE_ALLOWED_USERNAMES` is normalized by runtime to lowercase with any leading `@` removed.
- Practical input format: use your plain username text (no `@`), lowercase recommended.

Optional:

```env
DISCORD_GATEWAY_INTENTS=37377
DISCORD_ALLOWED_CHANNEL_IDS=<channel_ids>
```

### F) Run and verify Discord interface

```bash
npm run dev:interface
```

Expected:

- Startup succeeds with no missing-env error.
- Messages from allowlisted usernames route to governed execution.

## 10) Shared Interface Settings Explained

These apply to Telegram, Discord, or both.

| Setting | Required | Meaning |
|---|---|---|
| `BRAIN_INTERFACE_PROVIDER` | Yes | `telegram`, `discord`, `both`, or `telegram,discord`. |
| `BRAIN_INTERFACE_SHARED_SECRET` | Yes | Ingress auth secret used by interface adapters. |
| `BRAIN_INTERFACE_ALLOWED_USERNAMES` | Yes | Comma list of allowed usernames. Normalized lowercase, `@` ignored. |
| `BRAIN_INTERFACE_ALLOWED_USER_IDS` | No | Optional stricter ID-level allowlist. |
| `BRAIN_INTERFACE_REQUIRE_NAME_CALL` | No | Requires explicit agent name mention to process input. |
| `BRAIN_INTERFACE_NAME_ALIASES` | No | Allowed aliases when name-call is required (default includes `BigBrain`). |
| `BRAIN_INTERFACE_RATE_LIMIT_WINDOW_MS` | No | Rate-limit window size. |
| `BRAIN_INTERFACE_RATE_LIMIT_MAX_EVENTS` | No | Max inbound events per window per identity bucket. |
| `BRAIN_INTERFACE_REPLAY_CACHE_SIZE` | No | Event dedupe cache size. |
| `BRAIN_INTERFACE_ACK_DELAY_MS` | No | Queue ack delay; bounded `250..3000`. |
| `BRAIN_INTERFACE_SHOW_TECHNICAL_SUMMARY` | No | Include technical status details in user-facing replies. |
| `BRAIN_INTERFACE_SHOW_SAFETY_CODES` | No | Show policy/safety codes in blocked outputs. |
| `BRAIN_INTERFACE_SHOW_COMPLETION_PREFIX` | No | Prefix final completion text. |
| `BRAIN_ALLOW_AUTONOMOUS_VIA_INTERFACE` | No | Allows interface-origin autonomous execution requests. |
| `BRAIN_ENABLE_DYNAMIC_PULSE` | No | Enables dynamic pulse behavior in interface runtime. |

## 11) `.env` Profiles You Can Copy

### Telegram-only profile

```env
BRAIN_MODEL_BACKEND=mock
BRAIN_RUNTIME_MODE=isolated
BRAIN_INTERFACE_PROVIDER=telegram
BRAIN_INTERFACE_SHARED_SECRET=<long_random_secret>
BRAIN_INTERFACE_ALLOWED_USERNAMES=<your_telegram_username>
TELEGRAM_BOT_TOKEN=<botfather_token>
```

### Discord-only profile

```env
BRAIN_MODEL_BACKEND=mock
BRAIN_RUNTIME_MODE=isolated
BRAIN_INTERFACE_PROVIDER=discord
BRAIN_INTERFACE_SHARED_SECRET=<long_random_secret>
BRAIN_INTERFACE_ALLOWED_USERNAMES=<your_discord_username>
DISCORD_BOT_TOKEN=<discord_bot_token>
```

### Dual-provider profile

```env
BRAIN_MODEL_BACKEND=mock
BRAIN_RUNTIME_MODE=isolated
BRAIN_INTERFACE_PROVIDER=both
BRAIN_INTERFACE_SHARED_SECRET=<long_random_secret>
BRAIN_INTERFACE_ALLOWED_USERNAMES=<username_1,username_2>
TELEGRAM_BOT_TOKEN=<botfather_token>
DISCORD_BOT_TOKEN=<discord_bot_token>
```

Generate a strong shared secret quickly:

PowerShell:

```powershell
[Convert]::ToHexString([byte[]](1..32 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))
```

Node:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## 12) Runtime Modes

Single governed task:

```bash
npm run dev -- "summarize current repo status"
```

Bounded autonomous loop:

```bash
npm run dev -- --autonomous "stabilize runtime wiring plan"
```

Autonomous iteration cap guidance:

- `BRAIN_MAX_AUTONOMOUS_ITERATIONS` controls `--autonomous` loop length.
- If you copy `.env.example`, it is set to `100`.
- If you do not set it at all, code fallback default is `15`.
- Set `BRAIN_MAX_AUTONOMOUS_ITERATIONS=-1` (or `0`) for unbounded autonomous iteration cap.
- In unbounded mode, the loop can still stop due to goal completion, safety/governance outcomes, zero-progress guard, errors, or manual cancellation (`Ctrl+C`).

Daemon mode (fail-closed latches required):

```env
BRAIN_ALLOW_DAEMON_MODE=true
BRAIN_MAX_AUTONOMOUS_ITERATIONS=100
BRAIN_MAX_DAEMON_GOAL_ROLLOVERS=1
```

Daemon-specific rule:

- `--daemon` requires `BRAIN_MAX_AUTONOMOUS_ITERATIONS > 0`. `-1` is rejected in daemon mode by design.

Run daemon:

```bash
npm run dev -- --daemon "continuous mission objective"
```

## 13) Federation Runtime (Inbound)

Enable and configure contracts:

```env
BRAIN_ENABLE_FEDERATION_RUNTIME=true
BRAIN_FEDERATION_CONTRACTS_JSON=[{"externalAgentId":"partner_agent","sharedSecretHash":"<sha256_hex_64>","maxQuotedCostUsd":5}]
```

`sharedSecretHash` must be a SHA-256 hex digest of the raw shared secret (not the raw secret string).

Node one-liner to generate it:

```bash
node -e "const crypto=require('node:crypto');console.log(crypto.createHash('sha256').update('<your_raw_secret>').digest('hex'))"
```

Optional server config:

```env
BRAIN_FEDERATION_HOST=127.0.0.1
BRAIN_FEDERATION_PORT=9100
```

Run:

```bash
npm run dev:federation
```

Health check:

```bash
curl -sS http://127.0.0.1:9100/federation/health
```

## 14) Outbound Federation (Optional)

```env
BRAIN_ENABLE_OUTBOUND_FEDERATION=true
BRAIN_FEDERATION_OUTBOUND_TARGETS_JSON=[{"agentId":"partner_agent","baseUrl":"http://127.0.0.1:9100","sharedSecret":"<shared_secret>","maxQuoteUsd":5}]
```

Delegation trigger format is explicit-intent only:

```text
[federate:<agentId> quote=<usd>] <delegated user input>
```

## 15) Validation Checklist

Run before relying on a setup:

```bash
npm run build
npm test
npm run check:docs
npm run audit:governors
npm run audit:claims
```

Recommended smoke checks:

```bash
npm run test:federation:live_smoke
npm run test:daemon:live_smoke
npm run test:runtime_wiring:integrated_live_smoke
```

## 16) Runtime Data Locations

- `runtime/state.json` (run/task state)
- `runtime/semantic_memory.json` (semantic memory lessons)
- `runtime/governance_memory.json` (append-only governance outcomes)
- `runtime/vectors.sqlite` (embedding vector index)
- `runtime/ledgers.sqlite` (sqlite ledger backend)
- `runtime/entity_graph.json` (entity-relationship graph parity artifact)
- `runtime/runtime_trace.jsonl` (trace log when `BRAIN_TRACE_LOG_ENABLED=true`)
- `runtime/profile_memory.secure.json` (encrypted profile store when profile memory is enabled)
- `runtime/federated_results.json` (federation result persistence default path)
- `runtime/execution_receipts.json` (tamper-evident execution receipt chain JSON backend/parity export)
- `runtime/personality_profile.json` (personality profile + reward history)
- `runtime/memory_access_log.json` (memory-access audit events)
- `runtime/interface_sessions.json` (interface session persistence in JSON mode)
- `runtime/workflow_learning.json` (workflow adaptation store in JSON mode)
- `runtime/judgment_patterns.json` (judgment-pattern store in JSON mode)
- `runtime/distiller_rejection_ledger.json` (distiller merge rejection ledger in JSON mode)
- `runtime/stage6_86_runtime_state.json` (Stage 6.86 runtime state JSON mode)
- `runtime/skills/` (created/promoted runtime skills)

## 17) Complete `.env.example` Reference

This section covers every key currently present in `.env.example` and what to expect if you change it.

### Model backend and provider routing

- `BRAIN_MODEL_BACKEND`: selects provider path.
  - `mock`: deterministic local model responses, no external provider call.
  - `openai`: runtime uses OpenAI path and requires `OPENAI_API_KEY`.
  - `ollama`: runtime uses local Ollama endpoint and model mapping.
- `OPENAI_API_KEY`: credential for OpenAI calls.
  - Missing/blank with `BRAIN_MODEL_BACKEND=openai` causes startup/runtime failure for provider calls.
- `OPENAI_BASE_URL` (optional, commented in template): OpenAI endpoint override.
  - Change only if you intentionally route to a compatible proxy/service.
- `OPENAI_TIMEOUT_MS`: client timeout for OpenAI requests.
  - Higher value tolerates slower responses but increases wait time on hangs.
  - Lower value fails faster on latency spikes/timeouts.
- `OPENAI_MODEL_SMALL_FAST`, `OPENAI_MODEL_SMALL_POLICY`, `OPENAI_MODEL_MEDIUM_GENERAL`, `OPENAI_MODEL_MEDIUM_POLICY`, `OPENAI_MODEL_LARGE_REASONING`: alias-to-provider model mapping.
  - Changing these remaps which provider model each runtime role uses.
- `OPENAI_PRICE_INPUT_PER_1M_USD`, `OPENAI_PRICE_OUTPUT_PER_1M_USD`: spend-estimation rates.
  - Changing affects budget accounting/telemetry only, not provider billing.

### Runtime mode and safety latches

- `BRAIN_RUNTIME_MODE`: execution profile.
  - `isolated`: stricter side-effect posture.
  - `full_access`: broader side-effect permissions, but only valid with explicit latch.
- `BRAIN_ALLOW_FULL_ACCESS`: acknowledgement latch for `full_access`.
  - If `false` while `BRAIN_RUNTIME_MODE=full_access`, runtime fails closed.
- `BRAIN_ENABLE_REAL_SHELL`: allows real shell execution path.
  - `false`: shell is simulated/blocked per policy path.
  - `true`: shell actions can execute for approved actions, still constrained/governed.
- `BRAIN_ENABLE_REAL_NETWORK_WRITE`: allows real network-write side effects.
  - `false`: no real network write execution.
  - `true`: approved network-write actions can execute.
- `BRAIN_ALLOW_DAEMON_MODE`: daemon safety latch.
  - Must be `true` for `--daemon` runs.

### Budget and delegation limits

- `BRAIN_MAX_ACTION_COST_USD`: per-action cost ceiling.
  - Lower blocks expensive actions earlier.
  - Higher permits more expensive actions before hard-constraint block.
- `BRAIN_MAX_CUMULATIVE_COST_USD`: per-task cumulative action-cost ceiling.
  - Lower value ends/blocks long expensive runs sooner.
- `BRAIN_MAX_MODEL_SPEND_USD`: per-task model spend ceiling.
  - Lower value constrains LLM-heavy tasks.
- `BRAIN_MAX_SUBAGENTS_PER_TASK`: max satellite/subagent count.
  - Lower value reduces parallel delegation breadth.
- `BRAIN_MAX_SUBAGENT_DEPTH`: max delegation depth.
  - `1` limits delegation chains to one level.
- `BRAIN_MAX_AUTONOMOUS_ITERATIONS`: max loop iterations in autonomous runs.
- If unset, code fallback default is `15`.
- `.env.example` sets it to `100` for longer autonomous runs unless you lower it.
- `-1` or `0` means unbounded iteration cap for `--autonomous`.
- For `--daemon`, this value must be `> 0` or startup fails closed.
- Lower value stops long loops earlier.

### Shell runtime behavior

- `BRAIN_SHELL_PROFILE`: command execution profile (`cmd`, `pwsh`, `powershell`, `bash`, `wsl_bash`, etc.).
  - Changing alters how commands are wrapped/invoked.
- `BRAIN_SHELL_TIMEOUT_MS`: default shell timeout.
  - Lower value interrupts long-running commands sooner.
  - Higher value allows longer command completion windows.
- `BRAIN_SHELL_COMMAND_MAX_CHARS`: max shell command length.
  - Lower value blocks large payload commands sooner.
- `BRAIN_SHELL_ENV_MODE`: environment-pass strategy (`allowlist` or `passthrough`).
  - `allowlist` limits exposed env vars to approved keys.
  - `passthrough` allows broader env propagation to child process.
- `BRAIN_SHELL_ENV_ALLOWLIST`: env keys allowed when allowlist mode is active.
  - Add keys to make them visible to shell commands.
- `BRAIN_SHELL_ENV_DENYLIST`: token fragments to always block from shell env pass-through.
  - Add sensitive tokens to prevent accidental leakage.
- `BRAIN_SHELL_ALLOW_EXECUTION_POLICY_BYPASS`: PowerShell execution-policy bypass toggle.
  - `true` can improve script execution compatibility but weakens host policy enforcement.
- `BRAIN_SHELL_CWD_POLICY_DENY_OUTSIDE_SANDBOX`: cwd boundary enforcement.
  - `true` blocks shell cwd outside sandbox boundaries.
  - `false` allows broader cwd targets.
- `BRAIN_SHELL_CWD_POLICY_ALLOW_RELATIVE`: relative cwd handling.
  - `false` requires explicit absolute/normalized paths.

### Profile memory and pulse behavior

- `BRAIN_PROFILE_MEMORY_ENABLED`: encrypted profile-memory subsystem toggle.
  - `false`: no profile-memory enrichment path.
  - `true`: profile memory path is active and must decrypt/read cleanly.
- `BRAIN_PROFILE_ENCRYPTION_KEY`: encryption key for profile memory.
  - Invalid/missing key with enabled profile memory causes protected-memory path failures/degraded behavior.
- `BRAIN_PROFILE_MEMORY_PATH`: encrypted store location.
  - Change to relocate profile memory storage.
- `BRAIN_PROFILE_STALE_AFTER_DAYS`: freshness threshold.
  - Lower value marks facts stale sooner.
- `BRAIN_AGENT_PULSE_ENABLED`: enables pulse evaluation in core config.
  - `false`: no proactive pulse behavior from pulse policy engine.
- `BRAIN_AGENT_PULSE_TZ_OFFSET_MINUTES`: timezone offset used for quiet-hour/min-interval evaluation.
  - Change to align pulse scheduling with user local time.
- `BRAIN_AGENT_PULSE_QUIET_START_HOUR`, `BRAIN_AGENT_PULSE_QUIET_END_HOUR`: quiet-hours window.
  - Expanding the window suppresses more pulse events.
- `BRAIN_AGENT_PULSE_MIN_INTERVAL_MINUTES`: minimum gap between pulses.
  - Higher value reduces proactive frequency.
- `BRAIN_AGENT_PULSE_TICK_INTERVAL_MS`: scheduler tick interval.
  - Lower value checks pulse conditions more frequently.
- `BRAIN_ENABLE_DYNAMIC_PULSE`: enables dynamic pulse runtime flow.
  - `false`: dynamic pulse execution paths stay off.

### Reflection, embeddings, and persistence

- `BRAIN_REFLECT_ON_SUCCESS`: success-path reflection toggle.
  - Code fallback default is `false` when unset.
  - `.env.example` currently sets this to `true`.
  - `false`: only blocked-action reflection is stored.
  - `true`: successful runs can also produce lessons.
- `BRAIN_ENABLE_EMBEDDINGS`: vector embedding subsystem toggle.
  - `false`: semantic embedding retrieval disabled.
- `BRAIN_EMBEDDING_MODEL_DIR`: ONNX model/tokenizer directory.
  - Change if you installed embeddings in a non-default location.
- `BRAIN_VECTOR_SQLITE_PATH`: vector store SQLite path.
  - Change to move vector DB file location.
- `BRAIN_LEDGER_BACKEND`: ledger storage backend (`json` or `sqlite`).
  - `json`: JSON file stores only.
  - `sqlite`: SQLite stores (with optional JSON parity export).
- `BRAIN_LEDGER_SQLITE_PATH`: SQLite ledger file path.
  - Change to relocate ledger DB.
- `BRAIN_LEDGER_EXPORT_JSON_ON_WRITE`: JSON parity snapshot toggle when sqlite backend is active.
  - `false` reduces extra file writes.
- `BRAIN_TRACE_LOG_ENABLED`: runtime trace logging toggle.
  - `true` writes structured trace events.
- `BRAIN_TRACE_LOG_PATH`: trace log output path.
  - Change to relocate JSONL trace artifact.

### Interface runtime shared settings

- `BRAIN_INTERFACE_PROVIDER`: interface provider selection.
  - `telegram`, `discord`, or `both`/`telegram,discord`.
  - Controls which adapter(s) runtime starts.
- `BRAIN_INTERFACE_SHARED_SECRET`: ingress auth secret for adapter message trust boundary.
  - Missing value fails startup.
- `BRAIN_INTERFACE_ALLOWED_USERNAMES`: username allowlist (required).
  - Only matching normalized usernames are accepted.
- `BRAIN_INTERFACE_ALLOWED_USER_IDS`: optional stricter ID allowlist.
  - If set, non-listed user IDs are rejected even if username matches.
- `BRAIN_INTERFACE_REQUIRE_NAME_CALL`: explicit invocation requirement.
  - `true` requires alias mention before processing.
- `BRAIN_INTERFACE_NAME_ALIASES`: accepted invocation aliases.
  - Add aliases to expand valid name-call triggers.
- `BRAIN_INTERFACE_SHOW_TECHNICAL_SUMMARY`: include technical execution summaries in user replies.
  - `false` produces cleaner non-technical output.
- `BRAIN_INTERFACE_SHOW_SAFETY_CODES`: include safety/policy code lines.
  - `false` keeps refusals shorter.
- `BRAIN_INTERFACE_SHOW_COMPLETION_PREFIX`: adds completion prefix (for example `Done.`) when enabled.
- `BRAIN_INTERFACE_RATE_LIMIT_WINDOW_MS`: ingress rate-limit window size.
  - Larger window smooths bursts over longer period.
- `BRAIN_INTERFACE_RATE_LIMIT_MAX_EVENTS`: max accepted events per window.
  - Lower value throttles faster.
- `BRAIN_INTERFACE_REPLAY_CACHE_SIZE`: dedupe memory size for replay defense.
  - Larger value tracks more message IDs before eviction.
- `BRAIN_ALLOW_AUTONOMOUS_VIA_INTERFACE`: allows interface-triggered autonomous behaviors.
  - `false` blocks interface-driven autonomous entrypoints.

### Telegram-specific interface settings

- `TELEGRAM_STREAMING_TRANSPORT_MODE`: streaming transport mode.
  - `edit`: progress via message edits.
  - `native_draft`: draft transport path (legacy/compatibility mode).
- `TELEGRAM_NATIVE_DRAFT_STREAMING`: legacy compatibility toggle.
  - Used only when explicit transport mode is not set.
- `TELEGRAM_BOT_TOKEN`: Telegram bot credential.
  - Required when provider includes Telegram.
- `TELEGRAM_ALLOWED_CHAT_IDS`: optional chat allowlist.
  - If set, only listed chats are accepted.
- `TELEGRAM_POLL_TIMEOUT_SECONDS`: long-poll timeout.
  - Higher value reduces request churn; lower value returns control sooner.
- `TELEGRAM_POLL_INTERVAL_MS`: delay between poll cycles.
  - Lower value can reduce update latency at cost of more API calls.

### Discord-specific interface settings

- `DISCORD_BOT_TOKEN`: Discord bot credential.
  - Required when provider includes Discord.
- `DISCORD_ALLOWED_CHANNEL_IDS`: optional channel allowlist.
  - If set, only listed channels are accepted.
- `DISCORD_GATEWAY_INTENTS`: gateway intent bitmask.
  - Changing this changes which event/message types Discord delivers to the bot.

### Additional supported env vars (in code, not currently in `.env.example`)

- `BRAIN_DISABLE_DOTENV`: disables `.env`/`.env.local` loading when set truthy.
- `BRAIN_USER_PROTECTED_PATHS`: semicolon-separated owner-protected path prefixes; malformed entries fail closed.
- `BRAIN_SHELL_EXECUTABLE`: explicit shell executable override for runtime shell profile resolution.
- `BRAIN_SHELL_WSL_DISTRO`: optional distro selector when using `wsl_bash`.
- `BRAIN_AGENT_PULSE_TIMEZONE_OFFSET_MINUTES`: legacy alias for pulse timezone offset.
- `BRAIN_INTERFACE_ACK_DELAY_MS`: queue acknowledgement delay (`250..3000` enforced).
- `BRAIN_INTERFACE_FOLLOW_UP_OVERRIDE_PATH`: path to follow-up classifier override file.
- `BRAIN_INTERFACE_PULSE_LEXICAL_OVERRIDE_PATH`: path to pulse lexical override file.
- `BRAIN_INTERFACE_DEBUG`: enables extra Discord gateway debug logs when exactly `true`.
- `TELEGRAM_API_BASE_URL`: Telegram API base URL override.
- `DISCORD_API_BASE_URL`: Discord REST API base URL override.
- `DISCORD_GATEWAY_URL`: Discord gateway discovery URL override.
- `BRAIN_FEDERATION_MAX_BODY_BYTES`: inbound federated request body cap.
- `BRAIN_FEDERATION_RESULT_TTL_MS`: federation result retention TTL.
- `BRAIN_FEDERATION_EVICTION_INTERVAL_MS`: cleanup sweep interval for federated result cache.
- `BRAIN_FEDERATION_RESULT_STORE_PATH`: federation result persistence path override.
- `OPENAI_PRICE_SMALL_FAST_INPUT_PER_1M_USD`, `OPENAI_PRICE_SMALL_FAST_OUTPUT_PER_1M_USD`: alias-specific pricing for `small-fast-model`.
- `OPENAI_PRICE_SMALL_POLICY_INPUT_PER_1M_USD`, `OPENAI_PRICE_SMALL_POLICY_OUTPUT_PER_1M_USD`: alias-specific pricing for `small-policy-model`.
- `OPENAI_PRICE_MEDIUM_GENERAL_INPUT_PER_1M_USD`, `OPENAI_PRICE_MEDIUM_GENERAL_OUTPUT_PER_1M_USD`: alias-specific pricing for `medium-general-model`.
- `OPENAI_PRICE_MEDIUM_POLICY_INPUT_PER_1M_USD`, `OPENAI_PRICE_MEDIUM_POLICY_OUTPUT_PER_1M_USD`: alias-specific pricing for `medium-policy-model`.
- `OPENAI_PRICE_LARGE_REASONING_INPUT_PER_1M_USD`, `OPENAI_PRICE_LARGE_REASONING_OUTPUT_PER_1M_USD`: alias-specific pricing for `large-reasoning-model`.
- `BRAIN_TRACE_AUDIT_OUTPUT_PATH`: output path override for `npm run audit:traces`.

## 18) Troubleshooting

`OPENAI_API_KEY` missing:

- Set `OPENAI_API_KEY`, or switch to `BRAIN_MODEL_BACKEND=mock`.

Full-access startup blocked:

- `BRAIN_RUNTIME_MODE=full_access` also requires `BRAIN_ALLOW_FULL_ACCESS=true`.

Daemon exits immediately:

- Ensure daemon latches are set and `BRAIN_MAX_DAEMON_GOAL_ROLLOVERS > 0`.

Embeddings do not initialize:

- Re-run `npm run setup:embeddings -- --force`.
- Confirm `model.onnx` and `tokenizer.json` in `BRAIN_EMBEDDING_MODEL_DIR`.
- Temporarily set `BRAIN_ENABLE_EMBEDDINGS=false` if needed.

Interface startup fails:

- Verify `BRAIN_INTERFACE_PROVIDER`, `BRAIN_INTERFACE_SHARED_SECRET`,
  `BRAIN_INTERFACE_ALLOWED_USERNAMES`, and token(s) (`TELEGRAM_BOT_TOKEN` / `DISCORD_BOT_TOKEN`).

Telegram bot receives no updates:

- Confirm bot token is valid and bot has a recent message in chat (`/start`).
- If using `TELEGRAM_ALLOWED_CHAT_IDS`, confirm the current chat ID is included.

Discord messages are empty or missing:

- Enable Message Content Intent in Discord Developer Portal.
- Confirm bot is invited to the target server and channel permissions allow read/send.

Federation startup fails:

- Verify `BRAIN_ENABLE_FEDERATION_RUNTIME=true` and valid non-empty `BRAIN_FEDERATION_CONTRACTS_JSON`.
