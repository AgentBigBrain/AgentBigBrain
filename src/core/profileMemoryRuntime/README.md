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
- shared profile-memory runtime contracts in `contracts.ts`, including bounded fact-review plus
  live fact-review mutation request or result shapes
- deterministic ingest provenance helpers and replay-safe synthetic source-task ids in
  `profileMemoryIngestProvenance.ts`
- source-lane ingest policy normalization and pre-extraction stage selection in
  `profileMemoryIngestPolicy.ts`, including default authority mapping for direct user text, voice
  transcripts, document text, document/model summaries, media summaries, and validated candidates
  before broad extractors are allowed to run
- bounded turn-local ingest receipt helpers in `profileMemoryIngestIdempotency.ts`
- deterministic retained ingest-receipt recovery and ordering helpers in
  `profileMemoryIngestReceiptNormalizationSupport.ts`
- request-scoped profile-memory telemetry helpers in `profileMemoryRequestTelemetry.ts`
- commitment signal classification helpers in `profileMemoryCommitmentSignals.ts`
- unresolved commitment topic extraction and matching in `profileMemoryCommitmentTopics.ts`
- canonical state creation and freshness helpers in `profileMemoryState.ts`
- additive graph-backed observation, claim, event, journal, index, read-model, and compaction
  contracts in `profileMemoryGraphContracts.ts`
- additive graph-backed state creation and fail-closed normalization in `profileMemoryGraphState.ts`
- additive graph-backed dual-write mutation batching for the stable encrypted-store seam in
  `profileMemoryGraphMutations.ts`
- additive graph-backed observation-lane persistence helpers in
  `profileMemoryGraphObservationSupport.ts`
- additive graph-backed observation redaction-lifecycle normalization helpers in
  `profileMemoryGraphObservationLifecycleSupport.ts`
- synthetic replay-marker helpers for legacy graph observations in
  `profileMemoryGraphObservationReplaySupport.ts`
- fail-closed legacy claim-lineage observation backfill helpers in
  `profileMemoryGraphLegacyClaimObservationBackfillSupport.ts`
- fail-closed semantic-duplicate active-claim repair helpers in
  `profileMemoryGraphClaimDeduplicationSupport.ts`
- bounded non-authoritative active-claim ambiguity guards in
  `profileMemoryGraphClaimAmbiguitySupport.ts`
- bounded current-surface eligibility guards for retained graph claims in
  `profileMemoryGraphClaimSurfaceEligibilitySupport.ts`
- fail-closed authoritative active-claim conflict repair helpers in
  `profileMemoryGraphClaimAuthoritativeConflictRepairSupport.ts`
- bounded claim-retention compaction helpers in
  `profileMemoryGraphClaimCompactionSupport.ts`
- bounded observation-retention compaction helpers in
  `profileMemoryGraphObservationCompactionSupport.ts`
- bounded event-retention compaction helpers in
  `profileMemoryGraphEventCompactionSupport.ts`
- additive graph-backed current-claim reconciliation helpers in
  `profileMemoryGraphClaimSupport.ts`
- additive graph-backed claim lifecycle normalization helpers in
  `profileMemoryGraphClaimLifecycleSupport.ts`
- additive graph-backed claim-successor pruning helpers in
  `profileMemoryGraphClaimSuccessorSupport.ts`
- synthetic replay-marker helpers for legacy active claims in
  `profileMemoryGraphClaimReplaySupport.ts`
- fail-closed legacy flat-fact graph backfill helpers in
  `profileMemoryGraphLegacyFactBackfillSupport.ts`
- additive graph-backed episode-event persistence plus explicit forget-redaction helpers in
  `profileMemoryGraphEventSupport.ts`
- bounded active event-surface eligibility helpers in
  `profileMemoryGraphEventSurfaceEligibilitySupport.ts`
- additive graph-backed event lifecycle normalization helpers in
  `profileMemoryGraphEventLifecycleSupport.ts`
- additive graph-backed entity-ref pruning helpers in
  `profileMemoryGraphEntityRefSupport.ts`
- additive graph-backed fact-redaction helpers in
  `profileMemoryGraphFactRedactionSupport.ts`
- additive graph-backed normalization, payload-salvage, and guard helpers in
  `profileMemoryGraphNormalizationSupport.ts`
- fail-closed raw graph payload normalization helpers in
  `profileMemoryGraphPayloadNormalizationSupport.ts`
- fail-closed graph record-id and retained-reference normalization helpers in
  `profileMemoryGraphRecordIdentityNormalizationSupport.ts`
- fail-closed graph metadata, semantic-identity, and bounded event-text normalization helpers in
  `profileMemoryGraphMetadataNormalizationSupport.ts`
- additive graph-backed observation-lineage pruning helpers in
  `profileMemoryGraphObservationLineageSupport.ts`
- additive graph-backed projection-source pruning helpers in
  `profileMemoryGraphProjectionSourceSupport.ts`
- small shared graph-state helper glue in `profileMemoryGraphStateSupport.ts`
- fail-closed graph timestamp normalization helpers in
  `profileMemoryGraphTimeNormalizationSupport.ts`
- derived graph index and read-model rebuild helpers in `profileMemoryGraphIndexing.ts`
- additive mutation-journal state helpers in `profileMemoryMutationJournal.ts`
- additive mutation-journal compaction and snapshot-watermark enforcement in
  `profileMemoryMutationJournal.ts`
- canonical mutation-journal replay-id builders in
  `profileMemoryMutationJournalIdentitySupport.ts`
- additive mutation-journal replay-window clamp helpers in
  `profileMemoryMutationJournalWindowSupport.ts`
- retained mutation-journal metadata and timestamp normalization helpers in
  `profileMemoryMutationJournalNormalizationSupport.ts`
- synthetic replay-backfill journal append helpers in
  `profileMemoryMutationJournalReplaySupport.ts`
- retained mutation-journal reference pruning helpers in
  `profileMemoryMutationJournalReferenceSupport.ts`
- canonical bounded temporal query contracts in `profileMemoryTemporalQueryContracts.ts`
- retrieval-only bounded temporal evidence selection in `profileMemoryTemporalQueries.ts`
- temporal evidence projection, lifecycle, and ranking helpers in
  `profileMemoryTemporalQueryEvidenceSupport.ts`
- temporal focus-entity selection helpers in `profileMemoryTemporalQuerySupport.ts`
- deterministic temporal truth synthesis in `profileMemoryTemporalSynthesis.ts`
- deterministic temporal lane arbitration helpers in
  `profileMemoryTemporalSynthesisSupport.ts`
- bounded stable-ref grouping and resolved-current graph query helpers in
  `profileMemoryGraphQueries.ts`
- canonical episodic-memory contracts in `profileMemoryEpisodeContracts.ts`
- canonical episodic-memory state helpers in `profileMemoryEpisodeState.ts`
- canonical episodic-memory normalization helpers in `profileMemoryEpisodeNormalization.ts`
- deterministic episodic-memory extraction in `profileMemoryEpisodeExtraction.ts`
- shared scenario-pattern orchestration helpers for deterministic episodic-memory extraction in
  `profileMemoryEpisodeScenarioSupport.ts`
- shared scenario-candidate primitives for deterministic episodic-memory extraction in
  `profileMemoryEpisodeScenarioPrimitives.ts`
- deterministic episodic-memory continuity linkage in `profileMemoryEpisodeLinking.ts`
- canonical episodic-memory upsert/merge helpers in `profileMemoryEpisodeMutations.ts`
- canonical episodic-memory upsert/merge helpers in `profileMemoryEpisodeMutations.ts`, including
  bounded `touchedEpisodeIds` reporting for batch-local graph event persistence
- bounded episodic-memory planner-context rendering in `profileMemoryEpisodePlanningContext.ts`
- approval-aware episodic-memory reads and continuity queries in `profileMemoryEpisodeQueries.ts`
  that can power bounded active-conversation recall and private remembered-situation review
- bounded episodic-memory resolution inference in `profileMemoryEpisodeResolution.ts`
- episodic-memory consolidation plus freshness/lifecycle ranking in
  `profileMemoryEpisodeConsolidation.ts`
- bounded interpreted media-ingest normalization in `profileMemoryMediaIngest.ts`, including
  candidate-only gating for document-derived summary/OCR/model meaning before durable episode
  extraction
- canonical fact upsert lifecycle helpers in `profileMemoryFactLifecycle.ts`
- bounded support-only transition repair for stale compatibility winners in
  `profileMemorySupportOnlyTransitionLifecycle.ts`
- key, value, sensitivity, and topic normalization helpers in `profileMemoryNormalization.ts`
- fail-closed retained flat-fact semantic normalization helpers in
  `profileMemoryFactRecordNormalizationSupport.ts`
- fail-closed retained flat-fact duplicate-id deduplication helpers in
  `profileMemoryRetainedFactDeduplicationSupport.ts`
- fail-closed retained active-fact conflict repair helpers in
  `profileMemoryRetainedFactConflictRepairSupport.ts`
