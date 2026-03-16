# Autonomous Runtime Affordances Transcript Fixtures

This folder is reserved for transcript-style autonomy proof fixtures that grow out of the scenario
inventory in `tests/fixtures/autonomousRuntimeAffordancesScenarios.json`.

## Purpose
- Keep the autonomy proof prompts human and multi-sentence instead of drifting into parser probes.
- Preserve nearby negative controls for each major behavior family.
- Give future live-smoke and evidence scripts stable transcript seeds for:
  - natural autonomous start
  - workspace continuity
  - exact-holder recovery
  - ambiguous-holder clarification
  - observability and clean exit
  - restart-safe resources
  - return handoff
  - tool-choice quality
  - intent-engine boundary proof

## Fixture Rules
- Use ordinary human wording, not slash commands or pseudo-shell.
- Opening user turns should usually be 2 to 4 sentences.
- Keep positive and negative controls near each other conceptually.
- If a transcript depends on restart churn, clarification, or return-later behavior, note that in
  the filename or header comment when the transcript file is added.
- Do not add broad-shutdown success transcripts; that would be a regression, not a proof target.
