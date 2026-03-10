# Media Fixtures

These fixtures are tiny deterministic stand-ins for Telegram image, video, and voice-note ingest.

They are not intended to be photorealistic or high-fidelity recordings. Their job is to:
- exercise the real Telegram media-ingest path
- produce stable fixture hashes for deterministic interpretation
- keep live-smoke and evidence runs reproducible in CI and local validation

The media-understanding live smoke uses these files with a fixture catalog keyed by SHA-256.
That means the runtime still downloads and interprets real files, but the resulting summary,
transcript, and OCR text are controlled by the test harness instead of an unstable external model.