- focused mixed-policy retained active-fact replay repair helpers in
  `profileMemoryRetainedMixedPolicyConflictRepairSupport.ts`
- fail-closed retained flat-fact truth-governance reload helpers in
  `profileMemoryRetainedFactGovernanceSupport.ts`
- canonical persisted state normalization helpers in `profileMemoryStateNormalization.ts`
- deterministic user-input candidate extraction in `profileMemoryExtraction.ts`
- family-specific explicit review correction validation in
  `profileMemoryReviewMutationValidation.ts`
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
- shared bounded contact-context and third-person continuity extraction helpers in
  `profileMemoryContactContinuitySupport.ts`
- deterministic suppression rules for generic fallback facts that would otherwise duplicate
  governed named-contact relationship facts in `profileMemoryGenericFactSuppression.ts`
- canonical encryption envelope and key parsing helpers in `profileMemoryEncryption.ts`
- pulse continuity helpers in `profileMemoryPulse.ts`
- planner-context rendering and query-aware ranking in `profileMemoryPlanningContext.ts`
- approval-aware readable-fact queries in `profileMemoryQueries.ts`
- query-time inspection, decision-record emission, and approval-aware fact-review selection in
  `profileMemoryQueries.ts`
- shared fail-closed compatibility visibility rules for flat fact projection plus bounded
  readable-fact and query surfaces in `profileMemoryCompatibilityVisibility.ts`
- registry-backed multi-value inventory caps for bounded query/planning selectors in
  `profileMemoryPlanningContext.ts`
- request-scoped reconciled read-session reuse in `profileMemoryReadSession.ts`
- shared bounded continuity-scope query helpers in
  `profileMemoryContinuityScopeSupport.ts`
- shared graph-aware fact-continuity hint expansion, scoped-thread metadata, and compatibility
  temporal fallback helpers in `profileMemoryFactContinuitySupport.ts`
- shared readable-fact projection, sensitivity gating, and query-disposition helpers in
  `profileMemoryFactQuerySupport.ts`
- shared bounded continuity and fact-inspection contracts in
  `profileMemoryQueryContracts.ts`
- closed truth-governance contracts in `profileMemoryTruthGovernanceContracts.ts`
- code-owned family registry entries plus registry-backed action guards in
  `profileMemoryFamilyRegistry.ts`
- extracted registry support constants for adjacent-domain defaults and contact compatibility
  projection tables in `profileMemoryFamilyRegistrySupport.ts`
- approved `contact.*` compatibility-projection table ownership in
  `profileMemoryFamilyRegistry.ts`, so flat contact-surface visibility stays code-owned and CI-
  checked instead of drifting as ad hoc per-family defaults
- family-level plus heuristic-backed sensitivity-floor helpers for governed fact candidates and
  legacy fact visibility in `profileMemoryFactSensitivity.ts`
- exact-source allowlists for deterministic truth-governance seams in
  `profileMemoryTruthGovernanceSources.ts`, plus the canonical source-family matrix that keeps
  document text, document/model summaries, media summaries, lexical relationship patterns, and
  lexical episode patterns candidate-only by default unless a family-specific review/governance
  rule explicitly allows a narrower outcome
- initial mutation-time decision-record contracts in `profileMemoryDecisionRecordContracts.ts`
- initial retraction and redaction contracts in `profileMemoryRetractionContracts.ts`
- minimum mutation-envelope contracts in `profileMemoryMutationEnvelopeContracts.ts`
- shared bounded candidate-ref, input-identity, rollback-handle, and ref-dedup helpers in
  `profileMemoryMutationEnvelopeSupport.ts`
- provenance-backed ingest plus bounded episode-review and fact-review mutation-envelope
  construction in `profileMemoryMutationEnvelope.ts`
- explicit remembered-situation and fact-review mutation-envelope construction in
  `profileMemoryReviewMutationEnvelope.ts`
- closed governance-family inference for fail-closed source-authority decisions in
  `profileMemoryGovernanceFamilyInference.ts`
- deterministic candidate governance classification in `profileMemoryTruthGovernance.ts`
- shared canonical decision builders for episode and end-state governance in
  `profileMemoryTruthGovernanceDecisionSupport.ts`
- commitment-resolution and candidate-apply helpers in `profileMemoryMutations.ts`
- env configuration plus encrypted disk I/O helpers in `profileMemoryPersistence.ts`
- bounded user-review plus explicit correction or forgetting flows for remembered situations and
  remembered facts, still brokered through stable interface and memory-broker entrypoints

## Invariants
- `profileMemoryStore.ts` remains the stable encrypted-store entrypoint while canonical runtime
  contracts and query, pulse, mutation, persistence, and episodic-memory helpers move here.
- Sensitive fact reads stay fail-closed unless the request carries explicit human approval.
- Planner context generation stays bounded and deterministic for the same state/query input.
- State creation, freshness downgrades, fact upserts, and persisted-state normalization belong here
  even when `profileMemory.ts` keeps the stable public export surface.
- The encrypted profile-memory envelope now carries graph-authoritative personal-memory state plus
  derived compatibility caches under the stable store boundary. Stable public fact and episode
  reads may still project from those bounded compatibility surfaces, but planner and continuity
  retrieval now consume the canonical graph-backed temporal seams instead of rebuilding truth from
  flat arrays.
- Phase 3 graph persistence is now live for fact-side observations or claims and episode-backed
  events under the stable store seam, and explicit episode forget now redacts persisted graph
  events into bounded audit markers plus redacted journal entries instead of leaving raw event
  payloads behind. Stable public review and compatibility reads may still project from bounded
  `facts[]` and `episodes[]`, but planner and continuity paths now cut over through canonical
  graph-backed retrieval and temporal synthesis instead of re-owning truth on flat arrays.
- Phase 3 load normalization now backfills missing graph events for legacy non-terminal episodes
  and appends one synthetic replay marker for that bounded backfill. The same bounded repair now
  covers truly legacy active graph events and active graph claims when retained replay coverage is
  still missing in one uncompacted journal state, and truly legacy fact-only stores with no
  aligned active non-redacted current-claim lane now backfill governed active current-state or
  end-state flat facts into graph observations plus current claims, even when only inactive or
  redacted claim residue remains or one stale active winner survives: matching surviving
  observation evidence is reused, only the missing governed observations are minted, stale active
  winners close fail-closed against the rebuilt canonical current winner, and the synthetic claim
  replay marker still belongs only to the surviving active claim. Truly legacy observation-only
  graph state with missing retained replay coverage in one uncompacted journal now gets one
  synthetic replay marker too, so standalone or support-only graph observations no longer remain
  outside retained replay coverage. Malformed retained compaction metadata also no longer block
  that repair: Phase 3 load normalization now clamps impossible persisted `snapshotWatermark`
  values against the retained journal window before replay backfill runs, so stale compaction
  envelopes cannot suppress needed synthetic replay markers. The same replay-window repair now
  also clamps impossible retained `nextWatermark` values back to the actual compacted or retained
  replay boundary plus one, so malformed empty journals cannot emit synthetic replay markers at
  ghost watermarks or inflate the derived read-model watermark. Legacy
  claim-side lineage repair now also reconnects active non-redacted claims that
  still have no usable observation lineage, even when the observation lane is only partially
  populated: matching surviving observations reuse their existing ids, stale or missing lineage ids
  are replaced, and only still-detached claims mint one synthetic observation. These repairs stay
  fail-closed to uncompacted missing-coverage or detached-claim-lineage state only so
  already-compacted graphs do not churn synthetic replay markers or duplicate graph truth on later
  loads. That lets pre-graph unresolved situations, pre-graph current winners, legacy fact-only
  canonical winners, legacy observation-only evidence, and legacy claim-only or partially populated
  current state enter the additive graph path without reopening extractor ownership or
  resurrecting already-compacted terminal events.
- Phase 3 now keeps explicit fact-review correction on the same additive graph-backed write lane as
  canonical ingest: `mutateFactFromUser(... action: "correct")` appends a review-sourced graph
  observation, reconciles the current graph claim, and records the bounded journal mutation instead
  of leaving correction-only truth on the flat compatibility surface.
- Phase 3 now also keeps explicit fact-forget on a graph-backed redaction lane: `mutateFactFromUser(
  ... action: "forget")` redacts matching graph observations and claims into policy-scoped audit
  markers, drops those redacted claims out of derived indexes and current-state read models, and
  records one redacted journal mutation instead of leaving deleted raw values in additive graph
  proof.
- Graph-backed indexes and read models are derived surfaces, not canonical truth. Normalization
  must rebuild them from canonical graph records and journal watermark state instead of trusting
  persisted cache payloads.
- Graph-backed index rebuild must also fail closed on malformed duplicate `entityRefIds` inside one
  retained claim or event payload: each bucket in `indexes.byEntityRefId` may list a given record
  id at most once, even when older persisted graph payloads repeat the same entity ref.
- Graph-backed normalization must also fail closed on duplicate or dangling
  `derivedFromObservationIds` in retained claims and events: surviving graph records may keep only
  unique observation-lineage ids that still exist after observation normalization and compaction.
