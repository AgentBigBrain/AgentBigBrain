# Profile Memory Runtime

## Responsibility
This subsystem owns the profile-memory runtime contracts plus the query, pulse, mutation, and
persistence helpers that sit between encrypted persistence and higher-level planner or operator
surfaces.

The goal is to keep profile-memory access semantics discoverable without forcing edits through the
full `profileMemoryStore.ts` implementation.

## Inputs
- normalized profile-memory state from `src/core/profileMemory.ts`
- encrypted-store lifecycle from `src/core/profileMemoryStore.ts`
- planner-query ranking from `src/core/profileMemoryPlanningContext.ts`
- pulse request and access request contracts from higher-level runtime callers

## Outputs
- shared profile-memory runtime contracts in `contracts.ts`
- deterministic ingest provenance helpers and replay-safe synthetic source-task ids in
  `profileMemoryIngestProvenance.ts`
- bounded turn-local ingest receipt helpers in `profileMemoryIngestIdempotency.ts`
- request-scoped store-load telemetry helpers in `profileMemoryRequestTelemetry.ts`
- commitment signal classification helpers in `profileMemoryCommitmentSignals.ts`
- unresolved commitment topic extraction and matching in `profileMemoryCommitmentTopics.ts`
- canonical state creation and freshness helpers in `profileMemoryState.ts`
- canonical episodic-memory contracts in `profileMemoryEpisodeContracts.ts`
- canonical episodic-memory state helpers in `profileMemoryEpisodeState.ts`
- canonical episodic-memory normalization helpers in `profileMemoryEpisodeNormalization.ts`
- deterministic episodic-memory extraction in `profileMemoryEpisodeExtraction.ts`
- deterministic episodic-memory continuity linkage in `profileMemoryEpisodeLinking.ts`
- canonical episodic-memory upsert/merge helpers in `profileMemoryEpisodeMutations.ts`
- bounded episodic-memory planner-context rendering in `profileMemoryEpisodePlanningContext.ts`
- approval-aware episodic-memory reads and continuity queries in `profileMemoryEpisodeQueries.ts`
  that can power bounded active-conversation recall and private remembered-situation review
- bounded episodic-memory resolution inference in `profileMemoryEpisodeResolution.ts`
- episodic-memory consolidation plus freshness/lifecycle ranking in
  `profileMemoryEpisodeConsolidation.ts`
- bounded interpreted media-ingest normalization in `profileMemoryMediaIngest.ts`
- canonical fact upsert lifecycle helpers in `profileMemoryFactLifecycle.ts`
- key, value, sensitivity, and topic normalization helpers in `profileMemoryNormalization.ts`
- canonical persisted state normalization helpers in `profileMemoryStateNormalization.ts`
- deterministic user-input candidate extraction in `profileMemoryExtraction.ts`
- shared bounded parsing, clause trimming, and follow-up resolution helpers for deterministic
  user-input extraction in `profileMemoryExtractionSupport.ts`
- deterministic historical self-fact extraction in `profileMemoryHistoricalExtraction.ts`
- deterministic severed named-contact work-linkage extraction in
  `profileMemoryContactEndStateExtraction.ts`
- deterministic historical and severed direct named-contact relationship extraction in
  `profileMemoryContactRelationshipHistoryExtraction.ts`, including bounded symmetric relationship
  history or severance phrasing such as `Owen and I used to be friends.`,
  `I'm not friends with Owen anymore.`, `Owen and I used to be peers.`, 
  `I'm not married to Owen anymore.`, `Rosa and I used to be family.`, and
  `Rosa and I aren't siblings anymore.`, plus direct forms such as `Kai is my former roommate.`
- deterministic current direct named-contact relationship extraction in
  `profileMemoryContactCurrentRelationshipExtraction.ts`, including bounded symmetric current
  relationship phrasing such as `Owen and I are friends.`, `I'm friends with Owen.`,
  `Owen and I are coworkers.`, `Owen and I are married.`, `Kai and I are roommates.`, and
  `Rosa and I are family.`, plus sibling phrasing such as `Rosa and I are siblings.`
  - deterministic current, historical, and severed employee-direction extraction for named contacts
  in `profileMemoryContactEmployeeLinkExtraction.ts`
  - deterministic current, historical, and severed reverse-direction work-peer extraction for
    bare named-contact phrasing such as `Owen works with me.`, `Owen worked with me.`, and
    `Owen no longer works with me.` in `profileMemoryContactWorkPeerLinkExtraction.ts`
  - shared bounded conversational profile-update eligibility helpers in
    `profileMemoryConversationalSignals.ts`
