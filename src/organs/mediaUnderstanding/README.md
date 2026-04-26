# Media Understanding

## Responsibility
This subsystem owns bounded interpretation of inbound image, voice, video, and document media after
transport parsing but before conversation execution and memory brokerage.

## Inputs
- canonical media envelopes from `src/interfaces/mediaRuntime/`
- optional downloaded file bytes keyed by attachment `fileId`
- env-backed OpenAI credentials and bounded media-understanding model settings
- optional deterministic fixture catalogs for tests and live smoke

## Outputs
- bounded per-attachment interpretations with summary, optional transcript/OCR, confidence,
  provenance, and entity hints
- enriched media envelopes ready for conversation execution and memory-safe brokerage

## Invariants
- This subsystem must fail closed to deterministic fallback when provider calls fail.
- It must not expose raw binary payloads outside the transport/media boundary.
- It should improve user-context quality without becoming a generic multimodal planner.
- Document interpretation is extracted text plus bounded generic hints. Document-derived summary,
  OCR, and entity hints are supporting context and must stay candidate-only for durable memory until
  separately governed.
- Fixture catalogs are allowed for tests and live smoke, not as a production-only code path.

## Current Provider Coverage
- Images can use provider-backed vision when `BRAIN_MEDIA_VISION_MODEL` resolves to a usable
  vision-capable model.
- Voice notes can use either dedicated speech-to-text models such as `whisper-1` or multimodal
  audio-capable chat models such as Gemma 4 when `BRAIN_MEDIA_TRANSCRIPTION_MODEL` is available.
- When `BRAIN_MEDIA_BACKEND` inherits `codex_oauth`, media requests reuse the operator-owned
  Codex bearer credential ephemerally at request time instead of persisting tokens into runtime
  memory or session state.
- `BRAIN_MEDIA_VISION_BACKEND=ollama` now supports local image understanding directly through
  Ollama's `/api/chat` surface.
- `BRAIN_MEDIA_VISION_FALLBACK_BACKEND` can provide one explicit secondary image-understanding
  provider when the primary vision backend fails to load or returns no usable output. This keeps
  the runtime bounded while avoiding silent caption-only degradation on resource-constrained local
  Gemma runs.
- `BRAIN_MEDIA_TRANSCRIPTION_BACKEND=ollama` is currently an experimental local multimodal-audio
  path for models such as Gemma 4. The runtime can target Ollama's OpenAI-compatible
  `/v1/responses` surface, but real audio support still depends on the exact Ollama build and model
  packaging. We are monitoring Ollama for stable native local audio support before recommending it
  as the default voice-note path.
- `BRAIN_MEDIA_TRANSCRIPTION_BACKEND=openai_api` still supports other loopback OpenAI-compatible
  servers without an API key when `OPENAI_BASE_URL` points at localhost.
- Short video currently remains on bounded metadata/caption fallback. That is deliberate: the runtime does not yet have a clip-analysis path with strong enough cost, latency, and truthfulness controls to claim deeper understanding.

## Related Tests
- `tests/organs/mediaUnderstanding.test.ts`
- `tests/interfaces/mediaContextRendering.test.ts`
- future Telegram media live-smoke/evidence tests

## When to Update This README
Update this README when:
- files are added or removed from `src/organs/mediaUnderstanding/`
- media interpretation provenance/confidence rules change materially
- provider-backed media understanding ownership moves elsewhere
- deterministic fixture-catalog behavior changes materially