- Graph-backed normalization must also fail closed on malformed claim successor refs: active claims
  may not carry `endedByClaimId`, and inactive claims may keep `endedByClaimId` only when it
  points at one surviving successor claim with the same family and normalized key.
- Graph-backed normalization must also fail closed on malformed claim lifecycle boundaries: active
  non-redacted claims may not keep `validTo` or `endedAt`, inactive claims must collapse to one
  deterministic closure boundary, and redacted claims must become inactive with bounded closure
  timestamps, clear raw `normalizedValue`, and force `sensitive = true` instead of remaining
  active indefinitely or keeping deleted raw fact values visible in retained graph state.
- Graph-backed normalization must also fail closed on malformed observation redaction boundaries:
  non-redacted observations may not keep stray `redactedAt`, and redacted observations must carry
  a bounded `redactedAt`, clear raw `normalizedValue`, and force `sensitive = true` instead of
  leaving deleted raw fact values visible in retained graph proof.
- Graph-backed normalization must also fail closed on malformed graph payload timestamps before
  lifecycle repair runs: invalid required `assertedAt` or `observedAt` fields repair to the bounded
  normalization timestamp, while invalid optional lifecycle fields such as `validFrom`, `validTo`,
  `endedAt`, or `redactedAt` clear to `null` so the existing claim, observation, and event
  lifecycle helpers can apply one deterministic fallback boundary.
- Graph-backed normalization must also fail closed on blank or padded graph metadata, record ids,
  retained refs, and semantic identity plus retained journal metadata: whitespace-only graph
  `stableRefId` and `sourceTaskId` values now trim to canonical non-empty strings or clear to
  `null`, whitespace-only required graph `sourceFingerprint` values now trim to canonical non-empty
  strings or repair to one deterministic per-record fallback fingerprint, graph
  `observationId`/`claimId`/`eventId` plus retained `endedByClaimId`, observation-lineage refs,
  entity refs, and retained mutation-journal observation or claim or event refs now trim to one
  canonical non-empty id before replay, successor, lineage, or journal pruning compare them, graph
  observation or event `family` plus graph observation or claim `normalizedKey` and
  `normalizedValue` now trim to canonical strings while whitespace-only optional semantic fields
  clear to `null`, non-redacted graph event `title` and `summary` now trim to canonical strings or
  fail closed to bounded placeholders, padded graph `sourceTier`, `timePrecision`, `timeSource`,
  and optional `redactionState` now trim before envelope filtering drops otherwise valid retained
  graph payloads, graph claim `family` and `normalizedKey` now trim to
  canonical strings or fail closed to `""`, retained journal `sourceTaskId`,
  `sourceFingerprint`, and `mutationEnvelopeHash` values now trim to canonical non-empty strings
  or clear to `null`, retained journal `redactionState` now trims to the bounded canonical
  vocabulary before journal normalization drops otherwise valid replay entries, retained journal
  `recordedAt` now trims and normalizes to canonical ISO or repairs omitted, non-string, and
  malformed values to the graph normalization timestamp instead of surviving as raw malformed time
  text, retained graph compaction
  `lastCompactedAt` now trims and normalizes to canonical ISO or clears to `null` instead of
  surviving as raw malformed compaction metadata, and whitespace-only or non-string retained
  `journalEntryId` values now repair to one canonical replay id derived from the trimmed retained
  payload instead of dropping an otherwise valid replay entry. Retained graph-envelope `createdAt`
  now also trims and normalizes to canonical ISO or repairs to the graph normalization timestamp
  at envelope admission, and later retained-record repair helpers preserve that canonical envelope
  timestamp instead of re-stamping repaired envelopes with the latest normalization clock. Retained
  graph payload timestamps now also trim before canonical time repair, so padded `assertedAt`,
  `observedAt`, `validFrom`, `validTo`, `endedAt`, and `redactedAt` values canonicalize instead of
  falling through the malformed-value fallback path. Retained graph state `updatedAt` now also
  trims and normalizes to canonical ISO or repairs to the outer profile-memory normalization
  timestamp, so padded persisted graph envelope clocks canonicalize before graph-level replay,
  journal, and read-model rebuild use them. Legacy flat-fact graph backfill now also trims
  persisted fact `observedAt` before observation reuse, observation creation, and current-claim
  rebuild consume it, so padded retained fact timestamps no longer break reused observation
  lineage or force rebuilt graph observations and claims onto the fallback normalization clock.
  Legacy flat-fact graph backfill and current-claim reconciliation now also trim retained fact
  keys before winner selection and family inference, so padded retained flat-fact keys no longer
  fail closed out of reused observation matching or downgrade rebuilt current claims into the
  generic family lane. Those current-winner bridges now also canonicalize retained flat-fact
  `observedAt` and `lastUpdatedAt` before winner ordering, so offset-formatted or padded
  persisted fact timestamps no longer win or lose only because their raw strings sort
  differently from canonical time order. They also fail closed malformed retained flat-fact
  confidence outside the bounded `0..1` lane before winner selection, so out-of-range persisted
  confidence values no longer keep the wrong graph current winner alive. Legacy flat-fact graph
  normalization now also canonicalizes retained fact `observedAt`, `lastUpdatedAt`,
  `confirmedAt`, and `supersededAt` on the compatibility lane itself, so padded retained
  timestamps no longer leak raw persisted forms through direct fact reads, confirmed facts repair
  missing `confirmedAt` to one bounded lifecycle timestamp, and superseded facts repair missing
  `supersededAt` while active facts clear stray supersession markers fail-closed.
  That same compatibility lane now also canonicalizes retained fact `id`, `key`, `value`,
  `source`, and `sourceTaskId`, so padded persisted ids, semantics, or provenance no longer leak
  raw forms through direct fact reads, planner context, or query-aware selection once the
  encrypted store is loaded. Whitespace-only retained fact ids now fail closed instead of
  surviving as empty identifiers, and retained facts whose canonicalized `key` or normalized
  `value` becomes blank now drop instead of surviving as semantically empty compatibility facts.
  Blank retained `sourceTaskId` or `source` values now also fail closed instead of surviving as
  provenance-invalid compatibility facts that the live upsert path would already reject. Retained
  flat facts now also reload with the effective family sensitivity floor applied, so persisted
  weak `sensitive` bits can no longer survive encrypted load on families like `residence.current`.
  That same compatibility lane now also re-applies deterministic truth governance during
  encrypted reload, so retained fact family/source combinations that live mutation would
  quarantine no longer survive compatibility reads or Phase 3 graph repair just because they were
  already persisted. It now also dedupes malformed retained duplicate fact ids to one
  deterministic canonical winner, so encrypted reload no longer surfaces the same persisted fact
  twice on compatibility reads or legacy graph repair. It now also repairs malformed active same-
  key same-value retained facts that survived with different ids back into one canonical active
  winner plus superseded audit history, so encrypted reload matches the live fact-upsert invariant
  instead of surfacing duplicate current truth through compatibility reads or legacy graph repair.
  It now also repairs malformed active same-key different-value retained facts on replace-only
  families back into one canonical active winner plus superseded audit history, while preserve-
  prior families stay untouched so encrypted reload still matches the live family-governed upsert
  lane instead of manufacturing conflicting current truth on compatibility reads or legacy graph
  repair. That same compatibility lane now also repairs malformed preserve-prior same-key
  different-value retained conflicts that still carry multiple confirmed winners, so encrypted
  reload keeps one confirmed incumbent while conflicting challengers stay active but `uncertain`
  instead of leaking multiple confirmed current winners into compatibility reads or legacy graph
  repair. When preserve-prior same-key different-value retained conflicts have no confirmed
  incumbent at all, encrypted reload now still backfills bounded support observations but fails
  closed on the graph bridge by suppressing current-claim projection instead of manufacturing a
  synthetic current winner from ambiguous uncertain state. Mixed-policy retained
  `followup.*` same-key conflicts now also replay into one live-upsert-valid compatibility shape
  during raw normalization, and the existing load-time follow-up reconciliation pass then closes
  any surviving unresolved challenger behind the resolved winner instead of preserving impossible
  confirmed combinations through encrypted reload. The graph claim lane now also repairs malformed
  authoritative same-key different-value active claims during retained graph normalization:
  replace-authoritative families such as `identity.preferred_name` and mixed-policy
  `followup.*` groups with a surviving `followup.resolution` end-state claim now close conflicting
  active challengers fail-closed behind one deterministic winner before derived graph indexes or
  read-model current-state surfaces rebuild, while preserve-prior ambiguity still stays visible
  only through `conflictingCurrentClaimIdsByKey`. That same non-authoritative ambiguity lane now
  also no longer mints synthetic replay markers or synthetic detached-lineage observations during
  retained graph normalization, so preserve-prior singular-current claim conflicts stay visible in
  canonical claim state and the derived conflict surface without manufacturing synthetic lineage
  proof. Legacy fact backfill now also treats an active retained current claim as already aligned
  only when that claim still qualifies for the same bounded current or end-state surface, so
  matching surviving observations can still be reused but current-surface-ineligible retained
  claims no longer suppress governed current-claim rebuild during encrypted reload.
  That same legacy fact-backfill lane now also always reruns bounded current-claim reconciliation
  even when the retained active claim is only semantically aligned, so same-id retained current
  claims with stale metadata or empty surviving lineage now reload with canonical timestamps,
  canonical `sourceTaskId`, deterministic claim fingerprint, matching observation linkage, and
  preserved canonical envelope `createdAt` instead of preserving stale payload or re-stamping the
  envelope birth time just because no new observation backfill was needed. The same same-id
  repair now also fail-closes stray retained claim `entityRefIds`, so fact-backed current claims
  no longer keep malformed entity linkage or derived entity-ref index buckets that live mutation
  would never emit. That same current-claim merge now also fail-closes stale retained
  `projectionSourceIds`, so semantically unchanged current claims no longer keep
  superseded-but-still-retained fact ids once the canonical winner fact changes.
  Semantic-duplicate retained current-claim repair now also fail-closes loser-side
  `projectionSourceIds`, `entityRefIds`, `stableRefId`, and `sourceTaskId`, so duplicate retained
  winners keep merged supporting observations but no longer inherit stale loser fact lineage,
  stray entity linkage, or mismatched loser provenance on the pure retained-claim lane.
  Retained commitment-signal `mutationAudit` metadata now also clears fail-closed when
  `matchedRuleId` or `rulepackVersion` trims blank, so encrypted reload no longer keeps fake rule
  proof on otherwise valid facts. The same retained audit seam now also canonicalizes bounded
  `classifier`, `category`, and `confidenceTier` enums when they are only padded or mis-cased, so
  otherwise valid commitment-signal audit metadata no longer drops during encrypted reload.
  That same compatibility lane now also fail-closes retained fact `confidence` outside the bounded
  `0..1` interval to `0`, so malformed persisted confidence no longer leaks raw values through
  direct fact reads, planner context, query-aware selection, broker projection, or review output.
  It now also canonicalizes retained fact `status` strings into the bounded
  `confirmed|uncertain|superseded` vocabulary before compatibility reads and Phase 3 graph repair
  consume them, so padded or mis-cased persisted lifecycle markers no longer drop otherwise valid
  facts out of direct reads or legacy graph backfill.
  Retained ingest-receipt normalization now also trims retained `turnId`, `sourceFingerprint`, and
  `sourceTaskId`, recomputes the derived `receiptKey`, dedupes one canonical winner per receipt,
  and reapplies the bounded receipt cap, so same-turn idempotency survives encrypted store load
  instead of comparing trimmed live provenance against stale raw receipt ids or retaining duplicate
  or overgrown receipt ledgers. The same repair now also recovers otherwise valid retained receipts
  when the stored `receiptKey` field itself is malformed, because load normalization no longer
  requires that stale derived field before it recomputes the canonical key from provenance. It now
  also recovers otherwise valid retained receipts when the stored `recordedAt` field is missing or
  malformed, because that replay timestamp now falls back deterministically to the outer
  normalization clock instead of dropping the retained receipt outright. Duplicate retained
  receipts now also collapse by canonical `recordedAt` recency instead of raw array order, so an
  older duplicate can no longer overwrite a newer winner just by appearing later in persisted
  state. The same retained receipt seam now also recovers otherwise valid retained receipts when
  the stored `sourceTaskId` field is blank or malformed, because that provenance field now repairs
  to a deterministic receipt-key-derived fallback instead of dropping the retained receipt
  outright. Equal canonical `recordedAt` ties now also break on canonical receipt identity instead
  of raw persisted array order, and duplicate retained receipts prefer one real trimmed
  `sourceTaskId` over a deterministic recovered fallback when replay time is otherwise the same.
  Otherwise valid retained receipts now also survive when only stored `turnId` or
  `sourceFingerprint` is malformed but the canonical retained `receiptKey` still survives load,
  because those replay-proof metadata fields now repair to deterministic receipt-key-derived
  fallbacks instead of dropping the retained receipt outright.
  Legacy flat-fact graph
  backfill now also trims persisted fact `sourceTaskId` before reused-observation matching and
  synthetic backfill fingerprints, so padded retained fact provenance no longer duplicates
  already-canonical observation evidence or hashes to second synthetic backfill records. The same
  legacy fact-backfill seam now also trims retained fact `key` and `value` before synthetic
  backfill fingerprints are hashed, so padded retained fact semantics no longer change observation
  `sourceFingerprint` values or synthetic observation ids when the meaning is unchanged. That same
  legacy fact-backfill seam now also canonicalizes retained fact `observedAt` before synthetic
  backfill fingerprints are hashed, so padded or offset-formatted retained timestamps no longer
  change observation `sourceFingerprint` values or synthetic observation ids when they name the
  same instant. The same legacy fact-backfill seam now also trims and lowercases retained fact
  `source` before synthetic
  observation id and backfill-fingerprint derivation, so padded or mis-cased source identifiers no
  longer hash to a second synthetic observation or synthetic backfill record when the semantic
  source is unchanged. That same bridge now also repairs stale active legacy claims when the
  stored claim `sensitive` bit lags behind the effective family floor, so bounded families like
  `residence.current` no longer survive load normalization or encrypted store load with weaker
  graph-claim sensitivity than the live read/review surfaces already enforce. Aligned legacy
  claims also no longer short-circuit observation-side family-floor repair: when a stored active
  claim already matches the winner family and value but its supporting observation still carries a
  stale weak `sensitive` bit, Phase 3 normalization now still reuses and repairs that observation
  instead of exiting early. Whitespace-only retained flat-fact `supersededAt` values now also fail
  closed back to the
  active lane on the Phase 3 graph bridge, so malformed persisted active facts no longer drop out
  of legacy observation backfill or current-claim repair just because the stored lifecycle marker
  is blank text instead of `null`. Retained flat-fact `id` values now also trim before the legacy
  current-winner tie-break runs, so padded persisted fact ids no longer keep the wrong graph
  current winner alive once status, confidence, and timestamps are otherwise tied. Retained
  flat-fact and episode ids now also trim before graph
  projection lineage emitters and projection-source
  pruning, so padded retained source ids no longer get treated as dangling and no longer survive
  into rebuilt current claims or graph events as padded projection refs. Retained episode ids now
  also trim before graph event id derivation and load-time event backfill lookup, so padded
  episode ids no longer hash to a second graph event or miss an already-canonical retained event.
  Legacy claim-lineage observation backfill now also trims retained claim `assertedAt` or
  `validFrom` before detached or stale-lineage repair compares surviving observations or mints one
  synthetic observation, so padded retained claim timestamps no longer break observation reuse or
  force repaired claim lineage onto the fallback normalization clock. The same bounded claim-
  lineage repair now also ignores surviving observation refs only when they still point at the
  same claim semantic lane with a conflicting normalized value, so semantically mismatched retained
  lineage no longer suppresses deterministic relink or backfill while unrelated supporting
  observations can still count as usable lineage. Canonical claim-lineage pruning now also removes
  those surviving same-lane conflicting refs from retained claim payloads when unrelated
  supporting lineage still remains, so Phase 3 normalization no longer preserves malformed
  conflicting claim evidence just because no synthetic observation repair is needed.
