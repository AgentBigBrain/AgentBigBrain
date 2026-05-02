# Full Setup Guide

This is the detailed operator setup for AgentBigBrain.

The main [README](../README.md) is the quick-start path. This document is the fuller reference for
environment wiring, interface bring-up, live verification, and operator validation.

For runtime troubleshooting by error/reason code, see:
- [docs/ERROR_CODE_ENV_MAP.md](ERROR_CODE_ENV_MAP.md)

## What This Covers

- how to bring the runtime up safely
- which environment settings matter most
- how Telegram and Discord values map to `.env`
- how to verify that the runtime is actually working, not just starting

## 1) Prerequisites

- Node.js `22.x` or newer.
- npm (uses `package-lock.json`).
- Git.

Optional by mode:

- OpenAI API key (if `BRAIN_MODEL_BACKEND=openai_api`).
- Local Codex auth state plus Codex CLI (if `BRAIN_MODEL_BACKEND=codex_oauth`).
- Local Ollama runtime (if `BRAIN_MODEL_BACKEND=ollama` or
  `BRAIN_LOCAL_INTENT_MODEL_ENABLED=true`).
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
| `BRAIN_MODEL_BACKEND` | Model provider selector (`mock`, `openai_api`, `codex_oauth`, `ollama`). | `mock` for local bring-up |
| `BRAIN_LOCAL_INTENT_MODEL_ENABLED` | Enables the optional bounded local intent-model classifier for front-door routing. | `false` by default |
| `BRAIN_ENABLE_REAL_SHELL` | Enables real shell-command execution path. | `false` until you need live shell actions |
| `BRAIN_ENABLE_REAL_NETWORK_WRITE` | Enables real network-write side effects. | `false` by default |
| `BRAIN_BROWSER_VERIFY_VISIBLE` | Shows a real local Chromium window during `verify_browser` instead of headless proof. | `false` by default |
| `BRAIN_MAX_ACTION_COST_USD` | Per-action estimated budget cap. | `1.25` |
| `BRAIN_MAX_CUMULATIVE_COST_USD` | Per-task cumulative action budget cap. | `10` |
| `BRAIN_MAX_MODEL_SPEND_USD` | Per-task cumulative model spend cap. | `10` |
| `BRAIN_MAX_NON_API_MODEL_CALLS_PER_TASK` | Per-task model-call cap for non-API backends like `codex_oauth` and `ollama`. | `250` |
| `BRAIN_MAX_AUTONOMOUS_ITERATIONS` | Iteration cap for autonomous loops. | `.env.example` sets `100`; code fallback is `15` if unset |
| `BRAIN_AUTONOMOUS_MAX_CONSECUTIVE_NO_PROGRESS` | Consecutive zero-progress iterations allowed before autonomous stall-abort. | `3` |
| `BRAIN_PER_TURN_DEADLINE_MS` | Per-task action-loop deadline before `GLOBAL_DEADLINE_EXCEEDED` blocks remaining actions. | `.env.example` sets `120000`; code fallback is `20000` if unset |

### Local Browser Verification Visibility

`verify_browser` uses local Playwright Chromium. By default it runs headless, so the proof is real even if no window appears.

To watch the browser locally:

```env
BRAIN_BROWSER_VERIFY_VISIBLE=true
```

Equivalent explicit headless override:

```env
BRAIN_BROWSER_VERIFY_HEADLESS=false
```

This setting is shared by the governed runtime, so it applies to CLI autonomous runs and interface-driven autonomous runs alike.

## 6) Model Backend Setup

### Mock backend (local deterministic dev)

```env
BRAIN_MODEL_BACKEND=mock
```

### OpenAI API backend

```env
BRAIN_MODEL_BACKEND=openai_api
OPENAI_API_KEY=<your_openai_api_key>
OPENAI_TIMEOUT_MS=300000
OPENAI_TRANSPORT_MODE=auto
```

Alias note:

- `BRAIN_MODEL_BACKEND=openai` maps to `openai_api`.

### Codex OAuth backend

```env
BRAIN_MODEL_BACKEND=codex_oauth
CODEX_TIMEOUT_MS=180000
CODEX_MODEL_SMALL_FAST=gpt-5.4-mini
CODEX_MODEL_SMALL_POLICY=gpt-5.4-mini
CODEX_MODEL_MEDIUM_GENERAL=gpt-5.4-mini
CODEX_MODEL_MEDIUM_POLICY=gpt-5.4-mini
CODEX_MODEL_LARGE_REASONING=gpt-5.4
```

Owner-facing setup commands:

```bash
npm run dev -- auth codex status
npm run dev -- auth codex login
npm run dev -- auth codex logout
```

Optional overrides:

- `CODEX_AUTH_STATE_DIR`: alternate Codex auth-state root
- `CODEX_CLI_PATH`: explicit Codex CLI path
- `CODEX_TIMEOUT_MS`: Codex request timeout override
- `CODEX_MODEL_*`: backend-specific role mappings

### Media understanding (images, voice notes, documents, and short video)

The runtime can ingest Telegram screenshots, voice notes, documents, and short videos, but the
interpretation quality depends on the configured media path.

- Media no longer has to stay on a separate OpenAI-only path. By default it can inherit the main
  text backend, or you can split vision and transcription by modality.
- Images can use `openai_api`, `codex_oauth`, or `ollama`, depending on your media backend
  settings and model support.
- Voice notes can use a dedicated transcription model such as `whisper-1`, or a multimodal
  audio-capable model path when the selected backend supports it.
- Documents expose extracted text as source-labeled layers. Optional model-assisted document
  meaning is disabled by default and remains candidate-only when enabled.
- Video is accepted as input, but the runtime only produces simple metadata and caption summaries.
  It does not claim full video understanding.

Truthfulness rule:

- if provider-backed media understanding is unavailable, the runtime falls back to a simple summary
- it does not invent OCR text, transcripts, or detailed video semantics it cannot prove

Recommended media env block for inherited media routing:

```env
BRAIN_MEDIA_BACKEND=inherit_text_backend
BRAIN_MEDIA_VISION_BACKEND=inherit_text_backend
BRAIN_MEDIA_TRANSCRIPTION_BACKEND=inherit_text_backend
BRAIN_MEDIA_DOCUMENT_MEANING_BACKEND=disabled
BRAIN_MEDIA_VISION_MODEL=gpt-5.4-mini
BRAIN_MEDIA_TRANSCRIPTION_MODEL=whisper-1
BRAIN_MEDIA_REQUEST_TIMEOUT_MS=45000
```

