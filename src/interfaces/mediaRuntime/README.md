# Media Runtime

## Responsibility
This subsystem owns canonical bounded media-ingest contracts and Telegram media parsing/download
helpers below the stable interface transport entrypoints.

Current ownership:
- `contracts.ts` owns the shared inbound media envelope contracts
- `mediaNormalization.ts` owns media-only fallback input text plus bounded execution-context
  rendering, including the voice-only `command <name>` promotion path for explicit transcripts
- `mediaLimits.ts` owns canonical Telegram media fail-closed limits
- `telegramMediaIngress.ts` owns canonical Telegram image/voice/video/document parsing
- `telegramFileDownload.ts` owns canonical Telegram `getFile` resolution and bounded download
  helpers

## Inputs
- Telegram message payloads containing `photo`, `voice`, `video`, or `document`
- Telegram Bot API base URL and bot token
- explicit media-size and duration limits from interface runtime configuration

## Outputs
- bounded media envelopes suitable for conversation/runtime contracts
- natural fallback input text for media-only messages
- explicit voice-only command promotion for transcripts like `command auto ...`
- bounded execution-input media context blocks
- fail-closed media validation decisions
- bounded Telegram file descriptors and in-memory file downloads

## Invariants
- This subsystem must not store raw media in the six memory systems directly.
- Media parsing here must stay provider-bounded and fail closed on malformed payloads.
- Telegram file downloads here must remain bounded by explicit size limits.
- Media-only messages should become natural bounded requests, not silent drops.
- Voice-only command promotion must stay narrow: only real voice transcripts, only near the start
  of the transcript, and only for explicit `command <known-command>` phrasing.

## Related Tests
- `tests/interfaces/transportRuntime.test.ts`
- `tests/interfaces/telegramGateway.test.ts`

## When to Update This README
Update this README when:
- a new file is added to `src/interfaces/mediaRuntime/`
- ownership moves between `telegramGatewayRuntime.ts` and this subsystem
- media fallback input or media-context rendering rules change materially
- voice-only command promotion rules change materially
- Telegram media validation or download behavior changes materially