- Graph-backed normalization must also fail closed on malformed event lifecycle boundaries:
  non-redacted events may not keep stray `redactedAt`, redacted events must carry a bounded
  `validTo`, and redacted event payloads must collapse to audit-safe placeholders instead of
  retaining raw titles, raw summaries, event-linked entity refs, or observation lineage.
  Observation compaction must consume those repaired event payloads on both load normalization and
  live graph writes, so malformed redacted events cannot keep stale observation lineage alive after
  redaction cleanup clears it.
- Graph-backed normalization must also fail closed on duplicate or dangling projection-source refs:
  claims may keep only surviving fact ids in `projectionSourceIds`, and events may keep only
  surviving episode ids.
- Graph-backed normalization must also fail closed on duplicate `entityRefIds` in retained
  observations, claims, and events: canonical graph payloads should keep one sorted entity-ref list
  per record instead of leaving repeated refs for later readers to repair.
- Phase 3 normalization now also fails closed on duplicate graph record ids: observations, claims,
  and events keep only the freshest valid envelope for a given canonical record id before derived
  indexes or read models rebuild.
- Phase 3 read-model rebuild now also fails closed on duplicate active claims for one normalized
  key: exact semantic duplicates for the same family, key, and value now collapse to one canonical
  active claim while the duplicate records stay as inactive audit history so journal refs remain
  valid. Authoritative same-key different-value active claims now also repair fail-closed behind
  one deterministic active winner, while preserve-prior conflicting active claims still remain
  visible in graph inventory and indexes for audit or later repair. `currentClaimIdsByKey` stays
  empty for preserve-prior conflicting keys, while `conflictingCurrentClaimIdsByKey` records the
  bounded conflicting active claim ids instead of letting malformed retained state silently pick
  one winner by recency. Derived family and
  current-state surfaces now also fail closed on blank semantic claim keys: active claims with a
  blank `family` or `normalizedKey` no longer enter `byFamily`, `inventoryClaimIdsByFamily`, or
  `currentClaimIdsByKey`, and whitespace-only event families no longer create junk `byFamily`
  buckets. Those malformed blank-family or blank-key active claims also stay canonical-only during
  replay repair and detached-lineage repair: they no longer receive synthetic replay markers or
  synthetic observation-lineage backfill during Phase 3 normalization. The same bounded guard now
  applies to malformed active claims with null or blank current values too: they stay out of
  synthetic replay repair, synthetic observation-lineage backfill, and read-model current or
  inventory surfaces while the canonical graph records remain available for audit and later repair.
  Support-only or auxiliary retained claim families such as `contact.context` now follow that same
  canonical-only rule too: Phase 3 read-model current/inventory rebuild, synthetic claim replay
  repair, and synthetic detached-lineage observation backfill all skip those claims, while
  canonical end-state families such as `followup.resolution` remain eligible for the bounded graph
  claim surface. Malformed retained claims whose persisted payload `family` disagrees with the
  governed family implied by their normalized key and value now also stay canonical-only for that
  same reason: they remain visible in audit indexes but no longer receive synthetic replay or
  detached-lineage repair and no longer surface as bounded current-claim truth. Those same
  family-mismatched retained claims now also stay out of authoritative same-key conflict repair
  and preserve-prior ambiguity grouping, so they cannot close aligned current winners fail-closed
  or suppress bounded replay and lineage repair for otherwise valid aligned claims. Retained graph
  claims now also fail closed on non-explicit source tiers whose live truth-governance outcome is
  family-deterministic: malformed `assistant_inference` or `reconciliation_or_projection` claims
  can stay canonical-only for audit, but they no longer surface as bounded current truth or
  participate in authoritative conflict repair or preserve-prior ambiguity grouping unless the
  governed family still allows that retained tier, such as `followup.resolution`. That same
  bounded eligibility lane now also gates semantic-duplicate active-claim repair, so
  current-surface-ineligible retained duplicates can remain canonical-only for audit but no longer
  close a valid explicit twin before the bounded current surface rebuilds.
