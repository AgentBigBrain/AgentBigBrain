# AgentBigBrain Architecture Overview

This page is the short visual overview. The full architecture reference lives in
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Core idea

AgentBigBrain separates four responsibilities that many agent systems collapse:

1. **Meaning**: what the user probably intends.
2. **Authority**: what the runtime is allowed to do.
3. **Execution**: what actually ran.
4. **Proof**: what can be claimed afterward.

```mermaid
flowchart LR
  Language["Messy human language"] --> Semantics["Semantic route or typed candidates"]
  Semantics --> Authority["Typed authority contracts"]
  Authority --> Policy["Deterministic policy and governance"]
  Policy --> Execution["Executor / runtime action"]
  Execution --> Proof["Receipts, evidence, projections"]
  Proof --> Reply["Truthful user-facing result"]

  Language -.-> Lexical["Lexical cues / token overlap"]
  Lexical -. "candidate only" .-> Semantics
  Lexical -. "exact commands / safety" .-> Policy
```

## Runtime topology

```mermaid
flowchart TB
  Ingress["CLI / Telegram / Discord / Federation"] --> Interface["Interface and ingress runtime"]
  Interface --> Route["Semantic route metadata"]
  Route --> Orchestrator["BrainOrchestrator"]

  Orchestrator --> MemoryBroker["Memory broker"]
  MemoryBroker --> Profile["Profile memory graph"]
  MemoryBroker --> Continuity["Stage 6.86 continuity"]
  MemoryBroker --> SemanticMemory["Semantic memory + workflow learning"]

  Orchestrator --> Planner["PlannerOrgan"]
  Planner --> SkillGuidance["Markdown skill guidance"]
  Planner --> Actions["Typed planner actions"]

  Actions --> Registry["Action authority registry"]
  Registry --> Preflight["Hard constraints + preflight"]
  Preflight --> Governance["Governors + approval grants"]
  Governance --> Executor["Executor / live-run runtime"]
  Executor --> Receipts["Execution receipts"]

  Receipts --> Renderer["User-facing result renderer"]
  Profile --> Projection["Projection service"]
  Continuity --> Projection
  Receipts --> Projection
  Projection --> Obsidian["Obsidian / JSON mirror"]
```

## Action authority path

```mermaid
sequenceDiagram
  participant U as User
  participant S as Semantic Route
  participant P as Planner
  participant A as Action Registry
  participant H as Hard Constraints
  participant G as Governance
  participant E as Executor
  participant R as Receipts

  U->>S: natural request
  S->>P: typed execution mode, memory intent, runtime-control intent
  P->>A: proposed action list
  A->>A: canonical ids, risk class, side-effect class, params schema
  A->>H: normalized proposal
  H->>G: allowed proposal
  G->>E: approved action
  E->>R: durable receipt and evidence
```

## Memory authority path

```mermaid
flowchart LR
  Input["User / media / document / review action"] --> Source["Source authority"]
  Source --> Policy["Ingest policy"]
  Policy --> Candidate["Semantic or exact candidate"]
  Candidate --> Governance["Truth governance"]
  Governance --> Current["Current durable truth"]
  Governance --> Support["Support-only context"]
  Governance --> Quarantine["Quarantine / review"]

  Current --> Read["Bounded reads for planner/user review"]
  Support --> Read
  Quarantine --> Review["Review surfaces"]
```

## Projection model

```mermaid
flowchart TB
  Canonical["Canonical runtime stores"] --> Snapshot["Projection snapshot"]
  Snapshot --> Obsidian["Obsidian mirror"]
  Snapshot --> JSON["JSON mirror"]

  Obsidian --> Human["Human inspection"]
  Human --> ReviewAction["Structured review-action note"]
  ReviewAction --> RuntimeMutation["Governed runtime mutation path"]
  RuntimeMutation --> Canonical

  Obsidian -. "not authority" .-> Canonical
```

Projection is not memory authority. It is a review surface. Write-back happens only through
structured review actions.

## What stays deterministic

- exact commands
- exact paths, URLs, ports, ids, leases, and env vars
- schemas and manifests
- protected-path checks
- shell, network, browser, process, and approval gates
- active prompt option ids
- receipts and proof parsers
- redaction and sensitive scans

## What should be semantic or typed

- messy user intent
- relationship state
- identity updates
- memory writes
- workflow continuation
- skill selection
- media/document meaning
- mission completion claims
- proactive follow-up intent

## Invariant

> The model can think broadly. The runtime acts narrowly, audibly, and truthfully.
