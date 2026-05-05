# AgentBigBrain Concepts

This glossary explains the public terms used in the README and architecture docs. It is not a
replacement for the implementation reference in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Semantic route

A typed interpretation of the current user turn. It can carry execution mode, memory intent,
runtime-control intent, continuation kind, and constraints. The route helps the planner understand
the request, but side effects still need action authority and governance.

## Source authority

Metadata that says where evidence came from and how much authority it carries. Examples include
exact commands, explicit user statements, active clarification choices, semantic model output,
lexical fallback evidence, document text, media transcripts, media summaries, review mutations,
strict schemas, and legacy compatibility paths.

## Action authority registry

The canonical registry for planner action ids, aliases, risk classes, side-effect classes, and
parameter schemas. It keeps action authority in typed runtime contracts instead of scattered prompt
wording or broad string matching.

## Governed execution

The runtime path where proposed actions pass through typed action validation, hard constraints,
preflight checks, governance, approvals when required, execution, and receipt writing.

## Execution receipt

Durable evidence that an approved action actually ran. Governance records explain what was allowed;
execution receipts record what the executor or runtime action actually did.

## Governance outcome

A recorded allow/block decision from deterministic rules, preflight checks, approval scope, or
governor evaluation. Governance outcomes are part of the proof trail for later review.

## Profile memory graph

The durable personal-memory model for identities, relationships, claims, timing, and whether a
fact is current, historical, resolved, conflicting, support-only, or quarantined.

## Memory ingest policy

The policy that decides whether a conversation, media item, document, review action, or structured
candidate is allowed to write profile memory. Missing policy defaults closed for live paths.

## Episodic memory

Remembered situations, outcomes, and follow-up context. Episodic memory is separate from current
profile truth so unresolved situations can support recall without overwriting facts.

## Source Recall Archive

The quoted-evidence layer for original source material. It uses the AgentBigBrain-native shape
`scope -> thread -> source record -> chunk` to preserve bounded excerpts of what was said or seen.
Source Recall can remind the runtime about prior text, media, documents, task inputs, summaries,
or receipt excerpts, but it cannot decide what is true, allowed, approved, completed, or safe to
act on.

Source Recall records carry source kind, source role, source authority, capture class, lifecycle,
freshness, retrieval mode, retrieval authority, and non-authority flags. Retrieved chunks are
rendered as quoted evidence only. They may support semantic candidates and review, but profile
memory, semantic memory, approvals, execution receipts, and completion proof remain separate
authority surfaces.

## Stage 6.86 continuity

The live conversation-continuity layer for the active interaction. It owns the conversation stack,
entity graph, open loops, pulse state, and runtime-action continuity. It can read profile memory,
but it is not the same thing as durable profile memory.

## Markdown instruction skill

A reusable Markdown guidance file selected by the skill registry. It can guide planning for site
generation, browser recovery, document reading, or operator-defined workflows, but it is advisory
and does not grant side effects.

## Executable skill

A governed runtime artifact that can be invoked through a typed `run_skill` action. Executable
skills still pass through action validation, constraints, governance, and proof.

## Obsidian projection

A human-readable mirror of canonical runtime state. Projection is a review surface, not source of
truth. Structured review-action notes can request governed corrections, but projected notes do not
become authority by themselves.

## Model-unavailable fail-closed behavior

The runtime policy for optional model interpretation paths. When a local or remote model is
disabled, unavailable, malformed, timed out, or low confidence, ambiguous side-effecting behavior
must not silently fall back to broad lexical authority.

## Lexical candidate evidence

Regex, token, phrase, or overlap evidence that can support interpretation. It may be useful for
candidate extraction, diagnostics, exact commands, safety gates, proof parsing, and active prompt
option ids. It must not directly grant durable memory truth, side effects, approval, skill
lifecycle permission, mission completion, graph-current truth, user-facing success, or proactive
outreach.