- Phase 3 now enforces bounded mutation-journal retention too: load normalization and live graph
  writes must honor the configured journal cap, preserve one replay-safe `snapshotWatermark` for
  the compacted prefix, and leave current compatibility retrieval untouched while the graph-backed
  path is still additive. That same compaction lane now also clamps stale retained
  `snapshotWatermark` values against the surviving replay window even when the journal never
  overflows the retention cap, without restamping `lastCompactedAt` or pretending the journal body
  changed, and the public encrypted store seam now proves both under-cap clamp shapes during
  persisted load: surviving retained replay rows stay undisturbed, and empty retained journal
  suffixes still clamp replay-safe compaction state without restamping `lastCompactedAt`. When the
  retained journal suffix is empty, that replay-safe clamp now stays anchored to
  `nextWatermark - 1`, so the compacted replay prefix remains explicit even after all retained
  entries have aged out. When both the retained journal suffix and compaction metadata are already
  replay-safe, the helper now also stays a true no-op instead of rewriting either envelope, and
  the public encrypted store seam now proves that same replay-safe no-op shape during persisted
  load too. When retention really does trim an older replay prefix, the helper now also keeps that
  compacted prefix explicit by advancing `snapshotWatermark` to the last removed replay entry and
  stamping `lastCompactedAt` to the compaction run timestamp. The public graph-mutation seam now
  also proves that one fresh canonical episode-event append compacts the oldest retained replay row
  on the same call when that append pushes the journal past `maxJournalEntries`, keeping the live
  replay window bounded without waiting for a later persisted load repair. That same public
  graph-mutation seam now also proves the under-cap clamp shape with surviving retained replay rows:
  a touched same-id episode-event no-op still repairs stale `snapshotWatermark` against the live
  retained replay window without appending churn or restamping `lastCompactedAt`. That same public
  graph-mutation seam now also proves the empty-retained clamp shape: a touched same-id
  episode-event no-op still repairs stale `snapshotWatermark` against `nextWatermark - 1` when no
  retained replay rows remain, again without appending churn or restamping `lastCompactedAt`. When
  retained replay rows and compaction metadata are already replay-safe, that same public
  graph-mutation seam now also stays a true no-op instead of rewriting the graph envelope just
  because a touched same-id episode-event passed through the live mutation path. That same public
  live no-op contract now also has explicit redacted-episode coverage: when a retained redacted
  same-id event and its replay window are already canonical, the redaction path stays a true no-op
  instead of rewriting the graph envelope. The public graph-mutation seam now also proves the same
  redacted lane repairs stale `snapshotWatermark` both against surviving retained replay rows and
  against `nextWatermark - 1` when the retained journal is empty, again without appending churn or
  restamping `lastCompactedAt`. When a new canonical redacted episode-event append pushes the live
  journal past `maxJournalEntries`, that same public redaction lane now also compacts the oldest
  retained replay row on the same call and advances `snapshotWatermark` to the last removed replay
  entry.
- Phase 3 journal normalization now also fails closed on malformed duplicate replay state:
  duplicate `journalEntryId` values keep one deterministic winner, duplicate or non-monotonic
  watermarks repair to one strictly increasing replay sequence, and repeated observation or claim
  or event refs inside one retained journal entry dedupe before compaction or read-model rebuild.
  Retained journal entries that share one canonical replay payload now also collapse behind one
  canonical replay id even when their stored `journalEntryId` values differ, so load normalization
  cannot preserve payload-duplicate replay state that live append would already coalesce. Dangling
  retained journal refs to graph records that no longer survive normalization must also prune
  before compaction, and ghost retained entries with no surviving refs must drop instead of
  keeping fake replay lineage alive. When that pruning changes the retained replay payload, the
  surviving journal entry now recanonicalizes to the new replay id and any newly-equal post-prune
  payload groups also collapse behind one canonical replay id instead of leaving stale replay ids
  or duplicate replay entries alive after the ref cleanup lane.
- Phase 3 now enforces bounded observation retention too: once the retained journal window moves
  forward, unreferenced observations may compact under the configured observation cap, while
  observations still referenced by surviving claims, surviving events, or retained journal entries
  must remain. Redacted events only protect lineage that survives event lifecycle normalization, so
  cleared redacted-event lineage no longer blocks observation compaction during load normalization.
  Redacted claims also stop protecting stale observation lineage once the retained journal window
  no longer protects that lineage, so fact-forget audit history cannot silently keep superseded
  observation payloads alive. Claims that are no longer eligible for the bounded current or
  canonical end-state surface also stop protecting observation lineage once the retained journal
  window moves past them, so malformed support-only, family-mismatched, or source-tier-invalid
  claim audit residue cannot pin stale observations indefinitely.
- Phase 3 now enforces bounded claim retention too: once the retained journal window moves
  forward, inactive claims may compact under the configured claim cap, while retained journal refs
  must still survive. Active claims now only stay automatically protected when they still qualify
  for the bounded current or canonical end-state surface, so malformed audit-only active claims no
  longer evade compaction just because their payload still says `active = true`.
- Phase 3 now enforces bounded event retention too: once the retained journal window moves
  forward, terminal or redacted events may compact under the configured event cap, while active
  events and events still referenced by retained journal entries must remain.
- Load normalization now also fail-closes retained active `episode.candidate` events whose
  explicit episode `projectionSourceIds` are all dangling against a surviving retained episode
  set, so those malformed audit-only events can no longer mint synthetic replay markers or pin
  event-derived observation retention. The older legacy replay lane still stays intact whenever no
  retained episode set exists yet or the event never carried projection lineage at all.
- Load normalization also fail-closes retained active `episode.candidate` events whose
  `sourceTier` is already quarantined by live governance, such as
  `validated_structured_candidate` or `reconciliation_or_projection`, so those malformed
  audit-only events can remain canonical-only for audit but can no longer mint synthetic replay
  markers or pin event-derived observation retention.
- Load normalization also repairs retained unresolved `episode.candidate` events from surviving
  canonical episodes when the retained event with the same deterministic `eventId` no longer
  qualifies for the bounded active surface. Those malformed retained events now rebuild from the
  canonical episode instead of blocking governed event backfill just because the persisted
  `eventId` already exists.
- Load normalization also repairs retained unresolved `episode.candidate` events from surviving
  canonical episodes when a retained event with the same deterministic `eventId` survives but is
  missing the canonical surviving episode id in `projectionSourceIds`. Those malformed retained
  events now rebuild from the canonical episode instead of staying on the older legacy no-lineage
  lane just because the persisted `eventId` already exists.
- Load normalization also repairs retained unresolved `episode.candidate` events from surviving
  canonical episodes when a retained event with the same deterministic `eventId` keeps the
  canonical surviving episode projection source but its payload no longer matches the surviving
  episode. Those malformed retained events now rebuild from the canonical episode instead of
  preserving stale unresolved-event text, timing, sensitivity, or entity refs on the canonical
  event id, and they now also preserve canonical envelope `createdAt` instead of re-stamping
  event birth time during the same-id repair.