- deterministic preferred-name fast-path normalization and validated semantic-candidate ingestion in
  `profileMemoryPreferredNameValidation.ts`
- contact-focused named-entity and relationship extraction in `profileMemoryContactExtraction.ts`
- shared bounded wrapper-cleanup and association-trimming helpers for deterministic contact
  extraction in `profileMemoryContactExtractionSupport.ts`
- deterministic suppression rules for generic fallback facts that would otherwise duplicate
  governed named-contact relationship facts in `profileMemoryGenericFactSuppression.ts`
- canonical encryption envelope and key parsing helpers in `profileMemoryEncryption.ts`
- pulse continuity helpers in `profileMemoryPulse.ts`
- planner-context rendering and query-aware ranking in `profileMemoryPlanningContext.ts`
- approval-aware readable-fact queries in `profileMemoryQueries.ts`
- shared fail-closed compatibility visibility rules for flat fact projection plus bounded
  readable-fact and query surfaces in `profileMemoryCompatibilityVisibility.ts`
- request-scoped reconciled read-session reuse in `profileMemoryReadSession.ts`
- closed truth-governance contracts in `profileMemoryTruthGovernanceContracts.ts`
- closed governance-family inference for fail-closed source-authority decisions in
  `profileMemoryGovernanceFamilyInference.ts`
- deterministic candidate governance classification in `profileMemoryTruthGovernance.ts`
- commitment-resolution and candidate-apply helpers in `profileMemoryMutations.ts`
- env configuration plus encrypted disk I/O helpers in `profileMemoryPersistence.ts`
- bounded user-review and explicit correction or forgetting flows for remembered situations, still
  brokered through stable interface and memory-broker entrypoints

## Invariants
- `profileMemoryStore.ts` remains the stable encrypted-store entrypoint while canonical runtime
  contracts and query, pulse, mutation, persistence, and episodic-memory helpers move here.
- Sensitive fact reads stay fail-closed unless the request carries explicit human approval.
- Planner context generation stays bounded and deterministic for the same state/query input.
- State creation, freshness downgrades, fact upserts, and persisted-state normalization belong here
  even when `profileMemory.ts` keeps the stable public export surface.
- Episodic-memory contracts, state helpers, extraction, mutation, and bounded resolution inference
  belong here before recall ranking or planner-context injection ship.
- Duplicate episodic-memory records should consolidate here before they clutter store reads or
  active-turn recall selection.
- Bounded unresolved-situation summaries for planner/model grounding belong here before brokered
  context injection renders them.
- Continuity-aware episode queries here may support one bounded active-conversation recall, but they
  must stay approval-aware, privacy-safe, and deterministic.
- Explicit user review or correction flows must still rely on approval-aware episode reads here; the
  runtime must not grow an unbounded raw-episode dump surface.
- Explicit user resolve, wrong, or forget flows must remain bounded and deterministic here even
  when higher layers expose private remembered-situation controls.
- Interpreted media may enrich episodes or continuity context here, but raw image, audio, and video
  bytes must never become general durable memory payloads.
- Episodic-memory freshness and lifecycle ranking here may de-prioritize stale or terminal
  situations for planning, pulse grounding, and continuity recall, but must not fabricate recall
  candidates.
- Encryption envelope parsing and key validation stay canonical in this subsystem even when
  `profileMemoryCrypto.ts` remains as a thin compatibility entrypoint.
- Richer human-language understanding for episodic extraction, linkage, and planning-context
  ranking should consume shared `src/core/languageRuntime/` helpers and eventually bounded
  `src/organs/languageUnderstanding/` surfaces instead of growing more one-off local lexicons here.
- Shared conversational profile-update eligibility should stay extraction-backed here so direct chat
  and broker ingest can reuse one bounded signal instead of diverging into parallel lexical
  routers.
- Deterministic source fingerprints and provenance-derived synthetic task ids for conversational
  writes belong here so orchestrator, broker, and interface seams do not invent competing replay
  identifiers.
- Turn-local ingest idempotency belongs here so direct-chat and broker-side writes can share one
  bounded duplicate-prevention contract at the canonical store seam instead of adding parallel
  retry guards in higher layers.
- Request-scoped store-load telemetry belongs here so Phase 1.5 can prove bounded read reuse
  through existing broker and later conversational request paths without inventing a second store.