Example split-modality block:

```env
BRAIN_MEDIA_BACKEND=inherit_text_backend
BRAIN_MEDIA_VISION_BACKEND=codex_oauth
BRAIN_MEDIA_TRANSCRIPTION_BACKEND=openai_api
BRAIN_MEDIA_DOCUMENT_MEANING_BACKEND=disabled
BRAIN_MEDIA_VISION_MODEL=gpt-5.4-mini
BRAIN_MEDIA_TRANSCRIPTION_MODEL=whisper-1
BRAIN_MEDIA_REQUEST_TIMEOUT_MS=45000
```

How each setting works:

- `BRAIN_MEDIA_BACKEND`: default media backend for all modalities. Supported values are
  `inherit_text_backend`, `openai_api`, `codex_oauth`, `ollama`, `mock`, and `disabled`.
- `BRAIN_MEDIA_VISION_BACKEND`: optional override just for screenshots and other images. If unset,
  it falls back to `BRAIN_MEDIA_BACKEND`.
- `BRAIN_MEDIA_TRANSCRIPTION_BACKEND`: optional override just for voice-note transcription. If
  unset, it falls back to `BRAIN_MEDIA_BACKEND`.
- `BRAIN_MEDIA_DOCUMENT_MEANING_BACKEND`: optional override for model-assisted document meaning.
  Default is `disabled`; keep it disabled unless you explicitly want candidate-only semantic
  summaries for documents.
- `BRAIN_MEDIA_DOCUMENT_MEANING_MODEL`: model used when document meaning is enabled.
- `BRAIN_MEDIA_DOCUMENT_MEANING_TIMEOUT_MS`: timeout for model-assisted document meaning.
- `BRAIN_MEDIA_VISION_MODEL`: vision-capable model for screenshots/images. If unset, the runtime falls back to `OPENAI_MODEL_SMALL_FAST`, then `OLLAMA_MODEL_SMALL_FAST` / `OLLAMA_MODEL_DEFAULT`, then `gpt-4.1-mini`.
- `BRAIN_MEDIA_TRANSCRIPTION_MODEL`: transcription model for voice notes. If unset, the runtime defaults to `whisper-1`. Dedicated models such as `whisper-1` stay on `/audio/transcriptions`; non-whisper models such as Gemma 4 automatically use the multimodal audio-understanding path instead.
- `BRAIN_MEDIA_REQUEST_TIMEOUT_MS`: timeout used by the image/transcription calls.

Operational notes:

- screenshots can produce OCR/summary style context when the vision path is available
- voice notes can produce transcript-backed context when the transcription path is available
- document text/model meaning is passed as layered context with memory authority labels; raw
  document/model-derived meaning stays candidate-only
- `BRAIN_MEDIA_BACKEND=inherit_text_backend` means media follows the main text backend unless a
  modality override says otherwise
- `BRAIN_MEDIA_BACKEND=disabled` skips provider-backed media understanding and falls back to simple
  summaries only
- `BRAIN_MEDIA_BACKEND=codex_oauth` reuses the operator's Codex credential ephemerally at request
  time instead of storing a second media-specific token
- `BRAIN_MEDIA_VISION_BACKEND=ollama` supports local image understanding directly.
- `BRAIN_MEDIA_TRANSCRIPTION_BACKEND=ollama` is still experimental for local
  multimodal-audio models such as Gemma 4. The runtime can target Ollama's OpenAI-compatible
  `/v1/responses` surface, but real audio support depends on the exact Ollama build and model
  packaging. Do not treat it as the default voice-note path.
- `BRAIN_MEDIA_TRANSCRIPTION_BACKEND=openai_api` still works for other loopback
  OpenAI-compatible servers; when the base URL is local, the media runtime does not require an API
  key just to attach audio for transcription.
- if your Ollama endpoint is behind an API-key gate, the runtime also honors `OLLAMA_API_KEY`
- short videos use file metadata and captions even when an API key is configured

Video limitation:

- the runtime does not have a dedicated clip-analysis path
- video interpretation is limited to file metadata and captions

Optional model routing overrides:

- `OPENAI_MODEL_SMALL_FAST`
- `OPENAI_MODEL_SMALL_POLICY`
- `OPENAI_MODEL_MEDIUM_GENERAL`
- `OPENAI_MODEL_MEDIUM_POLICY`
- `OPENAI_MODEL_LARGE_REASONING`

Recommended cross-family routing for broad OpenAI coverage:

```env
OPENAI_MODEL_SMALL_FAST=gpt-4.1-mini
OPENAI_MODEL_SMALL_POLICY=gpt-4.1-mini
OPENAI_MODEL_MEDIUM_GENERAL=gpt-4.1
OPENAI_MODEL_MEDIUM_POLICY=gpt-4.1-mini
OPENAI_MODEL_LARGE_REASONING=gpt-5.3-codex
```

OpenAI transport notes:

- The runtime supports both Chat Completions and Responses transports.
- `OPENAI_TRANSPORT_MODE=auto` selects the preferred transport for the resolved model family.
- `OPENAI_TRANSPORT_MODE=chat_completions` or `responses` forces one transport for compatibility
  testing.
- `OPENAI_COMPATIBILITY_STRICT=false` allows lowest-common-denominator transport selection for
  unknown model ids instead of failing closed immediately.
- `OPENAI_ALLOW_JSON_OBJECT_COMPAT_FALLBACK=true` enables one deterministic compatibility retry from
  strict schema mode to `json_object` mode when the provider rejects strict structured output.
- Verified live-smoke coverage includes the GPT-4.1 and GPT-5.x API families,
  including `gpt-4.1-mini`, `gpt-4.1`, `gpt-5`, `gpt-5.1`,
  `gpt-5.2`, and `gpt-5.3-codex`.
