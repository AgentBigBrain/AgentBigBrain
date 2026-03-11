## Responsibility
This subsystem owns deterministic workflow-learning extraction, ranking, inspection, and skill-opportunity helpers.

## Primary Files
- `contracts.ts`
- `observationExtraction.ts`
- `observationScoring.ts`
- `patternLifecycle.ts`
- `plannerBias.ts`
- `relevanceRanking.ts`
- `skillOpportunityRanking.ts`
- `workflowInspection.ts`

## Inputs
- task-run receipts and execution outcomes routed through `src/core/workflowLearningStore.ts`
- planner queries and orchestrator learning-context lookups routed through `src/core/orchestration/orchestratorPlanning.ts`
- linked-skill metadata supplied by the skill/workflow bridge

## Outputs
- richer workflow observations with execution-style, approval, cost, latency, recovery, and linked-skill metadata
- deterministic ranked retrieval for relevant workflow motifs
- planner-bias summaries and operator-facing workflow inspection summaries
- repeated-workflow opportunity ranking used by the skill/workflow bridge

## Invariants
- Workflow observations stay deterministic and receipt-backed.
- Query ranking remains explainable from stored workflow fields.
- Planner bias remains inspectable and does not become a hidden routing layer.
- Skill-opportunity suggestions never create or trust skills on their own.

## Related Tests
- `tests/core/workflowLearningStore.test.ts`
- `tests/core/workflowLearningRuntime.test.ts`
- `tests/organs/skillWorkflowBridge.test.ts`

## When to Update This README
- Update this README when workflow observation fields, ranking rules, planner bias behavior, or the skill-opportunity logic changes.