- Request-scoped read-session reuse belongs here so broker and later conversational consumers can
  reuse one reconciled profile snapshot without turning `ProfileMemoryStore` into multiple read
  owners.
- Truth-governance classification belongs here before canonical mutation so profile facts,
  support-only legacy context, episode support, and quarantined candidates do not diverge into
  competing policy layers at the store seam.
- Structured current-state authority must stay explicitly whitelisted here. Today the only live
  `conversation.*` fact source allowed to create current truth is
  `conversation.identity_interpretation` for `identity.preferred_name`; other structured
  conversation sources must fail closed into quarantine until a bounded governed producer and
  family policy are source-backed in code.
- Explicit preferred-name authority must stay explicitly whitelisted here too. Today the only live
  explicit `user_input_pattern.*` fact source allowed to create current preferred-name truth is
  `user_input_pattern.name_phrase`; broader explicit preferred-name sources must fail closed into
  quarantine until a bounded governed producer exists in source.
- Projection-driven preferred-name authority must stay explicitly whitelisted here too.
  `identity.preferred_name` has no live `profile_state_reconciliation.*` producer today, so
  unsupported projection preferred-name sources must fail closed into quarantine under
  `reconciliation_or_projection` rather than generic assistant inference until a bounded governed
  producer exists in source.
- Current self employment and residence authority must stay explicitly whitelisted here too. Today
  the only live explicit current-state employment sources are `user_input_pattern.work_at` and
  `user_input_pattern.job_is`, and the only live explicit current-state residence source is
  `user_input_pattern.residence`; broader explicit `user_input_pattern.*` sources for those
  families must fail closed into quarantine until a bounded governed producer exists in source.
- Contact current-state authority must stay explicitly whitelisted here too. Today
  `contact.<token>.name` may only create current truth from the live explicit contact producers
  `user_input_pattern.named_contact`, `user_input_pattern.direct_contact_relationship`,
  `user_input_pattern.direct_contact_relationship_historical`,
  `user_input_pattern.direct_contact_relationship_severed`,
  `user_input_pattern.work_with_contact`, `user_input_pattern.work_with_contact_historical`, and
  `user_input_pattern.work_with_contact_severed`. `contact.<token>.relationship` current truth may
  only come from `user_input_pattern.named_contact`,
  `user_input_pattern.direct_contact_relationship`, `user_input_pattern.work_with_contact`, and
  `user_input_pattern.work_association`, while `contact.<token>.work_association` current truth
  may only come from `user_input_pattern.direct_contact_relationship`,
  `user_input_pattern.work_with_contact`, and `user_input_pattern.work_association`; broader
  explicit `user_input_pattern.*` contact current-state sources must fail closed into quarantine
  until a bounded governed producer exists in source.
- Support-only contact-context authority must stay explicitly whitelisted here too. Today the only
  live `contact.<token>.context.*` source allowed onto the support-only legacy lane is
  `user_input_pattern.contact_context`; unsupported structured `conversation.*`, broader explicit
  `user_input_pattern.*`, or `profile_state_reconciliation.*` contact-context sources must fail
  closed into quarantine instead of silently entering legacy context projection. Malformed or
  legacy facts that carry `user_input_pattern.contact_context` against other families must also
  fail closed out of bounded read, planning, continuity-query, and pulse surfaces instead of
  reappearing as ordinary current truth.
- Support-only contact-entity hints must also stay exact-family and corroboration-gated here.
  Today `user_input_pattern.contact_entity_hint` may only keep hinted `contact.<token>.name`
  candidates on the support-only legacy lane, while malformed or future uses of that source
  against other families must fail closed into quarantine instead of inheriting support-only
  authority by source prefix alone. Corroboration-free inferred `contact.<token>.name` facts from
  that source must still fail closed out of flat projection plus bounded read/query surfaces until
  a stronger governed source confirms the contact identity.
- Unsupported `profile_state_reconciliation.*` contact current-state or support-only sources must
  also stay explicitly classified as projection-driven quarantine here, not generic assistant
  inference. That applies to `contact.<token>.name`, `contact.<token>.relationship`,
  `contact.<token>.work_association`, and `contact.<token>.school_association` until a bounded
  governed reconciliation producer exists in source for those families.
- Explicit generic fact authority must stay explicitly whitelisted here too. Today the only live
  generic `user_input_pattern.*` fact source allowed to create current truth is
  `user_input_pattern.my_is`; broader explicit generic fact sources must fail closed into
  quarantine until a bounded governed producer exists in source.