- Recommended starting point for real autonomous work is:
  - `OPENAI_TIMEOUT_MS=300000`
  - `OPENAI_TRANSPORT_MODE=auto`
  - `OPENAI_MODEL_SMALL_FAST=gpt-4.1-mini`
  - `OPENAI_MODEL_SMALL_POLICY=gpt-4.1-mini`
  - `OPENAI_MODEL_MEDIUM_GENERAL=gpt-4.1`
  - `OPENAI_MODEL_MEDIUM_POLICY=gpt-4.1-mini`
  - `OPENAI_MODEL_LARGE_REASONING=gpt-5.3-codex`
- This mix keeps fast control/policy work on the cheaper GPT-4.1 path while giving harder planning
  and repair loops a stronger GPT-5-family model.
- The live smoke uses `gpt-4.1-mini` for fast/policy control roles and swaps the model under test
  into `medium-general` and `large-reasoning`. Use `--role-mode=all_roles_under_test` only if you
  intentionally want the harsh "every runtime role uses the same provider model" variant.
- Verified live-smoke matrix:
  - `gpt-4.1-mini`
  - `gpt-4.1`
  - `gpt-5`
  - `gpt-5.1`
  - `gpt-5.2`
  - `gpt-5.3-codex`
- Full range smoke command:

```bash
OPENAI_MULTI_MODEL_LIVE_SMOKE_CONFIRM=true npm run test:openai:multi_model_live_smoke -- --all
```

### Ollama backend (local provider)

```env
BRAIN_MODEL_BACKEND=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_TIMEOUT_MS=60000
```

### Optional local intent engine (Ollama-backed)

This helper is optional.

It adds a small local model that helps the assistant interpret natural phrasing at the front door.
This is useful for messages like `pick that back up`, `show me the rough draft`, or other natural
follow-up wording.

It does not replace your main planner model, and it cannot approve actions on its own. The normal
safety checks and execution rules still decide what is allowed to run.

You can enable it even when `BRAIN_MODEL_BACKEND=openai_api` or `BRAIN_MODEL_BACKEND=codex_oauth`.

1. Install and run Ollama locally.
2. Pull the preferred Gemma 4 model:

```bash
ollama pull gemma4
```

3. Add the local intent block:

```env
BRAIN_LOCAL_INTENT_MODEL_ENABLED=true
BRAIN_LOCAL_INTENT_MODEL_PROVIDER=ollama
BRAIN_LOCAL_INTENT_MODEL_BASE_URL=http://127.0.0.1:11434
BRAIN_LOCAL_INTENT_MODEL_NAME=gemma4:latest
BRAIN_LOCAL_INTENT_MODEL_TIMEOUT_MS=45000
BRAIN_LOCAL_INTENT_MODEL_LIVE_SMOKE_REQUIRED=false
```

How each setting works:

- `BRAIN_LOCAL_INTENT_MODEL_ENABLED`: turns this helper on.
- `BRAIN_LOCAL_INTENT_MODEL_PROVIDER`: which local provider to use. This must be `ollama`.
- `BRAIN_LOCAL_INTENT_MODEL_BASE_URL`: where Ollama is running.
- `BRAIN_LOCAL_INTENT_MODEL_NAME`: which local model tag to use. The default is `gemma4:latest`.
- `BRAIN_LOCAL_INTENT_MODEL_TIMEOUT_MS`: how long to wait before giving up and falling back.
- `BRAIN_LOCAL_INTENT_MODEL_LIVE_SMOKE_REQUIRED`: when `true`, related live smokes fail if this helper was expected but not reachable.

What to expect:

- the runtime checks whether this local model is reachable and logs the result
- if it is unavailable, the system falls back to the normal routing path
- this helper only helps interpret the request; it does not grant permission to write files, run commands, or bypass safety rules

## 7) Install ONNX Embedding Assets

Semantic memory embeddings use local ONNX artifacts (`all-MiniLM-L6-v2`).
The installer command is defined in `package.json` as `setup:embeddings`.

Install:

```bash
npm run setup:embeddings
```

Apple Silicon note:
- if the machine is an M-series Mac but Node is running as `darwin/x64` under Rosetta, `onnxruntime-node` can fail before embeddings initialize
- use a native arm64 Node install, remove `node_modules`, and run `npm install` again from that arm64 shell
- as a temporary workaround, set `BRAIN_ENABLE_EMBEDDINGS=false` to disable local vector embeddings and keep the runtime on keyword-only retrieval

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

### B) Find your Telegram username, user ID, and chat ID

1. Make sure your Telegram account has a username set in Telegram settings.
2. Send a message to your bot (for example `/start`).
3. Query updates:

```bash
curl -sS "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates"
```

4. Read these fields from the payload:

- `message.from.username` -> `BRAIN_INTERFACE_ALLOWED_USERNAMES`
- `message.from.id` -> `BRAIN_INTERFACE_ALLOWED_USER_IDS`
- `message.chat.id` -> `TELEGRAM_ALLOWED_CHAT_IDS`

Practical notes:

- `BRAIN_INTERFACE_ALLOWED_USERNAMES` is required, so if `message.from.username` is blank you need to create a Telegram username first.
- `BRAIN_INTERFACE_ALLOWED_USER_IDS` is optional stricter filtering. Most first-time setups can leave it blank, confirm the bot responds, then add it later.
- `TELEGRAM_ALLOWED_CHAT_IDS` is also optional. Add it if you want the bot restricted to specific chats.

This maps to:

```env
BRAIN_INTERFACE_ALLOWED_USERNAMES=<telegram_username_without_at>
BRAIN_INTERFACE_ALLOWED_USER_IDS=<telegram_user_id>
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

Optional stricter Telegram allowlists:

```env
BRAIN_INTERFACE_ALLOWED_USER_IDS=<telegram_user_id>
TELEGRAM_ALLOWED_CHAT_IDS=<chat_id_1,chat_id_2>
```

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

### D) Find your Discord username, user ID, and channel ID

1. Enable Developer Mode in Discord.
2. Use your Discord account username for `BRAIN_INTERFACE_ALLOWED_USERNAMES`.
3. Right-click your user in Discord -> Copy User ID.
4. Right-click channel -> Copy Channel ID.

Practical notes:

- Use your account username, not a server nickname or display name. The runtime validates against Discord `author.username`.
- `BRAIN_INTERFACE_ALLOWED_USER_IDS` is optional stricter filtering. Most first-time setups can leave it blank, confirm the bot responds, then add it later.

This maps to:

```env
BRAIN_INTERFACE_ALLOWED_USERNAMES=<discord_username>
BRAIN_INTERFACE_ALLOWED_USER_IDS=<discord_user_id>
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
BRAIN_INTERFACE_ALLOWED_USER_IDS=<discord_user_id>
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