- Load normalization also repairs retained terminal `episode.candidate` events from surviving
  canonical episodes when an already-retained event with the same deterministic `eventId` keeps
  surviving but its payload or canonical projection lineage no longer matches the surviving
  episode. Those malformed retained events now rebuild from the canonical episode instead of
  preserving stale resolved-event text, timing, sensitivity, or entity refs on the canonical
  event id, and they now also preserve canonical envelope `createdAt` instead of re-stamping
  event birth time during the same-id repair, while still not minting brand-new historical
  terminal events during load.
- Same-id retained `episode.candidate` event repair also stays a true no-op when the surviving
  canonical episode already matches the retained payload after canonical `createdAt` preservation,
  so load normalization does not emit fake touched-event churn or empty replay and journal activity.
- Same-id retained redacted-event repair also stays a true no-op when canonical forget state
  already matches the retained audit-safe payload after canonical `createdAt` preservation, so
  repeated canonical forget repair does not emit fake touched-event churn or empty journal
  activity.
- Fact-forget graph observation and claim repair now also preserves canonical envelope `createdAt`
  when explicit forget rewrites retained records into audit-safe redacted markers, so graph
  redaction does not re-stamp observation or claim birth time just because deleted raw values are
  being cleared. The public fact-forget lane now also appends one canonical replay row carrying the
  rewritten observation and claim ids when explicit forget redacts live graph records, even when
  optional mutation metadata collapses to canonical nulls, and it reuses retained legacy replay ids
  when that canonical redaction payload already matches instead of minting duplicate replay churn.
  The same public lane now also has explicit already-canonical replay coverage, so canonical
  retained forget rows stay reused instead of being rewritten when the redaction payload already
  matches. When a fresh canonical explicit forget append pushes the retained journal past
  `maxJournalEntries`, that same public lane also compacts the oldest replay row on the same call,
  advances `snapshotWatermark` to the last removed replay entry, and keeps replay ids and
  watermarks bounded at the configured cap. When repeated explicit forget already matches canonical
  redacted observation and claim state under cap, that same public lane also clamps stale
  `snapshotWatermark` against the surviving replay window without appending churn or restamping
  `lastCompactedAt`. When repeated explicit forget already matches canonical redacted
  observation-and-claim state and no retained replay rows remain, that same public lane also
  clamps stale `snapshotWatermark` back to `nextWatermark - 1` without appending churn or
  restamping `lastCompactedAt`. When repeated explicit forget already matches canonical redacted
  observation-and-claim state and retained replay rows plus compaction metadata are already
  replay-safe, that same public lane also stays a true no-op instead of rewriting the graph
  envelope.
- Repeated explicit fact forget now also repairs already-redacted graph claims and their
  supporting observations through retained claim `projectionSourceIds` and
  `derivedFromObservationIds`, while still preserving canonical envelope `createdAt`; the repaired
  redacted claim keeps the deleted fact id through final projection-source pruning, while any
  still-live surviving fact ids fail closed back out of already-redacted retained claim lineage.
  Stale fact-side `stableRefId` plus `entityRefIds` also fail closed instead of surviving on the
  audit-safe marker. Repeated explicit forget now also fail-closes stale unrelated retained
  `derivedFromObservationIds`, so only deleted-fact-support observations get retargeted or
  preserved on the repaired redacted claim. Canonical repeat-forget observation and claim state
  now stays a true no-op too, so matching retained audit-safe records do not emit fake touched-
  record churn or empty journal activity, and stale redaction metadata no longer remains stranded
  once the raw fact value is gone.
- Same-id retained fact-backed current-claim reconcile also stays a true no-op when the retained
  supporting observation and retained current claim already match canonical winner-fact state after
  the createdAt-preserving merge path, so current-claim repair does not emit fake touched-claim
  churn or empty journal activity on already-canonical retained state.
- Legacy fact backfill now also stays a true no-op on that same lane when retained journal coverage
  already protects the supporting observation and same-id current claim, so encrypted load does not
  reopen an already-canonical current-claim lane just because canonical flat facts are still
  present.
- Mutation-journal append now also treats retained legacy, noncanonical, or already-canonical
  `journalEntryId` values as already covered when their canonical replay payload matches the new
  append payload, so live graph writes do not mint a second replay entry after load repair
  recovered a blank id or collapsed payload-duplicate retained entries to one canonical replay
  identity.
  The same live append lane now also trims and dedupes touched replay refs while clearing blank
  optional metadata before duplicate suppression, so malformed live graph batches still coalesce to
  one canonical replay identity instead of minting churn behind padded refs or whitespace-only
  optional provenance on both the direct helper and the public graph-mutation seam, with the
  public proof surface now covering fact-side replay reuse plus both touched-episode retained-
  legacy and already-canonical replay reuse plus both redacted-episode retained-legacy and
  already-canonical replay reuse.
  When that canonicalized payload is genuinely new, live append also writes the retained replay
  entry back in that same normalized shape on the public graph-mutation seam for fact-side,
  touched-episode, and redacted-episode event batches instead of persisting padded refs or blank
  optional provenance on the fresh journal record. The same public fact-side lane now also has
  explicit overflow compaction coverage: when a fresh canonical fact-side append pushes the
  retained journal past `maxJournalEntries`, the live mutation path compacts the oldest replay row
  on the same call, advances `snapshotWatermark` to the last removed replay entry, and keeps
  replay ids and watermarks bounded at the configured cap.
  The same public fact-side lane now also has
  explicit replay-safe no-op coverage: when a same-id retained current claim already matches
  canonical winner state and retained replay rows plus compaction metadata are already
  replay-safe, the live mutation path stays a true no-op instead of rewriting the graph envelope.
  When that same current-claim lane is already canonical but retained compaction metadata is stale,
  the public fact-side path now also clamps `snapshotWatermark` against the surviving replay
  window without appending churn or restamping `lastCompactedAt`.
  When that same current-claim lane is already canonical and no retained replay rows remain, the
  public fact-side path instead clamps `snapshotWatermark` back to `nextWatermark - 1` without
  appending churn or restamping `lastCompactedAt`.
  When that same current-claim lane instead carries padded `assertedAt` or `validFrom` plus
  semantically mismatched same-lane observation lineage, the public fact-side path now also
  repairs the claim back to one canonical supporting observation id and canonical timestamps
  instead of preserving malformed lineage on the live mutation seam.
- Load normalization now also keeps otherwise valid retained journal entries when optional
  `sourceTaskId`, `sourceFingerprint`, or `mutationEnvelopeHash` metadata is omitted from persisted
  state: missing values normalize back to `null` instead of dropping the replay entry outright, so
  older retained journal payloads remain replayable even when those optional fields were never
  written. The same optional-metadata lane now also clears malformed non-string values for those
  fields back to `null`, so otherwise valid retained replay entries no longer fail closed just
  because older persisted payloads wrote optional journal metadata with the wrong type. The same
  retained journal lane now also defaults omitted `redactionState` back to canonical
  `not_requested`, while malformed noncanonical `redactionState` values still fail closed and drop,
  so older replay entries that predate explicit journal redaction-state persistence no longer drop
  during load just because that bounded metadata field was absent. The same omission-salvage lane
  now also defaults omitted empty `observationIds`, `claimIds`, or
  `eventIds` collections back to `[]`, so older replay entries with one surviving ref lane no
  longer drop during load just because sibling empty arrays were omitted from persisted state. The
  same omission-salvage lane now also fail-closes malformed non-array `observationIds`, `claimIds`,
  or `eventIds` containers back to empty collections, so otherwise valid retained replay entries no
  longer drop during load just because one persisted ref lane was stored as the wrong container
  type. The
  same omission-salvage lane now also strips malformed non-string members out of retained
  `observationIds`, `claimIds`, or `eventIds` arrays while keeping the remaining valid refs, so
  otherwise valid replay entries no longer drop during load just because one persisted ref member
  was malformed. The same omission-salvage lane now also treats malformed per-entry `watermark`
  values like omitted replay-order metadata and recovers canonical replay order instead of dropping
  the replay entry, so otherwise valid retained replay entries no longer fail closed just because
  that bounded replay-order field was persisted with malformed data. The same omission-salvage
  lane now also recovers omitted per-entry `watermark` values from retained
  replay order, so older replay entries no longer drop during load just because that bounded replay
  ordering field was absent from persisted state, and multiple omitted-watermark entries now
  recover the same canonical replay order regardless of raw persisted array order or stale legacy
  `journalEntryId` tie-breaks when replay timestamps match. The same replay-order lane now also
  preserves explicit retained watermark floors when later sibling replay entries omit
  `watermark`, so recovered omitted entries cannot collapse back below already-valid higher
  retained watermarks. The same replay-order salvage lane now also treats non-positive retained
  per-entry `watermark` values as recovered replay metadata instead of explicit replay order, so
  malformed `0` watermarks cannot anchor replay sequence or slip under a valid retained floor. The
  same mixed explicit-plus-recovered replay-order lane now also preserves
  that retained floor when sibling replay entries share one normalized `recordedAt`, so
  same-timestamp omitted-watermark entries cannot slip under the explicit retained replay cursor
  just because their canonical replay payload sorts first. The same replay-order lane now also
  breaks same explicit `watermark` and
  `recordedAt` ties on canonical replay-payload identity
  instead of stale legacy stored ids, so malformed retained replay entries can no longer let
  persisted ids choose the canonical replay sequence when bounded replay-order fields collide. The
  same retained journal dedupe lane now also breaks same stored `journalEntryId` / `watermark` /
  `recordedAt` freshness ties on canonical replay-payload identity instead of raw persisted array
  order, so malformed duplicate retained replay entries can no longer flip the canonical winner
  just because all stored replay ordering fields already matched. The same live append lane now
  also stays no-op when touched observation, claim, and event refs collapse blank after canonical
  trimming, so malformed live graph batches cannot emit empty replay churn. The same live append
  lane now
  also keys duplicate suppression on
  canonical replay-payload identity instead of a spoofed stored `journalEntryId`, so malformed
  retained replay entries can no longer suppress a new canonical graph mutation append just by
  reusing the would-be canonical replay id with different payload metadata, and the public
  graph-mutation proof surface now covers that fail-closed append behavior on both the fact-side
  and redacted-episode lanes. The outer retained
  journal envelope now
  also defaults omitted, malformed, or stale `nextWatermark` to one greater than the highest
  recovered retained watermark, so older journal payloads no longer lose canonical replay
  continuity just because that bounded outer replay cursor was absent, malformed, or lagging in
  persisted state.