- Projection-driven current-state authority must stay explicitly whitelisted here too. Today the
  only live `profile_state_reconciliation.*` fact source allowed to mutate canonical truth is the
  follow-up end-state producer `profile_state_reconciliation.followup_resolved`; broader
  reconciliation or projection sources for employment, residence, contact, or generic facts must
  fail closed into quarantine until a bounded governed producer exists in source.
- Structured school-association authority must stay explicit too. Today
  `user_input_pattern.school_association` remains the only live source-backed school-association
  fact producer, and unsupported structured `conversation.*` or broader explicit
  `user_input_pattern.*` school-association candidates must fail closed into quarantine instead of
  silently entering the support-only path. Malformed or legacy facts that carry
  `user_input_pattern.school_association` against other families must also fail closed out of flat,
  read, planning, continuity-query, and pulse compatibility surfaces instead of reappearing as
  ordinary current truth.
- End-state authority must stay explicitly whitelisted here too. Today the only live
  follow-up-resolution fact sources allowed to end canonical follow-up state are
  `user_input_pattern.followup_resolved`,
  `user_input_pattern.followup_resolved_inferred`, and
  `profile_state_reconciliation.followup_resolved`, and the only live
  episode-resolution candidate source allowed through governance is
  `user_input_pattern.episode_resolution_inferred`; unsupported structured or projection
  end-state sources must fail closed into quarantine until a bounded producer exists in source.
- Episode-candidate support authority must stay explicitly whitelisted here too. Today the only
  live explicit episode candidate source allowed through governance is
  `user_input_pattern.episode_candidate`, and the only live assistant-inference episode source
  allowed through governance is `language_understanding.episode_extraction`; other sources that
  merely claim `explicit_user_statement` or `assistant_inference` must fail closed into
  quarantine until a bounded producer exists in source.
- Unsupported structured or projection episode candidates must also stay explicitly classified by
  source prefix here, not generic assistant inference. `conversation.*` episode candidates must
  quarantine under `validated_structured_candidate`, and
  `profile_state_reconciliation.*` episode candidates must quarantine under
  `reconciliation_or_projection` until a bounded governed producer exists in source.
- Compatibility-safe support-only projection must stay fail-closed for singular current-state flat
  keys such as historical `employment.current` or `residence.current` facts until graph-backed
  history can persist them without pretending they are active truth. Malformed or legacy facts that
  carry `user_input_pattern.work_at_historical` or `user_input_pattern.residence_historical`
  against other families must also fail closed out of flat, read, planning, continuity-query, and
  pulse compatibility surfaces instead of reappearing as ordinary current truth.
- Compatibility-safe support-only projection must stay fail-closed for historical and severed
  contact work-linkage support such as `user_input_pattern.work_with_contact_historical`,
  `user_input_pattern.work_association_historical`, and
  `user_input_pattern.work_with_contact_severed`, so flat facts can preserve contact identity
  without pretending old work-peer or work-association state is still current. The same exact-
  family compatibility rule must also fail closed malformed or legacy facts that carry those
  sources, plus `user_input_pattern.direct_contact_relationship_historical` and
  `user_input_pattern.direct_contact_relationship_severed`, against other families on readable,
  planning, continuity-query, and pulse surfaces; only bounded contact identity may remain
  compatibility-visible from those historical or severed contact-support sources.
- Compatibility-safe support-only projection must also stay fail-closed for historical school ties
  such as `user_input_pattern.school_association`, so flat facts can preserve contact identity and
  any separately governed current relationship without pretending a past school association is
  active current truth.
- Compatibility-safe support-only projection must also fail closed for explicit severed
  work-linkage contact facts such as `I don't work with Owen anymore` until end-state capable
  graph-backed history can carry them without projecting a fake active coworker relationship back
  into the flat store.
- The same compatibility-visibility rule must also govern bounded readable-fact and
  query/planning surfaces here, not just flat fact projection, so legacy support-only historical
  employment, residence, school-tie, or severed relationship facts cannot reappear as ordinary
  current truth through `readProfileFacts`, continuity queries, or query-aware planning fallbacks
  while graph-backed history is still pending.