## 10) Interface Identity Lookup Cheat Sheet

Use this when filling `.env` so you know exactly where each interface value comes from.

| Env var | Telegram source | Discord source |
|---|---|---|
| `BRAIN_INTERFACE_ALLOWED_USERNAMES` | `message.from.username` from `getUpdates`; create a Telegram username first if blank. | Your account username. Do not use display name or server nickname. |
| `BRAIN_INTERFACE_ALLOWED_USER_IDS` | `message.from.id` from `getUpdates`. | Enable Developer Mode, then right-click your user and copy User ID. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | `message.chat.id` from `getUpdates` after messaging the bot. | n/a |
| `DISCORD_ALLOWED_CHANNEL_IDS` | n/a | Enable Developer Mode, then right-click the target channel and copy Channel ID. |
| `TELEGRAM_BOT_TOKEN` | BotFather `/newbot` output. | n/a |
| `DISCORD_BOT_TOKEN` | n/a | Discord Developer Portal -> Bot -> Reset/Copy Token. |

Bring-up recommendation:

- Start with `BRAIN_INTERFACE_ALLOWED_USERNAMES` plus the provider bot token.
- Leave `BRAIN_INTERFACE_ALLOWED_USER_IDS`, `TELEGRAM_ALLOWED_CHAT_IDS`, and `DISCORD_ALLOWED_CHANNEL_IDS` empty until the bot responds once.
- After initial success, add the stricter ID/chat/channel allowlists if you want tighter ingress control.

## 11) Shared Interface Settings Explained

These apply to Telegram, Discord, or both.

| Setting | Required | Meaning |
|---|---|---|
| `BRAIN_INTERFACE_PROVIDER` | Yes | `telegram`, `discord`, `both`, or `telegram,discord`. |
| `BRAIN_INTERFACE_SHARED_SECRET` | Yes | Ingress auth secret used by interface adapters. |
| `BRAIN_INTERFACE_ALLOWED_USERNAMES` | Yes | Comma list of allowed usernames. Normalized lowercase, `@` ignored. |
| `BRAIN_INTERFACE_ALLOWED_USER_IDS` | No | Optional stricter ID-level allowlist. Telegram: `message.from.id` from `getUpdates`. Discord: Developer Mode -> Copy User ID. |
| `BRAIN_INTERFACE_REQUIRE_NAME_CALL` | No | Requires explicit agent name mention to process input. |
| `BRAIN_INTERFACE_NAME_ALIASES` | No | Allowed aliases when name-call is required (default includes `BigBrain`). |
| `BRAIN_INTERFACE_RATE_LIMIT_WINDOW_MS` | No | Rate-limit window size. |
| `BRAIN_INTERFACE_RATE_LIMIT_MAX_EVENTS` | No | Max inbound events per window per identity bucket. |
| `BRAIN_INTERFACE_REPLAY_CACHE_SIZE` | No | Event dedupe cache size. |
| `BRAIN_INTERFACE_ACK_DELAY_MS` | No | Queue ack delay; bounded `250..3000`. |
| `BRAIN_INTERFACE_SHOW_TECHNICAL_SUMMARY` | No | Include technical status details in user-facing replies. Default is off so normal chat stays human-first. |
| `BRAIN_INTERFACE_SHOW_SAFETY_CODES` | No | Show policy/safety codes in blocked outputs. Default follows the technical-summary flag. |
| `BRAIN_INTERFACE_SHOW_COMPLETION_PREFIX` | No | Prefix final completion text. |
| `BRAIN_ALLOW_AUTONOMOUS_VIA_INTERFACE` | No | Allows interface-origin autonomous execution requests. |
| `BRAIN_ENABLE_DYNAMIC_PULSE` | No | Enables dynamic pulse behavior in interface runtime. |

## 12) `.env` Profiles You Can Copy

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

Important continuity note:

- `BRAIN_INTERFACE_PROVIDER=both` gives you one shared interface runtime and one shared
  orchestrator/session stack.
- It does **not** automatically give Telegram and Discord shared long-lived profile continuity.
- If you want cross-platform identity/profile facts to carry across both providers, also enable
  `BRAIN_PROFILE_MEMORY_ENABLED=true` and set a valid `BRAIN_PROFILE_ENCRYPTION_KEY`.

Generate a strong shared secret quickly:

PowerShell:

```powershell
[Convert]::ToHexString([byte[]](1..32 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))
```

Node:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## 12A) `/help` Command Surface Expectations

When running `npm run dev:interface`, use `/help` to view live command guidance.

Current operator contract:

- There is no separate `/skill` command.
- Use `/chat` or `/propose` with `create skill ...`, `update skill ...`, `approve skill ...`,
  `reject skill ...`, `deprecate skill ...`, or `run skill ...`.
- Agent-suggested skills are drafts until approved. Rejected or deprecated skills stay reviewable
  but are excluded from active planner guidance and executable reuse.
- `/memory` is available in private conversations for remembered-situation review and correction.
- For real side effects, say `execute now` and name your shell (`PowerShell` / `cmd` / `Terminal` / `bash` / `zsh`).
- If name-call mode is enabled, natural greeting forms like `Hi BigBrain` and `Hey BigBrain, ...`
  are accepted.
- Runtime responses should clearly indicate one state: `Executed`, `Guidance only`, or `Blocked`.
- Telegram screenshots, voice notes, and short videos are supported as media inputs with safe
  limits. Rich screenshot and voice interpretation depends on the media model settings above; video
  stays on simple fallback.

Extended prompt patterns are in `docs/COMMAND_EXAMPLES.md`.