- Redacted retained events now also fall out of bounded event retention once the retained journal
  window trims past their last replay reference, so audit-only event markers do not stay protected
  indefinitely after the replay-safe window has moved on.
- Redacted retained claims now also fall out of bounded claim retention once the retained journal
  window trims past their last replay reference, so audit-only claim markers do not stay protected
  indefinitely after the replay-safe window has moved on.
- Redacted retained observations now also fall out of bounded observation retention once the
  retained journal window trims past their last replay reference, so audit-only observation markers
  do not stay protected indefinitely after the replay-safe window has moved on.
- Redacted retained claims and observations now also fail closed on `entityRefIds` during
  lifecycle normalization, so stale entity linkage cannot survive in canonical audit-only payloads
  after raw normalization or encrypted store load repair.
- Already-redacted retained claims, observations, and events now also fail closed on `stableRefId`
  during lifecycle normalization, so canonical audit-only graph payloads cannot keep stale stable
  identity handles just because the retained record was redacted before the live forget path ran.
- Non-redacted retained claims and unresolved retained events now also fail closed on redacted
  supporting observation lineage before bounded observation retention runs, so stale audit-only
  observations cannot stay protected just because malformed live surfaces still point at them.
- Already-redacted retained claims now also fail closed on live or unrelated supporting
  observation lineage during final lineage pruning, so canonical audit-only claims keep only
  redacted same-lane deleted-fact support instead of carrying surviving live or unrelated
  observation refs through raw normalization or encrypted reload.
- Already-redacted retained events now also preserve only their own deleted-episode projection
  lineage while fail-closing still-live or unrelated deleted episode ids during final projection-
  source pruning, and the live graph mutation path now judges that pruning against the post-forget
  episode set, so canonical audit-only events do not lose deleted-episode lineage on reload, keep
  stale unrelated deleted-episode refs, or emit fake redacted-event churn just because the stale
  pre-forget episode set was still in scope for one mutation batch.
- Same-id retained observation upsert also stays a true no-op when the surviving canonical fact
  support state already matches the retained observation payload after canonical `createdAt`
  preservation, so live graph writes do not emit fake touched-observation churn or empty journal
  activity. That public observation lane now also has explicit append-canonicalization coverage
  for new observation-only mutations after optional metadata salvage, plus retained-legacy and
  already-canonical replay-reuse coverage when the canonical observation payload already matches,
  plus spoofed-canonical-id append-suppression coverage when a retained replay row reuses the
  would-be canonical journal id with different payload metadata, plus replay-safe no-op coverage
  plus under-cap and empty-retained snapshot-watermark clamp coverage, so stale compaction cursors
  repair without rewriting the retained observation or minting replay churn. A fresh canonical
  observation append now also has explicit public overflow coverage, so the oldest retained replay
  row trims on the same call when that observation lane exceeds `maxJournalEntries`.
- Load-time graph normalization now also reattaches effective personal-memory stable refs after
  legacy fact or episode backfill, replay repair, and final pruning, so encrypted reload cannot
  silently wipe self or provisional contact identity handles just because retained compatibility
  projections rebuilt the same claim or event payload with `stableRefId: null`.
- When new family-registry, proof, mutation-envelope, or retraction contracts become live here,
  `profileMemory.ts` should re-export those bounded shapes so callers can stay on the stable core
  entrypoint instead of reaching into deep runtime paths by default.
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
- Request-scoped profile-memory telemetry belongs here so later phases can count bounded ingest,
  retrieval, synthesis, render, alias-safety, identity-safety, and prompt-owner surfaces through
  existing broker and conversational request paths without inventing a second store.
- Request-scoped read-session reuse belongs here so broker and later conversational consumers can
  reuse one reconciled profile snapshot without turning `ProfileMemoryStore` into multiple read
  owners.
- Truth-governance classification belongs here before canonical mutation so profile facts,
  support-only legacy context, episode support, and quarantined candidates do not diverge into
  competing policy layers at the store seam.
- One canonical normalization and governance path now feeds both graph-backed records and the
  stable `facts[]` / `episodes[]` migration surfaces, so compatibility projections must remain
  derived outputs instead of becoming a second truth owner beside graph observations, claims, and
  events.
- `profileMemoryGraphMutations.ts` is now the dedicated Phase 4 dual-write seam: `ProfileMemoryStore`
  may still own encrypted persistence, but live graph mutation batching, replay-safe journal
  updates, and compatibility-preserving graph writes must stay centralized there instead of
  drifting back into one-off store branches.
- `profileMemoryGraphDecisionRecordSupport.ts` now owns the bounded durable decision-record append
  helper used by Phase 5 rekey and alignment flows, and
  `profileMemoryGraphStableRefRekeySupport.ts` now owns the generic stable-ref lane rewrite helper,
  so replayable decision audit and rekey-specific record rewrites stay deterministic without
  bloating the main mutation seam past subsystem-size limits.
- That same mutation seam now also owns explicit Phase 5a stable-ref rekey: bounded personal-memory
  rekey may rewrite already-issued stable refs locally, but it must remain distinct from any later
  Stage 6.86 merge, alias, or entity-alignment decision path.
- Personal-memory stable-ref rekey now also appends one bounded durable graph decision record in
  the encrypted profile-memory graph so local rekeys remain replayable and auditable without
  pretending they were Stage 6.86 merges.
- `profileMemoryGraphQueries.ts` is now the bounded Phase 5a stable-ref seam: live graph mutation
  batching must attach effective self/contact stable refs there, stable-ref grouping must stay
  query-only and bounded there, and provisional contact truth must fail closed out of
  `resolved_current` outputs until later alignment explicitly promotes it.
- Phase 6 temporal retrieval is now split on purpose: `profileMemoryTemporalQueries.ts` stays
  retrieval-only and bounded, while `profileMemoryTemporalSynthesis.ts` alone may derive
  `Current State`, `Historical Context`, and `Contradiction Notes` from that slice. Higher layers
  must not re-derive winners independently from raw claims, observations, or events.
- `TemporalMemorySynthesis` is now the canonical internal temporal output. `BoundedMemorySynthesis`
  remains legacy compatibility only through the one-way adapter in
  `src/organs/memorySynthesis/temporalSynthesisAdapter.ts`; adapter output must not be persisted or
  reused as a second truth owner.
- Planner cutover now follows that contract too: `ProfileMemoryStore.openReadSession()` exposes the
  canonical `queryTemporalPlanningSynthesis(...)` seam from
  `profileMemoryPlanningSynthesis.ts`, and `memoryBrokerPlannerInput.ts` consumes that bounded
  temporal output directly instead of rebuilding planner memory from compatibility facts and
  episodes.
- Read-time repair is now explicit instead of silent. `ProfileMemoryStore.load()` returns one
  reconciled snapshot without persisting it, while `repairPersistedState()` is the only store seam
  allowed to write deterministic normalization repairs back into encrypted storage.
- Phase 6 continuity query contracts now separate semantic mode from relevance scope. The initial
  live scope set is `thread_local`, `conversation_local`, and `global_profile`, and those fields
  now pass through the live conversation-runtime continuity request shapes instead of stopping at
  type signatures.
- Phase 6.5 fact continuity is now graph-aware on the live read path too:
  `queryProfileFactsForContinuity(...)` no longer discards the shared Stage 6.86 graph or
  conversation stack, expands explicit entity hints through exact canonical or alias matches,
  carries scoped thread keys into bounded temporal retrieval, and returns an array-shaped fact
  result with typed temporal metadata (`semanticMode`, `relevanceScope`, `scopedThreadKeys`, and
  `temporalSynthesis`). When graph-backed temporal retrieval has no bounded focus entity but
  compatibility fact selection still surfaces bounded truth, that same continuity seam now fails
  closed onto one degraded compatibility temporal slice instead of dropping back to flat fact lines
  alone.