- The same compatibility-visibility rule must also keep corroboration-free contact-entity hints
  fail closed on flat projection plus bounded read/query surfaces, so
  `user_input_pattern.contact_entity_hint` cannot surface inferred `contact.<token>.name` facts
  as ordinary truth before a stronger governed contact source corroborates them. The same
  fail-closed visibility rule should also hide malformed or legacy facts that carry that hint-only
  source against other families, instead of letting unsupported hinted relationship or employment
  records leak back through readable or planning surfaces.
- Compatibility-safe support-only projection must also fail closed for historical or severed direct
  contact relationship facts such as `Owen is my former coworker` or `Owen is no longer my
  manager`, plus bounded symmetric relationship phrasing such as
  `Owen and I used to be friends.`, `I'm not friends with Owen anymore.`, or
  `Owen and I used to be peers.`, `Rosa and I used to be family.`, or
  `Rosa and I aren't siblings anymore.`, plus bounded partner-history endings such as
  `I used to be married to Owen.` or `I'm not married to Owen anymore.`, plus roommate endings
  such as `Kai is my former roommate.` or `Kai is no longer my roommate.`, until graph-backed
  history can carry those endings without reviving them as active flat relationships.
- Bounded symmetric current relationship phrasing such as `Owen and I are friends.`,
  `I'm friends with Owen.`, `Owen and I are coworkers.`, `Owen and I are married.`, or
  `Kai and I are roommates.`, `Rosa and I are family.`, or
  `Rosa and I are family members.` should land on the same governed current-state contact
  relationship path as the existing rigid direct-contact forms instead of degrading to contact
  hints or raw context only.
- Relationship-descriptor normalization here should keep user-facing synonyms bounded and
  deterministic; today that includes normalizing `boss`, `supervisor`, and `team lead` into the
  canonical `manager` relationship descriptor, including the shorter `lead` phrasing, plus
  `direct report` into the canonical `employee` relationship descriptor, and British-spelling
  `neighbour` into the canonical `neighbor` relationship descriptor, plus `peer`, `work peer`,
  `coworker`, `colleague`, and `teammate` into the canonical `work_peer` relationship descriptor,
  plus close-relationship descriptors such as `wife`, `husband`, `girlfriend`, and `boyfriend`
  into the canonical `partner` relationship descriptor,
  plus close-kinship descriptors such as `mom`, `mother`, `dad`, `father`, `sister`, and
  `brother` into the canonical `relative` relationship descriptor,
  plus low-authority generic people labels such as `guy` and `person` into the canonical
  `acquaintance` relationship descriptor, plus kinship terms such as `aunt`, `uncle`, and
  `distant relative`, plus bounded `family member` and direct `family` phrasing into the
  canonical `relative` relationship descriptor, plus broader close-kinship terms such as `son`,
  `daughter`, `parent`, `child`, and `sibling` into that same canonical `relative` descriptor,
  while
  employee-direction phrasing such as
  `Owen works for me`,
  `Owen used to work for me`, and `Owen no longer works for me` also lands on the same canonical
  `employee` family so direct, historical, severed, and named-contact phrasing do not split into
  parallel buckets. Reverse-direction work-peer phrasing such as
  `Owen works with me`,
  `Owen worked with me`, and `Owen no longer works with me` should also land on the existing
  canonical work-linkage sources instead of dropping out unless the user adds an extra wrapper
  like `my friend`; those bare named-contact forms should reuse the same current, historical, and
  severed work-linkage governance path without inventing a second truth seam. Bounded roommate
  phrasing such as `My roommate is Kai.`, `Kai is my roommate.`,
  `Kai and I are roommates.`, `Kai is my former roommate.`, and
  `Kai is no longer my roommate.` may also pass through governed extraction even though pulse still
  keeps that family fail-closed as `unknown` until Phase 2.5 introduces a richer registry and role
  taxonomy. Explicit non-work kinship descriptors such as `cousin` may also pass through governed
  extraction as bounded contact relationships when pulse-side role assessment already has a
  deterministic taxonomy for them; current phrasing should land on the governed current-state
  path, and bounded history or severance phrasing such as `Owen and I used to be cousins.` or
  `I'm not cousins with Owen anymore.` should stay on the support-only legacy path instead of
  degrading to hints or raw context only. The same bounded governed-relative path should also cover
  current phrases such as `My family member is Rosa.`, `Rosa is family.`, and
  `Rosa is a family member.`, plus close-kinship phrases such as `My son is Liam.`,
  `Ava is my daughter.`, `Nora is my parent.`, `Eli is my child.`, and
  `Rosa is my sibling.`, plus bounded symmetric family-history endings such as
  `Rosa and I used to be family.`, `Rosa and I used to be family members.`, and
  `Rosa and I aren't siblings anymore.`, plus
  multi-word current, historical, and severed phrasing such as
  `Rosa and I are distant relatives.`, `Rosa and I used to be distant relatives.`, and
  `Rosa and I aren't distant relatives anymore.` instead of splitting those forms away from the
  canonical `relative` family.