## 13) Runtime Modes

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
- `BRAIN_AUTONOMOUS_MAX_CONSECUTIVE_NO_PROGRESS` controls how many consecutive no-progress iterations are allowed before deterministic stall-abort (default `3`).
- `BRAIN_PER_TURN_DEADLINE_MS` controls how long one task action loop can run before remaining actions are blocked with `GLOBAL_DEADLINE_EXCEEDED` (code fallback default `20000ms`).
- In unbounded mode, the loop can still stop due to goal completion, safety/governance outcomes, zero-progress guard, errors, or manual cancellation (`Ctrl+C`).
- For execution-style autonomous goals (for example build/create/write requests), completion is gated: the loop will not mark `Goal Met` until at least one approved real side-effect action executes in that mission.
- Read-only actions (`read_file`, `list_directory`) and simulated outputs are excluded from execution-style completion evidence.
- If your goal includes an explicit target path, completion also requires path-touch evidence (approved real side effect touching that path). Path drift produces `AUTONOMOUS_EXECUTION_STYLE_TARGET_PATH_EVIDENCE_REQUIRED`.
- If your goal asks for customization/editing outcomes (for example dark theme, UI components, style/content replacement), completion also requires artifact-mutation evidence from explicit typed mutation actions (`write_file`, `delete_file`, `self_modify`, `memory_mutation`, `network_write`, `create_skill`, `run_skill`). Shell-command text is not used as mutation proof. Missing evidence defers completion with `AUTONOMOUS_EXECUTION_STYLE_MUTATION_EVIDENCE_REQUIRED`.
- If execution-style iterations keep approving only `respond`, loop termination is bounded by deterministic stall-abort (`reasonCode=AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT`) rather than waiting for max-iteration exhaustion.

Daemon mode (fail-closed latches required):

```env
BRAIN_ALLOW_DAEMON_MODE=true
BRAIN_MAX_AUTONOMOUS_ITERATIONS=100
BRAIN_AUTONOMOUS_MAX_CONSECUTIVE_NO_PROGRESS=3
BRAIN_PER_TURN_DEADLINE_MS=120000
BRAIN_MAX_DAEMON_GOAL_ROLLOVERS=1
```

Daemon-specific rule:

- `--daemon` requires `BRAIN_MAX_AUTONOMOUS_ITERATIONS > 0`. `-1` is rejected in daemon mode by design.

Run daemon:

```bash
npm run dev -- --daemon "continuous mission objective"
```

Read-file output contract:

- `read_file` returns a bounded preview payload, not unbounded full-file text.
- Success output includes preview text plus deterministic metadata (`readFileTotalChars`, `readFileReturnedChars`, `readFileTruncated`) in runtime traces/receipts.
- If content exceeds the preview cap, output is explicitly marked with `[...truncated]`.

## 14) Federation Runtime (Inbound)

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

## 15) Outbound Federation (Optional)

```env
BRAIN_ENABLE_OUTBOUND_FEDERATION=true
BRAIN_FEDERATION_OUTBOUND_TARGETS_JSON=[{"agentId":"partner_agent","baseUrl":"http://127.0.0.1:9100","sharedSecret":"<shared_secret>","maxQuoteUsd":5}]
```

Delegation trigger format is explicit-intent only:

```text
[federate:<agentId> quote=<usd>] <delegated user input>
```

## 16) Validation Checklist

Run before relying on a setup:

```bash
npm run check:repo
npm run check:docs
npm run audit:governors
npm run audit:claims
```

Recommended smoke checks:

```bash
npm run test:federation:live_smoke
npm run test:daemon:live_smoke
npm run test:runtime_wiring:integrated_live_smoke
npm run test:interface:real_provider_live_smoke
npm run test:runtime:managed_process_live_smoke
npm run test:interface:advanced_live_smoke
npm run test:media_ingest_execution_intent:evidence
npm run test:media_ingest_execution_intent:live_smoke
npm run test:telegram_completion_matrix:live_smoke
npm run test:human_language_generalization:evidence
npm run test:human_language_generalization:live_smoke
```

Optional browser verification:

- `verify_browser` works only when `playwright` or `playwright-core` plus browser binaries are installed locally.
- Quick install for this workspace:
  - `npm install --no-save playwright`
  - `npx playwright install chromium`
- If you want loopback browser/UI proof, install one of those locally before running live app verification flows.
- If Playwright is not installed, the runtime fails closed with `BROWSER_VERIFY_RUNTIME_UNAVAILABLE` instead of pretending the UI was verified.

Real-provider interface smoke is fail-closed. Set `BRAIN_INTERFACE_REAL_LIVE_SMOKE_CONFIRM=true`
before running it, and ensure your provider tokens/allowlists point to intentional test destinations.

The human-language pair has two different jobs:

- `test:human_language_generalization:evidence` proves deterministic scenario coverage
- `test:human_language_generalization:live_smoke` proves the runtime can actually surface
  the intended recall/generalization behavior in a live smoke path

## 17) Runtime Data Locations

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
- `runtime/skills/` (created/promoted runtime skills; Markdown instruction skills use `.md`,
  executable skills use a `.js` primary artifact with `.ts` compatibility fallback during the
  migration window, and manifests record lifecycle/approval state)

## 18) Complete `.env.example` Reference

This section covers every key listed in `.env.example` and what to expect if you change it.

### Model backend and provider routing

- `BRAIN_MODEL_BACKEND`: selects provider path.
  - `mock`: deterministic local model responses, no external provider call.
  - `openai_api`: runtime uses the OpenAI API path and requires `OPENAI_API_KEY`.
  - `codex_oauth`: runtime uses the Codex CLI/auth path and requires valid local Codex auth state.
  - `ollama`: runtime uses local Ollama endpoint and model mapping.
  - `openai` maps to `openai_api`.
- `OPENAI_API_KEY`: credential for OpenAI calls.
  - Missing/blank with `BRAIN_MODEL_BACKEND=openai_api` causes startup/runtime failure for provider calls.
- `CODEX_AUTH_STATE_DIR`: optional override for the operator-owned Codex auth-state root.
- `CODEX_CLI_PATH`: optional explicit Codex CLI binary path.
- `CODEX_TIMEOUT_MS`: Codex backend request timeout.
- `CODEX_MODEL_SMALL_FAST`, `CODEX_MODEL_SMALL_POLICY`, `CODEX_MODEL_MEDIUM_GENERAL`, `CODEX_MODEL_MEDIUM_POLICY`, `CODEX_MODEL_LARGE_REASONING`: alias-to-provider model mapping for the Codex backend.
  - Changing these remaps which Codex-supported provider model each runtime role uses.
  - Unsupported model ids fail closed instead of being accepted silently.
