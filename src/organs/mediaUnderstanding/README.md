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
- Fixture catalogs are allowed for tests and live smoke, not as a production-only code path.

## Current Provider Coverage
- Images can use provider-backed vision when `BRAIN_MEDIA_VISION_MODEL` resolves to a usable vision-capable model.
- Voice notes can use provider-backed transcription when `BRAIN_MEDIA_TRANSCRIPTION_MODEL` is available.
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