- Pulse-side relationship-role assessment should stay aligned with governed extraction for bounded
  low-authority school or social ties plus canonical close-relationship families; today that
  includes treating governed `classmate` contact relationships as the existing low-authority
  `acquaintance` pulse role instead of leaving them as `unknown`, and treating canonical
  `partner` contact relationships plus normalized `wife`, `husband`, `girlfriend`, and
  `boyfriend`, and `married` relationship values as the pulse `partner` role instead of
  collapsing them into `friend` by substring matching or leaving them as `unknown`, while bounded
  close-kinship values such as `mom`, `mother`, `dad`, `father`, `son`, `daughter`, `parent`,
  `child`, `sibling`, `sister`, and `brother` should continue to map onto the existing pulse
  `distant_relative` bucket until Phase 2.5 introduces a richer family registry and pulse
  taxonomy. The same bounded pulse bridge should keep legacy or governed `family` / `family
  member` relationship values aligned with that `distant_relative` bucket instead of disagreeing
  with extraction, and it must also respect the same compatibility-visibility boundary as flat,
  readable, and planning surfaces so historical or severed support-only relationship facts do not
  reappear as current relationship truth during pulse nudging.
- Named-contact extraction here must also trim wrapper phrasing and same-clause continuation text
  out of captured display names so bounded current-state or work-linkage sentences such as
  `I work with a guy named Milo at Northstar Creative.`, `A person named Milo works with me.`, or
  `My friend Riley works with me at Lantern Studio.` do not persist malformed contact tokens such
  as `contact.a.guy.named.milo` or `contact.milo.at.northstar.creative`.
- When explicit named-contact relationship extraction already captured `contact.<token>.name`, the
  generic `my_is` fallback must fail closed for that same relationship sentence instead of
  persisting a parallel flat fact such as `supervisor = Dana`.
- Ambiguous bare relationship labels that are not yet backed by governed extraction should fail
  closed in downstream pulse or routing interpretation; today that means bare `report` is not
  treated as an `employee` alias until a bounded extraction/governance path exists for it.

## Related Tests
- `tests/core/profileMemoryQueries.test.ts`
- `tests/core/profileMemoryReadSession.test.ts`
- `tests/core/profileMemoryEpisodeState.test.ts`
- `tests/core/profileMemoryEpisodeNormalization.test.ts`
- `tests/core/profileMemoryEpisodeExtraction.test.ts`
- `tests/core/profileMemoryEpisodeLinking.test.ts`
- `tests/core/profileMemoryEpisodeMutations.test.ts`
- `tests/core/profileMemoryEpisodePlanningContext.test.ts`
- `tests/core/profileMemoryEpisodeQueries.test.ts`
- `tests/core/profileMemoryEpisodeResolution.test.ts`
- `tests/core/profileMemoryEpisodeConsolidation.test.ts`
- `tests/core/profileMemoryMediaIngest.test.ts`
- `tests/core/profileMemoryFactLifecycle.test.ts`
- `tests/core/profileMemoryMutations.test.ts`
- `tests/core/profileMemoryNormalization.test.ts`
- `tests/core/profileMemoryStateNormalization.test.ts`
- `tests/core/profileMemoryExtraction.test.ts`
- `tests/core/profileMemoryTruthGovernance.test.ts`
- `tests/core/profileMemoryEncryption.test.ts`
- `tests/core/profileMemoryPlanningContext.test.ts`
- `tests/core/profileMemoryPulse.test.ts`
- `tests/core/profileMemoryPersistence.test.ts`
- `tests/core/profileMemoryStore.test.ts`
- `tests/core/profileMemory.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed in `src/core/profileMemoryRuntime/`
- profile-memory runtime contracts move between this folder and `profileMemoryStore.ts`
- planner-context, state lifecycle, normalization, extraction, pulse, mutation, encryption,
  media-ingest normalization,
  readable-fact query, readable-episode query, episodic-memory linkage, episodic-memory,
  episodic-memory planning context, episodic-memory consolidation, or persistence ownership changes
- related profile-memory runtime tests move materially