- `OPENAI_BASE_URL` (optional, commented in template): OpenAI endpoint override.
  - Change only if you intentionally route to a compatible proxy/service.
- `OPENAI_TIMEOUT_MS`: client timeout for OpenAI requests.
  - Recommended guidance for GPT-4.1 through GPT-5.3 autonomous runs is `300000`.
  - `120000` can still be fine for short single-turn calls, but it is more likely to cut off slower
    GPT-5-family planning or repair turns.
  - Higher value tolerates slower responses but increases wait time on hangs.
  - Lower value fails faster on latency spikes/timeouts.
- `OPENAI_TRANSPORT_MODE`: OpenAI transport selection policy.
  - `auto`: picks the preferred transport for the resolved model family.
  - `chat_completions`: forces `/v1/chat/completions`.
  - `responses`: forces `/v1/responses`.
  - Recommended setting: `auto`.
- `OPENAI_COMPATIBILITY_STRICT`: unknown-model compatibility policy.
  - `true`: fail closed when the provider model id is not in the compatibility registry.
  - `false`: allow lowest-common-denominator transport selection for unknown models.
- `OPENAI_ALLOW_JSON_OBJECT_COMPAT_FALLBACK`: one-step structured-output compatibility retry toggle.
  - `false`: strict schema incompatibilities fail closed.
  - `true`: allows one retry in `json_object` mode when the provider rejects strict schema mode.
- `OPENAI_MODEL_SMALL_FAST`, `OPENAI_MODEL_SMALL_POLICY`, `OPENAI_MODEL_MEDIUM_GENERAL`, `OPENAI_MODEL_MEDIUM_POLICY`, `OPENAI_MODEL_LARGE_REASONING`: alias-to-provider model mapping.
  - Changing these remaps which provider model each runtime role uses.
  - Recommended broad-coverage mix: `small_fast=gpt-4.1-mini`, `small_policy=gpt-4.1-mini`,
    `medium_general=gpt-4.1`, `medium_policy=gpt-4.1-mini`, `large_reasoning=gpt-5.3-codex`.
  - Verified live-smoke coverage for the current compatibility layer: `gpt-4.1-mini`, `gpt-4.1`,
    `gpt-5`, `gpt-5.1`, `gpt-5.2`, `gpt-5.3-codex`.
- `OPENAI_PRICE_INPUT_PER_1M_USD`, `OPENAI_PRICE_OUTPUT_PER_1M_USD`: spend-estimation rates.
  - Changing affects budget accounting/telemetry only, not provider billing.

### Optional local intent engine

- `BRAIN_LOCAL_INTENT_MODEL_ENABLED`: turns the optional local intent helper on.
  - `false`: the runtime uses its normal front-door routing only.
  - `true`: the interface can ask the local helper for extra help with natural phrasing when needed.
- `BRAIN_LOCAL_INTENT_MODEL_PROVIDER`: which local provider to use.
  - The runtime supports only `ollama`.
- `BRAIN_LOCAL_INTENT_MODEL_BASE_URL`: where Ollama is running.
  - Default is `http://127.0.0.1:11434`.
- `BRAIN_LOCAL_INTENT_MODEL_NAME`: which Ollama model tag to use for this helper.
  - Default is `gemma4:latest`.
  - Pull `gemma4` in Ollama first so this tag resolves.
- `BRAIN_LOCAL_INTENT_MODEL_TIMEOUT_MS`: how long to wait before falling back.
  - Raise it if the local model is slow on the current machine.
- `BRAIN_LOCAL_INTENT_MODEL_LIVE_SMOKE_REQUIRED`: makes related live smokes fail when this helper was expected but not actually reachable.
  - Useful on machines where the local intent helper is part of the proof bar.

### Media understanding

- `BRAIN_MEDIA_VISION_MODEL`: model used for screenshot/image interpretation.
  - If unset, the runtime falls back to `OPENAI_MODEL_SMALL_FAST`, then `OLLAMA_MODEL_SMALL_FAST` / `OLLAMA_MODEL_DEFAULT`, then `gpt-4.1-mini`.
  - If the selected model is not actually vision-capable in your provider environment, image understanding falls back to a simple summary.
  - `BRAIN_MEDIA_VISION_BACKEND=ollama` is a supported local path for image-capable models such as Gemma 4.
- `BRAIN_MEDIA_TRANSCRIPTION_MODEL`: model used for voice-note transcription.
  - If unset, the runtime defaults to `whisper-1`.
  - Dedicated transcription models such as `whisper-1` stay on `/audio/transcriptions`.
  - Non-whisper models such as Gemma 4 automatically use the multimodal audio path instead.
  - If transcription is unavailable, the runtime falls back to basic media context rather than fabricating a transcript.
  - `BRAIN_MEDIA_TRANSCRIPTION_BACKEND=ollama` is experimental for local Gemma-style
    audio runs. The runtime can target Ollama's OpenAI-compatible `/v1/responses` surface, but the
    working audio capability still depends on what Ollama exposes for that specific build.
  - Do not treat it as the default local voice-note path.
  - `BRAIN_MEDIA_TRANSCRIPTION_BACKEND=openai_api` remains available for other loopback
    OpenAI-compatible servers.
  - `BRAIN_MEDIA_REQUEST_TIMEOUT_MS`: timeout for provider-backed media interpretation requests.
    - Raise it if image or transcription requests time out.
  - Lower it if you want quicker fail-closed fallback behavior.
- `BRAIN_MEDIA_DOCUMENT_MEANING_BACKEND`: backend for optional model-assisted document meaning.
  - Defaults to `disabled`.
  - Enabled outputs are candidate-only and do not become durable profile memory by themselves.
- `BRAIN_MEDIA_DOCUMENT_MEANING_MODEL`: model used for document meaning when the backend is enabled.
- `BRAIN_MEDIA_DOCUMENT_MEANING_TIMEOUT_MS`: request timeout for document meaning.

Video limitation:

