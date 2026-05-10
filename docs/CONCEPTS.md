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

## Principal, subject, and access

The runtime separates three questions that often look similar in conversation:

- principal: which actor sent or initiated the request,
- subject: who or what the memory/source/action is about,
- access: whether that actor may perform this operation on that subject.

Provider user ids and local trusted-operator mode can establish owner/operator principals when
configured. Usernames and display names are only ingress/display hints. Prompt text, model output,
task ids, graph evidence refs, Source Recall refs, and projection notes cannot grant owner status,
merge subjects, authorize memory review, or approve side effects.

Legacy subjectless profile memory remains owner-only or review-only until explicitly migrated.
Missing principal metadata fails closed for owner-private memory.

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

See [SOURCE_RECALL.md](./SOURCE_RECALL.md) for the production latches, storage, retrieval,
projection, and delete contract.

## Stage 6.86 continuity

The live conversation-continuity layer for the active interaction. It owns the conversation stack,
entity graph, open loops, pulse state, and runtime-action continuity. It can read profile memory,
but it is not the same thing as durable profile memory.

## Agent Pulse

The opt-in proactive check-in surface. Agent Pulse is split into controls, candidate generation,
delivery policy, wording, and outcome learning. Exact `/pulse` commands remain deterministic.
Natural pulse preferences can become typed preference candidates, but they do not immediately
authorize outreach.

Dynamic Pulse currently uses deterministic graph, stack, memory, and recent-conversation signals to
produce typed pulse candidates. Future Source Recall-supported inquiry candidates can add quoted
evidence after the Source Recall gate is explicitly enabled, but Source Recall still cannot grant
outreach authority. Deterministic policy decides whether ABB may interrupt. The model may word an
approved check-in after permission, but it does not grant delivery authority.

## Proactive inquiry candidate

A typed proposal for a potentially useful question. It carries an inquiry type, user-value reason,
question intent, evidence refs, Source Recall status, privacy risk, novelty, expected user value,
and non-authority flags. A candidate can explain why a question might help; it cannot deliver a
message, write memory, approve an action, mark work complete, or bypass quiet hours, cooldowns,
caps, routing, or public/private safety.

## Pulse authority gateway

The deterministic boundary that turns a pulse candidate into either an allowed queued response or a
suppressed decision record. It checks opt-in state, quiet hours, cooldowns, daily caps, active work,
dynamic reason allowlists, route privacy, public/private evidence safety, and Source Recall
lifecycle status when source evidence is involved. Prompt text, model output, `pulse_emit`, and
candidate metadata cannot bypass this gateway.

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
