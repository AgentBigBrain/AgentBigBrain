# Principal Runtime

## Responsibility

This folder owns typed principal, subject, and operation-specific access contracts for interface and
conversation runtime boundaries. It is the canonical place for deriving actor context from trusted
transport ingress, building legacy fail-closed contexts, creating operation-scoped access envelopes,
and rendering redacted principal metadata for prompts or audit surfaces.

## Inputs

- trusted provider ingress fields such as provider id, conversation id, user id, visibility, and
  observed transport identity
- configured owner/operator principal ids from runtime configuration
- existing conversation/session principal context when later runtime paths need an operation-specific
  access decision
- legacy or recovered records that must preserve continuity without minting owner-private authority

## Outputs

- `PrincipalContext` values that describe the actor, route, and subject refs
- `PrincipalAccessEnvelope` values scoped to one `PrincipalAccessOperation`
- fail-closed legacy principal contexts for actorless compatibility records
- redacted model/audit views that exclude raw provider ids and stable principal hashes

## Invariants

- Display names, usernames, session keys, source refs, graph refs, prompt text, model output,
  approval text, and memory content are not owner proof.
- Each protected operation needs its own access decision. A `direct_reply` envelope cannot authorize
  `profile_read`, and a `profile_read` envelope cannot authorize `profile_write`.
- Missing, malformed, legacy, external-agent, or runtime-continuation context must not silently
  become owner-private access.
- Prompt-facing and audit-facing views must use role, visibility, access class, reason, and legacy
  state labels instead of raw provider ids, local paths, or durable principal hashes.
- This folder should be extended before adding duplicate principal/access helper modules elsewhere.

## Related Tests

- `tests/interfaces/principalAccess.test.ts`

## When to Update This README

Update this README when principal context fields, access-operation vocabulary, redaction behavior,
legacy normalization, or operation-specific helper semantics change.