- short videos can be ingested and attached to conversation context, but the runtime does not expose provider-backed video understanding
- video stays on file metadata and captions
- there is no `.env` switch that turns video into full clip-understanding behavior

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
- `BRAIN_MAX_NON_API_MODEL_CALLS_PER_TASK`: per-task model-call ceiling for non-API backends.
  - Applies when billing mode is `subscription_quota`, `local`, or another non-USD mode.
  - Lower value constrains long Codex/Ollama runs even when there is no API-dollar spend signal.
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
- `BRAIN_AUTONOMOUS_MAX_CONSECUTIVE_NO_PROGRESS`: autonomous no-progress stall threshold.
- Default is `3`; increase it to allow more retries before deterministic stall-abort.
- Lower it to fail faster when execution-style missions keep producing guidance-only/no-progress loops.
- `BRAIN_PER_TURN_DEADLINE_MS`: per-task action-loop deadline.
- Default code fallback is `20000ms`; increase it for heavy build/scaffold runs that need longer governed action sequences.
- If exceeded, remaining actions in that task are blocked with `GLOBAL_DEADLINE_EXCEEDED`.

### Shell runtime behavior

- `BRAIN_SHELL_PROFILE`: command execution profile (`cmd`, `pwsh`, `powershell`, `bash`, `zsh`, `wsl_bash`, etc.).
  - Changing alters how commands are wrapped/invoked.
  - If you want true `zsh` execution semantics, set `BRAIN_SHELL_PROFILE=zsh`. Prompt wording
    alone does not override the configured runtime shell profile.
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

Profile memory stores long-lived personal facts and situations in an encrypted local file.
Internally, the runtime uses a graph-backed model so it can track who a claim is about, when it
was observed, and whether it is current, historical, or in conflict.

Stage 6.86 handles live continuity for the current conversation. That includes the conversation
stack, entity graph, open loops, pulse state, and runtime-action continuity. When profile memory is
enabled, those Stage 6.86 flows can query the encrypted memory store for longer-lived recall and
user-reviewed continuity.

Practical guidance:

- Leave profile memory off if you want the simplest local setup and do not need cross-session
  personal continuity.
- Turn profile memory on if you want longer-lived recall, cross-platform profile continuity, and
  private `/memory` review and correction commands.
- The encrypted file still keeps `facts` and `episodes` arrays for stable read paths, but the
  internal graph is the authoritative truth surface.

- `BRAIN_PROFILE_MEMORY_ENABLED`: encrypted profile-memory subsystem toggle.
  - `false`: no profile-memory enrichment path.
  - `true`: profile memory path is active and must decrypt/read cleanly.
- `BRAIN_PROFILE_ENCRYPTION_KEY`: encryption key for profile memory.
  - Must be either 64-character hex or base64-encoded 32 bytes.
  - Invalid or missing key with enabled profile memory causes protected-memory path failures or degraded behavior.
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

Generate a valid profile-memory encryption key:

PowerShell:

```powershell
[Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Node:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

### External projection and Obsidian mirror

The projection layer mirrors canonical runtime memory into external inspection targets without
making those targets the truth owner.

Current sinks:

- `obsidian`: human-readable vault mirror with Markdown notes, `.base` files, and optional asset copies
- `json`: machine-readable mirror that helps prove the sink seam stays generic

Recommended first setup:

```env
BRAIN_PROJECTION_SINKS=obsidian
BRAIN_PROJECTION_REALTIME=true
BRAIN_PROJECTION_MODE=review_safe
BRAIN_OBSIDIAN_VAULT_PATH=C:\Users\<you>\Documents\ObsidianVault
BRAIN_OBSIDIAN_ROOT_DIR=AgentBigBrain
BRAIN_OBSIDIAN_MIRROR_ASSETS=true
```

How the main settings work:

- `BRAIN_PROJECTION_SINKS`: comma-separated sink ids.
  - Supported today: `obsidian`, `json`.
  - Leave unset to disable the projection subsystem entirely.
- `BRAIN_PROJECTION_REALTIME`: incremental sync toggle.
  - `true` updates sinks after canonical writes.
  - `false` keeps the sink available for manual rebuilds only.
- `BRAIN_PROJECTION_MODE`: mirror visibility policy.
  - `review_safe` redacts or suppresses sensitive values and assets where policy requires it.
  - `operator_full` mirrors the fuller note and asset set for explicitly trusted operators.
- `BRAIN_OBSIDIAN_VAULT_PATH`: absolute Obsidian vault root.
  - Required when `obsidian` is enabled.
- `BRAIN_OBSIDIAN_ROOT_DIR`: machine-owned folder created inside the vault.
  - Defaults to `AgentBigBrain`.
- `BRAIN_OBSIDIAN_MIRROR_ASSETS`: asset-copy toggle for raw mirrored uploads.
  - `true` copies eligible assets into the vault subtree.
  - `false` keeps the mirror note-only even when artifact records exist.
- `BRAIN_JSON_MIRROR_PATH`: output file for the optional JSON sink.

What the mirror contains:

- profile-memory entities, claims, and episodes
- Stage 6.86 continuity summaries and open loops
- governance decisions
- execution receipts
- workflow-learning summaries
- media artifact notes plus optional mirrored assets

Operator commands:

```bash
npm run projection:export:obsidian
npm run projection:apply-review-actions
npm run projection:open:obsidian
```

What each command does:

- `projection:export:obsidian`: rebuilds the mirror from canonical runtime state
- `projection:apply-review-actions`: applies pending structured review-action notes from
  `AgentBigBrain/40 Review Actions/`
- `projection:open:obsidian`: opens the dashboard or a targeted mirrored note through an exact-path
  Obsidian URI

Practical rules:

- start with `review_safe` until you are sure a fuller mirror belongs in that vault
- if the vault is cloud-synced, treat mirrored assets as a real data-exposure decision
- the first-class metadata lives on the projected Markdown notes; attachments are mirrored as assets
  plus companion notes
- when current Obsidian behavior matters, check the official docs at
  `https://docs.obsidian.md/Home`

### Reflection, embeddings, and persistence

- `BRAIN_REFLECT_ON_SUCCESS`: success-path reflection toggle.
  - Code fallback default is `false` when unset.
  - `.env.example` sets this to `true`.
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
  - Telegram value source: `message.from.id` from `getUpdates`.
  - Discord value source: Developer Mode -> right-click user -> Copy User ID.
  - If set, non-listed user IDs are rejected even if username matches.