- Support-only historical or severed transitions on `support_only_transition` families now also
  close stale current winners on both the flat compatibility lane and the graph-backed claim lane,
  so successor coworker updates cannot leave ended current truth silently active while the new
  winner is already live.
- Temporal continuity now follows `global truth, local relevance`: thread/open-loop and
  conversation-local scope may bias which bounded facts or episodes surface for one turn, but they
  must never override canonical governance, source authority, end-state handling, or singular-
  family displacement rules during synthesis.
- Bounded temporal retrieval now preserves higher-authority active candidates ahead of low-
  authority recency churn when family or event caps apply. Corroboration depth and recency still
  act as deterministic salience, but only after authority and lifecycle gates have already kept
  the eligible slice fail-closed.
- Direct self-identity continuity remains explicitly global-profile scoped even after Phase 6
  temporal cutover, while active conversational recall uses conversation-local scope so same-stream
  follow-ups can recover bounded prior context after clutter or interruption without forcing the
  user to restate the whole background.
- `profileMemoryGraphAlignmentSupport.ts` is now the bounded Phase 5b attachment seam: conservative
  Stage 6.86 exact-match lookup may annotate existing stable-ref groups with `primaryEntityKey` /
  `observedEntityKey`, but ambiguous or quarantined lanes must still fail closed without handing
  truth ownership away from encrypted personal memory.
- Stage 6.86 alias merge/quarantine decisions, plus explicit unquarantine and rollback actions,
  now persist bounded durable decision records on the entity-graph store side so Phase 5b
  alignment stays reviewable without changing personal-memory truth ownership.
- The code-owned family registry here is now the canonical source for family-level cardinality,
  support-only posture, end-state eligibility, adjacent-domain access, and compatibility-projection
  defaults; Phase 2.5 may still expand those contracts, but new family policy must not be added as
  prose-only drift.
- The approved `contact.*` compatibility-projection table is now part of that code-owned policy
  too: new contact families or contact projection drift must fail the Phase 2.5 registry check
  instead of silently landing as unmapped flat compatibility behavior.
- Registry-backed displacement policy is now live at the canonical fact-lifecycle seam too:
  singular current-state families may no longer silently flap on every conflicting write. Explicit
  successor families still supersede prior winners, preserve-prior families retain the prior winner
  while keeping challenger evidence as bounded uncertain state, and review-driven correction
  override remains an exact-source replacement path.
- Minimum sensitivity floors are now live runtime enforcement, not passive registry metadata:
  governance plus bounded read/query selectors must apply the family floor before exposing legacy
  or current facts, even when older stored records were written with a weaker raw `sensitive` bit.
  That now includes both strict family floors such as `residence.current` and the bounded
  `generic.profile_fact` sensitive-key heuristic for keys like address, phone, email, birth, or
  residence-derived generic facts.
- Provenance-backed canonical ingests now emit bounded mutation envelopes here, so query-time proof
  is no longer the only live decision artifact. Those envelopes must stay redaction-safe, carry
  only bounded candidate and write refs, and avoid freezing a final journal schema before Phase 3.
- Explicit remembered-situation resolve, wrong, and forget mutations now also emit bounded
  review-mutation envelopes here. Those review artifacts must keep retraction semantics
  machine-checkable while redacting delete-class raw values out of durable proof.
- Bounded fact review is now a live read-session and store seam too: approval-aware fact review
  must reuse the same query-time decision records and sensitivity-floor enforcement instead of
  inventing a second review-only selector.
- Bounded fact correction and forget flows are now live on the canonical store seam too:
  review-driven fact mutation must reuse exact-source truth governance plus bounded mutation
  envelopes here rather than inventing a second write path with freeform sources or ungoverned
  review-side updates.
- The stable broker seam now preserves that bounded proof instead of flattening it away:
  remembered-fact review can surface hidden decision records additively, and remembered fact or
  episode mutations can carry their bounded mutation envelopes through the organ boundary without
  forcing the private `/memory` rendering surface to adopt Phase 3-era journal semantics early.
- Adjacent-domain access is no longer a passive contract only: deterministic truth governance now
  fails closed against the registry when adjacent runtime domains such as structured conversation,
  reconciliation, or Stage 6.86 attempt truth-authoritative or support-only actions that the
  family policy does not explicitly allow.
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
  while graph-backed history is still pending. Phase 2.5 now routes that compatibility-visibility
  seam through the code-owned family registry too, so future policy drift fails against one shared
  family contract instead of reintroducing local hardcoded tables.
- The same code-owned family registry now also governs bounded multi-value inventory on
  query/planning selectors. `contact.context` may contribute only a small capped number of entries
  per contact on continuity/planning surfaces instead of crowding out governed current-state facts
  just because multiple support-only context snippets mention the same name.
- Current-state admission policy is code-owned there too: singular contact families such as
  `contact.relationship` and `contact.work_association` now require explicit live-source admission
  before they can own current truth, while historical or severed contact support remains fail
  closed onto bounded compatibility identity only.
- Query-time proof is no longer contract-only: bounded query inspection now emits
  `ProfileMemoryQueryDecisionRecord` entries for selected current/supporting facts plus hidden
  corroboration-gated or fail-closed facts, and memory-synthesis contracts now reuse that same
  record shape instead of maintaining a parallel decision schema.
- The same bounded inspection seam is now live on the planning path too: query-time decision
  records may flow through `profileMemoryReadSession.ts`, `profileMemoryStore.ts`, and
  `memoryBrokerPlannerInput.ts` into `MemorySynthesisFactRecord` and the
  `BoundedMemorySynthesis.decisionRecords` adapter field, but that proof remains additive and
  must not turn the legacy synthesis object into a second truth owner.
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
  reappear as current relationship truth during pulse nudging. Preserve-prior uncertain
  challengers should stay drift-only on pulse surfaces too: they may trigger
  `assessContextDrift(...)`, but they must not replace confirmed current relationship role or
  inflate stale-fact counts until a correction override or stronger canonical winner resolves the
  conflict. Stale formerly confirmed facts may still count toward stale-fact revalidation after
  load normalization downgrades them to `uncertain`, because they represent prior canonical truth
  rather than never-confirmed challenger evidence.
- Named-contact extraction here must also trim wrapper phrasing and same-clause continuation text
  out of captured display names so bounded current-state or work-linkage sentences such as
  `I work with a guy named Milo at Northstar Creative.`, `A person named Milo works with me.`, or
  `My friend Riley works with me at Lantern Studio.` do not persist malformed contact tokens such
  as `contact.a.guy.named.milo` or `contact.milo.at.northstar.creative`.
- Named-contact extraction here must also keep same-name or dotted-initial collisions on bounded
  qualified contact lanes when the conversational qualifier changes, while alias-clarification
  sentences like `The Jordan from Northstar sometimes goes by J.R.` must reattach to the original
  Northstar Jordan lane instead of minting a third ambiguous contact token.
- Reminder-style profile wrappers should unwrap into the same bounded declarative extraction path
  before governance, so mixed wording such as `After that, remind me that Priya is my coworker at
  Northstar.` still yields the canonical contact truth while adjacent workflow/file labels stay
  non-authoritative until a real profile fact is stated.
- When explicit named-contact relationship extraction already captured `contact.<token>.name`, the
  generic `my_is` fallback must fail closed for that same relationship sentence instead of
  persisting a parallel flat fact such as `supervisor = Dana`.
- Ambiguous bare relationship labels that are not yet backed by governed extraction should fail
  closed in downstream pulse or routing interpretation; today that means bare `report` is not
  treated as an `employee` alias until a bounded extraction/governance path exists for it.

## Memory Authority Boundary

Profile memory treats source family as a first-class governance input. Direct user text can still
produce narrow durable facts when the fact family and exact source allow it, but document/media
interpretation, model summaries, and broad relationship or episode phrase packs start as
candidate/support evidence. Durable truth queries should only see those candidates after explicit
family policy or a review action promotes them.

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
- `tests/core/profileMemoryTemporalSynthesis.test.ts`
- `tests/core/profileMemoryPersistence.test.ts`
- `tests/core/profileMemoryStore.test.ts`
- `tests/core/profileMemory.test.ts`
- `tests/core/profileMemoryGraphQueries.test.ts`
- `tests/organs/memorySynthesisTemporalAdapter.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed in `src/core/profileMemoryRuntime/`
- profile-memory runtime contracts move between this folder and `profileMemoryStore.ts`
- planner-context, state lifecycle, normalization, extraction, pulse, mutation, encryption,
  media-ingest normalization,
  readable-fact query, readable-episode query, episodic-memory linkage, episodic-memory,
  episodic-memory planning context, episodic-memory consolidation, or persistence ownership changes
- related profile-memory runtime tests move materially