- `BRAIN_INTERFACE_REQUIRE_NAME_CALL`: explicit invocation requirement.
  - `true` requires alias mention before processing.
- `BRAIN_INTERFACE_NAME_ALIASES`: accepted invocation aliases.
  - Add aliases to expand valid name-call triggers.
- `BRAIN_INTERFACE_SHOW_TECHNICAL_SUMMARY`: include technical execution summaries in user replies. Default is `false` so normal chat stays less technical.
  - `false` produces cleaner non-technical output.
- `BRAIN_INTERFACE_SHOW_SAFETY_CODES`: include safety/policy code lines. Default follows `BRAIN_INTERFACE_SHOW_TECHNICAL_SUMMARY`.
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
  - `native_draft`: draft transport path.
- `TELEGRAM_NATIVE_DRAFT_STREAMING`: fallback toggle.
  - Used only when explicit transport mode is not set.
- `TELEGRAM_BOT_TOKEN`: Telegram bot credential.
  - Required when provider includes Telegram.
- `TELEGRAM_ALLOWED_CHAT_IDS`: optional chat allowlist.
  - Value source: `message.chat.id` from `getUpdates` after messaging the bot.
  - If set, only listed chats are accepted.
- `TELEGRAM_POLL_TIMEOUT_SECONDS`: long-poll timeout.
  - Higher value reduces request churn; lower value returns control sooner.
- `TELEGRAM_POLL_INTERVAL_MS`: delay between poll cycles.
  - Lower value can reduce update latency at cost of more API calls.
- `TELEGRAM_MEDIA_ENABLED`: master toggle for Telegram media ingest.
  - `false` disables attachment parsing and download for Telegram ingress.
- `TELEGRAM_MAX_MEDIA_ATTACHMENTS`: max attachments accepted from one inbound Telegram message.
- `TELEGRAM_MAX_MEDIA_ATTACHMENT_BYTES`: max attachment size allowed before the runtime refuses it.
- `TELEGRAM_MAX_MEDIA_DOWNLOAD_BYTES`: max total bytes downloaded for one attachment fetch.
- `TELEGRAM_MAX_VOICE_SECONDS`: max accepted voice-note length in seconds.
- `TELEGRAM_MAX_VIDEO_SECONDS`: max accepted short-video length in seconds.
- `TELEGRAM_ALLOW_IMAGES`, `TELEGRAM_ALLOW_VOICE_NOTES`, `TELEGRAM_ALLOW_VIDEOS`,
  `TELEGRAM_ALLOW_DOCUMENTS`: per-modality allow or deny switches for Telegram ingress.

### Discord-specific interface settings

- `DISCORD_BOT_TOKEN`: Discord bot credential.
  - Required when provider includes Discord.
- `DISCORD_ALLOWED_CHANNEL_IDS`: optional channel allowlist.
  - Value source: Developer Mode -> right-click channel -> Copy Channel ID.
  - If set, only listed channels are accepted.
- `DISCORD_GATEWAY_INTENTS`: gateway intent bitmask.
  - Changing this changes which event/message types Discord delivers to the bot.

### Additional supported env vars (available in code but not listed in `.env.example`)

- `BRAIN_DISABLE_DOTENV`: disables `.env`/`.env.local` loading when set truthy.
- `BRAIN_USER_PROTECTED_PATHS`: semicolon-separated owner-protected path prefixes; malformed entries fail closed.
- `BRAIN_SHELL_EXECUTABLE`: explicit shell executable override for runtime shell profile resolution.
- `BRAIN_SHELL_WSL_DISTRO`: optional distro selector when using `wsl_bash`.
- `OLLAMA_API_KEY`: optional bearer token for Ollama endpoints that are not open on localhost.
- `BRAIN_AGENT_PULSE_TIMEZONE_OFFSET_MINUTES`: alternate alias for pulse timezone offset.
- `BRAIN_INTERFACE_ACK_DELAY_MS`: queue acknowledgement delay (`250..3000` enforced).
- `BRAIN_INTERFACE_FOLLOW_UP_OVERRIDE_PATH`: path to follow-up classifier override file.
- `BRAIN_INTERFACE_PULSE_LEXICAL_OVERRIDE_PATH`: path to pulse lexical override file.
- `BRAIN_INTERFACE_DEBUG`: enables extra Discord gateway debug logs when exactly `true`.
- `TELEGRAM_API_BASE_URL`: Telegram API base URL override.
- `DISCORD_API_BASE_URL`: Discord REST API base URL override.
- `DISCORD_GATEWAY_URL`: Discord gateway discovery URL override.
- `TELEGRAM_MEDIA_ENABLED`: Telegram attachment-ingest master toggle.
- `TELEGRAM_MAX_MEDIA_ATTACHMENTS`: max accepted attachments per Telegram message.
- `TELEGRAM_MAX_MEDIA_ATTACHMENT_BYTES`: max size per Telegram attachment before fail-closed reject.
- `TELEGRAM_MAX_MEDIA_DOWNLOAD_BYTES`: max bytes downloaded for Telegram attachment fetch.
- `TELEGRAM_MAX_VOICE_SECONDS`: max Telegram voice-note duration.
- `TELEGRAM_MAX_VIDEO_SECONDS`: max Telegram video duration.
- `TELEGRAM_ALLOW_IMAGES`, `TELEGRAM_ALLOW_VOICE_NOTES`, `TELEGRAM_ALLOW_VIDEOS`, `TELEGRAM_ALLOW_DOCUMENTS`: Telegram per-modality allow switches.
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

## 19) Troubleshooting

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
- If `BRAIN_INTERFACE_ALLOWED_USER_IDS` is set, confirm the copied user ID matches the provider:
  Telegram `message.from.id` or Discord Developer Mode -> Copy User ID.

Telegram bot receives no updates:

- Confirm bot token is valid and bot has a recent message in chat (`/start`).
- If using `TELEGRAM_ALLOWED_CHAT_IDS`, confirm the current chat ID is included.

Discord messages are empty or missing:

- Enable Message Content Intent in Discord Developer Portal.
- Confirm bot is invited to the target server and channel permissions allow read/send.

Federation startup fails:

- Verify `BRAIN_ENABLE_FEDERATION_RUNTIME=true` and valid non-empty `BRAIN_FEDERATION_CONTRACTS_JSON`.
