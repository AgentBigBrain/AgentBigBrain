/**
 * @fileoverview Brokered planner-input assembly extracted from the memory-broker entrypoint.
 */

import { ProfileMemoryStore } from "../core/profileMemoryStore";
import {
  MemoryAccessAuditStore,
  type MemoryAccessPrincipalAuditSnapshot
} from "../core/memoryAccessAudit";
import { LanguageUnderstandingOrgan } from "./languageUnderstanding/episodeExtraction";
import type { SourceRecallOutputBudget } from "../core/sourceRecall/contracts";
import {
  DEFAULT_SOURCE_RECALL_OUTPUT_BUDGET,
  retrieveSourceRecall
} from "../core/sourceRecall/sourceRecallRetriever";
import type { SourceRecallStore } from "../core/sourceRecall/sourceRecallStore";
import {
  decideSourceRecallRetrieval,
  type SourceRecallRetentionPolicy
} from "../core/sourceRecall/sourceRecallRetention";
import { parseProfileMediaIngestInput } from "../core/profileMemory";
import type {
  ProfileFactPlanningInspectionResult,
  ProfileMemoryIngestMemoryIntent,
  ProfileReadableEpisode,
  ProfileReadableFact
} from "../core/profileMemoryRuntime/contracts";
import type { TemporalMemorySynthesis } from "../core/profileMemoryRuntime/profileMemoryTemporalQueryContracts";
import {
  buildConversationProfileMemoryTurnId,
  buildProfileMemorySourceFingerprint
} from "../core/profileMemoryRuntime/profileMemoryIngestProvenance";
import {
  buildProfileMemoryIngestPolicy
} from "../core/profileMemoryRuntime/profileMemoryIngestPolicy";
import { evaluateProfileMemoryAccessPolicy } from "../core/profileMemoryRuntime/profileMemoryAccessPolicy";
import {
  createProfileMemoryRequestTelemetry,
  recordProfileMemoryIngestOperation,
  recordProfileMemoryPromptSurfaceMetrics,
  recordProfileMemoryRenderOperation,
  recordProfileMemoryRetrievalOperation,
  recordProfileMemorySynthesisOperation
} from "../core/profileMemoryRuntime/profileMemoryRequestTelemetry";
import type { TaskRequest } from "../core/types";
import { extractResolvedRouteMemoryIntent } from "../core/currentRequestExtraction";
import { buildPlannerContextSynthesisBlock } from "./memorySynthesis/plannerContextSynthesis";
import type { MemorySynthesisEpisodeRecord, MemorySynthesisFactRecord } from "./memorySynthesis/contracts";
import {
  adaptTemporalMemorySynthesisToBoundedMemorySynthesis
} from "./memorySynthesis/temporalSynthesisAdapter";
import { appendMemoryAccessAudit } from "./memoryContext/auditEvents";
import {
  buildInjectedContextPacket,
  buildSourceRecallOnlyContextPacket,
  buildSuppressedContextPacket,
  countRetrievedProfileFacts,
  renderSourceRecallContextForModelEgress,
  sanitizeProfileContextForModelEgress
} from "./memoryContext/contextInjection";
import {
  countRetrievedEpisodeSummaries,
  sanitizeEpisodeContextForModelEgress
} from "./memoryContext/episodeContextInjection";
import type {
  DomainBoundaryAssessment,
  MemoryContextAuthorityMetadata,
  MemoryBrokerBuildInputOptions,
  MemoryBrokerInputResult,
  ProbingSignalSnapshot
} from "./memoryContext/contracts";
import {
  assessDomainBoundary,
  extractCurrentUserRequest,
  registerAndAssessProbing,
  resolveProbingDetectorConfig,
  shouldSkipProfileMemoryIngest
} from "./memoryContext/queryPlanning";

export interface MemoryBrokerPlannerInputDependencies {
  profileMemoryStore?: ProfileMemoryStore;
  memoryAccessAuditStore: MemoryAccessAuditStore;
  languageUnderstandingOrgan?: LanguageUnderstandingOrgan;
  sourceRecallContext?: MemoryBrokerSourceRecallContextDependencies;
  probingDetectorConfig: ReturnType<typeof resolveProbingDetectorConfig>;
  recentProbeSignals: ProbingSignalSnapshot[];
}

export interface MemoryBrokerSourceRecallContextDependencies {
  store: Pick<SourceRecallStore, "loadDocument">;
  policy: SourceRecallRetentionPolicy;
  outputBudget?: SourceRecallOutputBudget;
}

interface BrokerProfileMemoryReadSession {
  getPlanningContext(maxFacts?: number, queryInput?: string): Promise<string> | string;
  getEpisodePlanningContext(
    maxEpisodes?: number,
    queryInput?: string,
    nowIso?: string
  ): Promise<string> | string;
  queryFactsForPlanningContext(
    maxFacts?: number,
    queryInput?: string
  ): Promise<readonly ProfileReadableFact[]> | readonly ProfileReadableFact[];
  inspectFactsForPlanningContext?(
    request: {
      queryInput?: string;
      maxFacts?: number;
      asOfValidTime?: string;
      asOfObservedTime?: string;
    }
  ): Promise<ProfileFactPlanningInspectionResult> | ProfileFactPlanningInspectionResult;
  queryTemporalPlanningSynthesis?(
    queryInput?: string,
    asOfObservedTime?: string
  ): Promise<TemporalMemorySynthesis | null> | TemporalMemorySynthesis | null;
  queryEpisodesForPlanningContext(
    maxEpisodes?: number,
    queryInput?: string,
    nowIso?: string
  ): Promise<readonly ProfileReadableEpisode[]> | readonly ProfileReadableEpisode[];
}

type BrokerProfileOperation = "profile_read" | "profile_write";

/**
 * Deduplicates bounded texts before model-assisted memory extraction.
 *
 * @param values - Candidate narrative fragments.
 * @returns Ordered unique non-empty fragments.
 */
function dedupeMemoryBrokerNarrativeFragments(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    const signature = normalized.toLowerCase();
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    ordered.push(normalized);
  }
  return ordered;
}

export interface BrokerPromptCutoverGateResult {
  decision: "allow" | "block";
  reasons: readonly string[];
}

/**
 * Returns whether one route-approved memory intent may surface retrieved memory context.
 *
 * @param memoryIntent - Route-approved memory intent from trusted metadata.
 * @returns `true` when retrieval context may be surfaced.
 */
function allowsMemoryContextInjection(
  memoryIntent: ProfileMemoryIngestMemoryIntent | null
): boolean {
  return memoryIntent === "relationship_recall" ||
    memoryIntent === "contextual_recall" ||
    memoryIntent === "document_derived_recall";
}

/**
 * Returns whether route metadata and domain state allow Source Recall evidence in planner context.
 *
 * @param memoryIntent - Trusted route memory intent.
 * @param domainBoundary - Profile-memory domain boundary assessment.
 * @returns `true` when Source Recall can be rendered as quoted evidence.
 */
function allowsSourceRecallContextInjection(
  memoryIntent: ProfileMemoryIngestMemoryIntent | null,
  domainBoundary: DomainBoundaryAssessment
): boolean {
  if (!allowsMemoryContextInjection(memoryIntent)) {
    return false;
  }
  return (
    domainBoundary.reason !== "non_profile_dominant_request" &&
    domainBoundary.reason !== "workflow_session_continuity" &&
    domainBoundary.reason !== "probing_detected"
  );
}

/**
 * Resolves a conversation-scoped Source Recall retrieval query.
 *
 * @param currentUserRequest - Active user request.
 * @param options - Broker build options.
 * @returns Retrieval query, or `null` when there is no bounded consumer scope.
 */
function buildSourceRecallContextQuery(
  currentUserRequest: string,
  options: MemoryBrokerBuildInputOptions
): Parameters<typeof retrieveSourceRecall>[1] | null {
  const conversationId = options.sessionDomainContext?.conversationId?.trim();
  if (!conversationId) {
    return null;
  }
  const scopeId = `conversation:${conversationId}`;
  const keywords = extractBoundedSourceRecallKeywords(currentUserRequest);
  return {
    scopeId,
    threadId: scopeId,
    ...(keywords.length > 0 ? { keywords } : {})
  };
}

/**
 * Extracts bounded retrieval keywords for evidence ranking only.
 *
 * @param currentUserRequest - Active user request.
 * @returns Lower-case keywords, or an empty list for scope-only recall.
 */
function extractBoundedSourceRecallKeywords(currentUserRequest: string): readonly string[] {
  const stopWords = new Set([
    "about",
    "again",
    "before",
    "could",
    "did",
    "earlier",
    "from",
    "have",
    "said",
    "tell",
    "that",
    "the",
    "this",
    "what",
    "when",
    "where",
    "with",
    "would",
    "you"
  ]);
  const words = currentUserRequest
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
  return [...new Set(words.filter((word) => !stopWords.has(word)))].slice(0, 8);
}

/**
 * Builds a route-approved Source Recall context block, if policy and retrieval results allow it.
 *
 * @param input - Broker request, policy, and domain-boundary state.
 * @returns Rendered Source Recall context block, or an empty string.
 */
async function buildRouteApprovedSourceRecallContext(input: {
  deps: MemoryBrokerPlannerInputDependencies;
  options: MemoryBrokerBuildInputOptions;
  currentUserRequest: string;
  resolvedRouteMemoryIntent: ProfileMemoryIngestMemoryIntent | null;
  domainBoundary: DomainBoundaryAssessment;
}): Promise<string> {
  const sourceRecall = input.deps.sourceRecallContext;
  if (!sourceRecall) {
    return "";
  }
  if (!allowsSourceRecallContextInjection(input.resolvedRouteMemoryIntent, input.domainBoundary)) {
    return "";
  }
  if (!decideSourceRecallRetrieval(sourceRecall.policy).allowed) {
    return "";
  }
  const query = buildSourceRecallContextQuery(input.currentUserRequest, input.options);
  if (!query) {
    return "";
  }
  try {
    const result = await retrieveSourceRecall(
      sourceRecall.store,
      query,
      sourceRecall.outputBudget ?? {
        ...DEFAULT_SOURCE_RECALL_OUTPUT_BUDGET,
        maxRecords: 3,
        maxChunks: 5,
        maxTotalExcerptChars: 1800
      }
    );
    if (result.bundle.excerpts.length === 0) {
      return "";
    }
    return renderSourceRecallContextForModelEgress(result);
  } catch (error) {
    console.error(
      `[MemoryBroker] non-fatal source-recall retrieval failure: ${(error as Error).message}`
    );
    return "";
  }
}

/**
 * Resolves retrieval authority metadata for one brokered memory context packet.
 *
 * @param memoryIntent - Trusted route memory intent.
 * @param hasTemporalSynthesis - Whether typed temporal synthesis is available.
 * @returns Authority metadata plus whether the context can be injected.
 */
function resolveBrokerRetrievalAuthority(
  memoryIntent: ProfileMemoryIngestMemoryIntent | null,
  hasTemporalSynthesis: boolean
): { metadata: MemoryContextAuthorityMetadata; allowInjection: boolean } {
  const routeApproved = allowsMemoryContextInjection(memoryIntent);
  if (hasTemporalSynthesis) {
    return {
      metadata: {
        retrievalMode: "semantic_entity_match",
        sourceAuthority: "semantic_model",
        plannerAuthority: routeApproved ? "route_approved" : "none",
        currentTruthAuthority: routeApproved
      },
      allowInjection: routeApproved
    };
  }

  return {
    metadata: {
      retrievalMode: "compatibility_token_overlap",
      sourceAuthority: "legacy_compatibility",
      plannerAuthority: routeApproved ? "evidence_only" : "none",
      currentTruthAuthority: false
    },
    allowInjection: routeApproved
  };
}

/**
 * Opens one broker-scoped profile-memory read facade, preferring request-scoped snapshot reuse when
 * the concrete store supports it while keeping older store doubles compatible.
 *
 * @param store - Profile-memory store or compatible test double.
 * @returns Read facade used by planner-input assembly.
 */
async function openBrokerProfileMemoryReadSession(
  store: ProfileMemoryStore,
  storeTelemetry?: import("../core/profileMemoryRuntime/contracts").ProfileMemoryRequestTelemetry
): Promise<BrokerProfileMemoryReadSession> {
  const planningInspectionReader = (store as ProfileMemoryStore & {
    inspectFactsForPlanningContext?: (
      queryInput?: string,
      maxFacts?: number,
      asOfValidTime?: string,
      asOfObservedTime?: string
    ) => Promise<ProfileFactPlanningInspectionResult>;
  }).inspectFactsForPlanningContext;
  const temporalPlanningSynthesisReader = (store as ProfileMemoryStore & {
    queryTemporalPlanningSynthesis?: (
      queryInput?: string,
      asOfObservedTime?: string
    ) => Promise<TemporalMemorySynthesis | null>;
  }).queryTemporalPlanningSynthesis;
  const sessionFactory = (store as ProfileMemoryStore & {
    openReadSession?: (
      requestTelemetry?: import("../core/profileMemoryRuntime/contracts").ProfileMemoryRequestTelemetry
    ) => Promise<BrokerProfileMemoryReadSession>;
  }).openReadSession;
  if (typeof sessionFactory === "function") {
    return sessionFactory.call(store, storeTelemetry);
  }
  return {
    getPlanningContext: (maxFacts = 6, queryInput = "") =>
      store.getPlanningContext(maxFacts, queryInput),
    getEpisodePlanningContext: (maxEpisodes = 2, queryInput = "", nowIso = new Date().toISOString()) =>
      store.getEpisodePlanningContext(maxEpisodes, queryInput, nowIso),
    queryFactsForPlanningContext: (maxFacts = 6, queryInput = "") =>
      store.queryFactsForPlanningContext(maxFacts, queryInput),
    ...(typeof planningInspectionReader === "function"
      ? {
          inspectFactsForPlanningContext: ({
            queryInput = "",
            maxFacts = 6,
            asOfValidTime,
            asOfObservedTime
          }: {
            queryInput?: string;
            maxFacts?: number;
            asOfValidTime?: string;
            asOfObservedTime?: string;
          }) =>
            planningInspectionReader.call(
              store,
              queryInput,
              maxFacts,
              asOfValidTime,
              asOfObservedTime
            )
        }
      : {}),
    ...(typeof temporalPlanningSynthesisReader === "function"
      ? {
          queryTemporalPlanningSynthesis: (
            queryInput = "",
            asOfObservedTime = new Date().toISOString()
          ) => temporalPlanningSynthesisReader.call(store, queryInput, asOfObservedTime)
        }
      : {}),
    queryEpisodesForPlanningContext: (
      maxEpisodes = 2,
      queryInput = "",
      nowIso = new Date().toISOString()
    ) => store.queryEpisodesForPlanningContext(maxEpisodes, queryInput, nowIso)
  };
}

/**
 * Assesses whether the broker prompt-facing temporal cutover stays inside bounded telemetry
 * thresholds.
 *
 * @param requestTelemetry - Request-scoped profile-memory telemetry collected during broker assembly.
 * @returns Cutover decision plus deterministic threshold reasons.
 */
export function assessBrokerPromptCutoverGate(
  requestTelemetry: import("../core/profileMemoryRuntime/contracts").ProfileMemoryRequestTelemetry
): BrokerPromptCutoverGateResult {
  const reasons: string[] = [];
  if (requestTelemetry.storeLoadCount > 3) {
    reasons.push("store_load_count_exceeded");
  }
  if (requestTelemetry.mixedMemoryOwnerDecisionCount > 0) {
    reasons.push("mixed_memory_owner_decision_detected");
  }
  if (requestTelemetry.promptMemorySurfaceCount > 1) {
    reasons.push("prompt_memory_surface_count_exceeded");
  }
  return {
    decision: reasons.length > 0 ? "block" : "allow",
    reasons
  };
}

function evaluateBrokerOwnerProfileAccess(
  task: TaskRequest,
  operation: BrokerProfileOperation
): ReturnType<typeof evaluateProfileMemoryAccessPolicy> {
  return evaluateProfileMemoryAccessPolicy({
    principalAccess: task.principalAccess,
    operation,
    requestedSubjectKind: "owner_profile"
  });
}

function buildTaskPrincipalAuditSnapshot(
  task: TaskRequest
): MemoryAccessPrincipalAuditSnapshot | undefined {
  const principalAccess = task.principalAccess;
  if (
    !principalAccess ||
    !principalAccess.principalContext ||
    typeof principalAccess.principalContext.actor !== "object" ||
    principalAccess.principalContext.actor === null ||
    typeof principalAccess.principalContext.route !== "object" ||
    principalAccess.principalContext.route === null
  ) {
    return undefined;
  }
  const actor = principalAccess.principalContext.actor as Record<string, unknown>;
  const route = principalAccess.principalContext.route as Record<string, unknown>;
  return {
    principalRole: actor.principalRole as MemoryAccessPrincipalAuditSnapshot["principalRole"],
    routeVisibility: route.visibility as MemoryAccessPrincipalAuditSnapshot["routeVisibility"],
    accessOperation: principalAccess.accessDecision.operation,
    accessClass: principalAccess.accessDecision
      .accessClass as MemoryAccessPrincipalAuditSnapshot["accessClass"],
    accessAllowed: principalAccess.accessDecision.allowed,
    accessReason: principalAccess.accessDecision.reason,
    identityAuthority: actor.identityAuthority as MemoryAccessPrincipalAuditSnapshot["identityAuthority"],
    legacyIdentityState: actor.legacyIdentityState as MemoryAccessPrincipalAuditSnapshot["legacyIdentityState"],
    ownerMatchSource: actor.ownerMatchSource as MemoryAccessPrincipalAuditSnapshot["ownerMatchSource"]
  };
}

/**
 * Builds brokered planner input while keeping the entrypoint free of orchestration detail.
 *
 * @param task - Current task request.
 * @param options - Session-domain routing hints.
 * @param deps - Broker dependencies and mutable probing state.
 * @returns Planner input plus memory-status classification.
 */
export async function buildBrokeredPlannerInput(
  task: TaskRequest,
  options: MemoryBrokerBuildInputOptions,
  deps: MemoryBrokerPlannerInputDependencies
): Promise<MemoryBrokerInputResult> {
  const currentUserRequest = extractCurrentUserRequest(task.userInput);
  const resolvedRouteMemoryIntent =
    extractResolvedRouteMemoryIntent(task.userInput) as ProfileMemoryIngestMemoryIntent | null;
  if (!deps.profileMemoryStore) {
    const domainBoundary = assessDomainBoundary(
      currentUserRequest,
      [],
      options.sessionDomainContext
    );
    const sourceRecallContext = await buildRouteApprovedSourceRecallContext({
      deps,
      options,
      currentUserRequest,
      resolvedRouteMemoryIntent,
      domainBoundary
    });
    if (sourceRecallContext.trim().length > 0) {
      return {
        userInput: buildSourceRecallOnlyContextPacket(
          task,
          domainBoundary.lanes,
          domainBoundary.scores,
          "source_recall_context_relevant",
          sourceRecallContext
        ),
        profileMemoryStatus: "disabled"
      };
    }
    return {
      userInput: task.userInput,
      profileMemoryStatus: "disabled"
    };
  }

  const probing = registerAndAssessProbing(
    currentUserRequest,
    deps.recentProbeSignals,
    deps.probingDetectorConfig
  );
  deps.recentProbeSignals.splice(0, deps.recentProbeSignals.length, ...probing.nextSignals);
  const shouldSkipProfileIngest = shouldSkipProfileMemoryIngest(
    currentUserRequest,
    options.sessionDomainContext
  );
  try {
    const requestTelemetry = createProfileMemoryRequestTelemetry();
    const brokerReadAccess = evaluateBrokerOwnerProfileAccess(task, "profile_read");
    const brokerWriteAccess = evaluateBrokerOwnerProfileAccess(task, "profile_write");
    const principalAudit = buildTaskPrincipalAuditSnapshot(task);
    const sourceFingerprint = buildProfileMemorySourceFingerprint(currentUserRequest);
    const conversationId = options.sessionDomainContext?.conversationId;
    const mediaIngest = parseProfileMediaIngestInput(currentUserRequest);
    const modelEpisodeExtractionTexts = dedupeMemoryBrokerNarrativeFragments(
      mediaIngest.allNarrativeFragments
    );
    const additionalEpisodeCandidates = !shouldSkipProfileIngest && deps.languageUnderstandingOrgan
      ? (await Promise.all(
          modelEpisodeExtractionTexts.map((text) =>
            deps.languageUnderstandingOrgan!.extractEpisodeCandidates({
              text,
              sourceTaskId: task.id,
              observedAt: task.createdAt
            })
          )
        )).flat()
      : [];
    if (!shouldSkipProfileIngest && brokerWriteAccess.allowed) {
      await deps.profileMemoryStore.ingestFromTaskInput(
        task.id,
        currentUserRequest,
        task.createdAt,
        {
          additionalEpisodeCandidates,
          provenance: {
            conversationId,
            turnId: conversationId
              ? buildConversationProfileMemoryTurnId(
                  conversationId,
                  task.createdAt,
                  sourceFingerprint
                )
              : task.id,
            dominantLaneAtWrite: options.sessionDomainContext?.dominantLane ?? null,
            sourceSurface: "broker_task_ingest",
            sourceFingerprint,
            principalAccess: task.principalAccess,
            requestedSubjectKind: "owner_profile"
          },
          ingestPolicy: buildProfileMemoryIngestPolicy({
            memoryIntent: resolvedRouteMemoryIntent ?? "none",
            sourceSurface: "broker_task_ingest"
          }),
          requestTelemetry,
          principalAccess: task.principalAccess,
          requestedSubjectKind: "owner_profile"
        }
      );
      recordProfileMemoryIngestOperation(requestTelemetry);
    }
    if (!brokerReadAccess.allowed) {
      const domainBoundary = assessDomainBoundary(
        currentUserRequest,
        [],
        options.sessionDomainContext
      );
      const sourceRecallContext = await buildRouteApprovedSourceRecallContext({
        deps,
        options,
        currentUserRequest,
        resolvedRouteMemoryIntent,
        domainBoundary
      });
      const promptCutoverGate = assessBrokerPromptCutoverGate(requestTelemetry);
      await recordAudit(
        deps.memoryAccessAuditStore,
        task.id,
        currentUserRequest,
        requestTelemetry,
        promptCutoverGate,
        requestTelemetry.storeLoadCount,
        0,
        0,
        0,
        domainBoundary,
        principalAudit
      );
      if (sourceRecallContext.trim().length > 0) {
        return {
          userInput: buildSourceRecallOnlyContextPacket(
            task,
            domainBoundary.lanes,
            domainBoundary.scores,
            "source_recall_context_relevant",
            sourceRecallContext
          ),
          profileMemoryStatus: "available"
        };
      }
      return {
        userInput: task.userInput,
        profileMemoryStatus: "available"
      };
    }
    const readSession = await openBrokerProfileMemoryReadSession(
      deps.profileMemoryStore,
      requestTelemetry
    );
    recordProfileMemoryRetrievalOperation(requestTelemetry);
    const profileContext = await readSession.getPlanningContext(6, currentUserRequest);
    recordProfileMemoryRetrievalOperation(requestTelemetry);
    const episodeContext = await readSession.getEpisodePlanningContext(
      2,
      currentUserRequest,
      task.createdAt
    );
    recordProfileMemoryRetrievalOperation(requestTelemetry);
    const plannerFactInspection = typeof readSession.inspectFactsForPlanningContext === "function"
      ? await readSession.inspectFactsForPlanningContext({
          queryInput: currentUserRequest,
          maxFacts: 3,
          asOfObservedTime: task.createdAt
        })
      : {
          entries: (await readSession.queryFactsForPlanningContext(3, currentUserRequest)).map((fact) => ({
            fact,
            decisionRecord: undefined
          })),
          hiddenDecisionRecords: [],
          asOfObservedTime: task.createdAt,
          asOfValidTime: undefined
        };
    recordProfileMemoryRetrievalOperation(requestTelemetry);
    const plannerEpisodes = await readSession.queryEpisodesForPlanningContext(
      2,
      currentUserRequest,
      task.createdAt
    );
    const plannerSynthesisEpisodes = plannerEpisodes.map((episode) =>
      toMemorySynthesisEpisodeRecord(episode)
    );
    const plannerSynthesisFacts = plannerFactInspection.entries.map((entry) =>
      toMemorySynthesisFactRecord(entry.fact, entry.decisionRecord)
    );
    const plannerTemporalSynthesis =
      typeof readSession.queryTemporalPlanningSynthesis === "function"
        ? await readSession.queryTemporalPlanningSynthesis(currentUserRequest, task.createdAt)
        : null;
    if (plannerTemporalSynthesis) {
      recordProfileMemorySynthesisOperation(requestTelemetry);
    }
    const plannerSynthesis = plannerTemporalSynthesis
      ? adaptTemporalMemorySynthesisToBoundedMemorySynthesis(
          plannerTemporalSynthesis,
          plannerSynthesisEpisodes,
          plannerSynthesisFacts
        )
      : null;
    const memorySynthesisContext = buildPlannerContextSynthesisBlock(plannerTemporalSynthesis);
    const retrievalAuthority = resolveBrokerRetrievalAuthority(
      resolvedRouteMemoryIntent,
      plannerTemporalSynthesis !== null
    );

    if (!profileContext && !episodeContext && !memorySynthesisContext) {
      const assessedDomainBoundary = assessDomainBoundary(
        currentUserRequest,
        [],
        options.sessionDomainContext
      );
      const domainBoundary: DomainBoundaryAssessment = probing.assessment.detected
        ? {
            ...assessedDomainBoundary,
            decision: "suppress_profile_context",
            reason: "probing_detected"
          }
        : assessedDomainBoundary;
      const sourceRecallContext = await buildRouteApprovedSourceRecallContext({
        deps,
        options,
        currentUserRequest,
        resolvedRouteMemoryIntent,
        domainBoundary
      });
      if (sourceRecallContext.trim().length > 0) {
        recordProfileMemoryRenderOperation(requestTelemetry);
        recordProfileMemoryPromptSurfaceMetrics(requestTelemetry, 1, 1);
      }
      const promptCutoverGate = assessBrokerPromptCutoverGate(requestTelemetry);
      await recordAudit(
        deps.memoryAccessAuditStore,
        task.id,
        currentUserRequest,
        requestTelemetry,
        promptCutoverGate,
        requestTelemetry.storeLoadCount,
        0,
        0,
        0,
        domainBoundary,
        principalAudit
      );
      if (probing.assessment.detected) {
        await recordProbingAudit(
          deps.memoryAccessAuditStore,
          task.id,
          currentUserRequest,
          requestTelemetry,
          promptCutoverGate,
          requestTelemetry.storeLoadCount,
          0,
          0,
        0,
        domainBoundary,
        probing.assessment,
        principalAudit
      );
      }
      if (
        sourceRecallContext.trim().length > 0 &&
        promptCutoverGate.decision !== "block"
      ) {
        return {
          userInput: buildSourceRecallOnlyContextPacket(
            task,
            domainBoundary.lanes,
            domainBoundary.scores,
            "source_recall_context_relevant",
            sourceRecallContext
          ),
          profileMemoryStatus: "available"
        };
      }
      return {
        userInput: task.userInput,
        profileMemoryStatus: "available"
      };
    }

    const sanitizedProfileContext = sanitizeProfileContextForModelEgress(profileContext);
    const sanitizedEpisodeContext = sanitizeEpisodeContextForModelEgress(episodeContext);
    const assessedDomainBoundary = assessDomainBoundary(
      currentUserRequest,
      plannerSynthesis?.laneBoundaries ?? [],
      options.sessionDomainContext
    );
    const domainBoundary: DomainBoundaryAssessment = probing.assessment.detected
      ? {
          ...assessedDomainBoundary,
          decision: "suppress_profile_context",
          reason: "probing_detected"
        }
      : !retrievalAuthority.allowInjection
        ? {
            ...assessedDomainBoundary,
            decision: "suppress_profile_context",
            reason: "memory_retrieval_authority_blocked"
          }
      : assessedDomainBoundary;
    const retrievedCount = countRetrievedProfileFacts(profileContext);
    const retrievedEpisodeCount = countRetrievedEpisodeSummaries(episodeContext);
    const redactedCount =
      sanitizedProfileContext.redactedFieldCount + sanitizedEpisodeContext.redactedFieldCount;

    const brokeredContext =
      domainBoundary.decision === "suppress_profile_context"
        ? ""
        : (() => {
            const egressGuardFooter =
              redactedCount > 0
                ? ["[AgentFriendProfileEgressGuard]", `redactedSensitiveFields=${redactedCount}`].join("\n")
                : "";
            return memorySynthesisContext.trim().length > 0
              ? [memorySynthesisContext, egressGuardFooter]
                  .filter((section) => section.trim().length > 0)
                  .join("\n")
              : `${sanitizedProfileContext.sanitizedContext}${egressGuardFooter ? `\n${egressGuardFooter}` : ""}`;
          })();
    const sourceRecallContext = await buildRouteApprovedSourceRecallContext({
      deps,
      options,
      currentUserRequest,
      resolvedRouteMemoryIntent,
      domainBoundary
    });
    const hasPromptMemorySurface =
      brokeredContext.trim().length > 0 || sourceRecallContext.trim().length > 0;
    const promptMemoryOwnerCount = hasPromptMemorySurface ? 1 : 0;
    const promptMemorySurfaceCount = hasPromptMemorySurface ? 1 : 0;
    if (promptMemorySurfaceCount > 0) {
      recordProfileMemoryRenderOperation(requestTelemetry);
    }
    recordProfileMemoryPromptSurfaceMetrics(
      requestTelemetry,
      promptMemoryOwnerCount,
      promptMemorySurfaceCount
    );
    const promptCutoverGate = assessBrokerPromptCutoverGate(requestTelemetry);

    await recordAudit(
      deps.memoryAccessAuditStore,
      task.id,
      currentUserRequest,
      requestTelemetry,
      promptCutoverGate,
      requestTelemetry.storeLoadCount,
      retrievedCount,
      retrievedEpisodeCount,
      redactedCount,
      domainBoundary,
      principalAudit
    );
    if (probing.assessment.detected) {
      await recordProbingAudit(
        deps.memoryAccessAuditStore,
        task.id,
        currentUserRequest,
        requestTelemetry,
        promptCutoverGate,
        requestTelemetry.storeLoadCount,
        retrievedCount,
        retrievedEpisodeCount,
      redactedCount,
      domainBoundary,
      probing.assessment,
      principalAudit
    );
    }

    if (promptCutoverGate.decision === "block") {
      return {
        userInput: buildSuppressedContextPacket(
          task,
          domainBoundary.lanes,
          domainBoundary.scores,
          promptCutoverGate.decision === "block"
            ? `prompt_cutover_gate_blocked:${promptCutoverGate.reasons.join(",")}`
            : domainBoundary.reason,
          retrievalAuthority.metadata
        ),
        profileMemoryStatus: "available"
      };
    }

    if (domainBoundary.decision === "suppress_profile_context") {
      if (sourceRecallContext.trim().length > 0) {
        return {
          userInput: buildSourceRecallOnlyContextPacket(
            task,
            domainBoundary.lanes,
            domainBoundary.scores,
            "source_recall_context_relevant",
            sourceRecallContext
          ),
          profileMemoryStatus: "available"
        };
      }
      return {
        userInput: buildSuppressedContextPacket(
          task,
          domainBoundary.lanes,
          domainBoundary.scores,
          domainBoundary.reason,
          retrievalAuthority.metadata
        ),
        profileMemoryStatus: "available"
      };
    }

    if (brokeredContext.trim().length === 0 && sourceRecallContext.trim().length > 0) {
      return {
        userInput: buildSourceRecallOnlyContextPacket(
          task,
          domainBoundary.lanes,
          domainBoundary.scores,
          "source_recall_context_relevant",
          sourceRecallContext
        ),
        profileMemoryStatus: "available"
      };
    }

    return {
      userInput: buildInjectedContextPacket(
        task,
        domainBoundary.lanes,
        domainBoundary.scores,
        domainBoundary.reason,
        brokeredContext,
        "",
        "",
        retrievalAuthority.metadata,
        sourceRecallContext
      ),
      profileMemoryStatus: "available"
    };
  } catch (error) {
    console.error(
      `[MemoryBroker] non-fatal profile-memory brokerage failure for task ${task.id}: ${(error as Error).message}`
    );
    return {
      userInput: [
        task.userInput,
        "",
        "[AgentFriendProfileStatus]",
        "mode=degraded_unavailable",
        "reason=profile_memory_unavailable"
      ].join("\n"),
      profileMemoryStatus: "degraded_unavailable"
    };
  }
}

/** Appends the standard retrieval audit event for one brokered planner-input build. */
async function recordAudit(
  memoryAccessAuditStore: MemoryAccessAuditStore,
  taskId: string,
  query: string,
  requestTelemetry: import("../core/profileMemoryRuntime/contracts").ProfileMemoryRequestTelemetry,
  promptCutoverGate: BrokerPromptCutoverGateResult,
  storeLoadCount: number,
  retrievedCount: number,
  retrievedEpisodeCount: number,
  redactedCount: number,
  domainBoundary: DomainBoundaryAssessment,
  principalAudit?: MemoryAccessPrincipalAuditSnapshot
): Promise<void> {
  await appendMemoryAccessAudit(
    memoryAccessAuditStore,
    taskId,
    query,
    retrievedCount,
    retrievedEpisodeCount,
    redactedCount,
    domainBoundary.lanes,
    {
      storeLoadCount,
      ingestOperationCount: requestTelemetry.ingestOperationCount,
      retrievalOperationCount: requestTelemetry.retrievalOperationCount,
      synthesisOperationCount: requestTelemetry.synthesisOperationCount,
      renderOperationCount: requestTelemetry.renderOperationCount,
      promptMemoryOwnerCount: requestTelemetry.promptMemoryOwnerCount,
      promptMemorySurfaceCount: requestTelemetry.promptMemorySurfaceCount,
      mixedMemoryOwnerDecisionCount: requestTelemetry.mixedMemoryOwnerDecisionCount,
      principalAudit,
      promptCutoverGateDecision: promptCutoverGate.decision,
      promptCutoverGateReasons: promptCutoverGate.reasons
    }
  );
}

/** Appends the probing-specific audit event when extraction-style bursts are detected. */
async function recordProbingAudit(
  memoryAccessAuditStore: MemoryAccessAuditStore,
  taskId: string,
  query: string,
  requestTelemetry: import("../core/profileMemoryRuntime/contracts").ProfileMemoryRequestTelemetry,
  promptCutoverGate: BrokerPromptCutoverGateResult,
  storeLoadCount: number,
  retrievedCount: number,
  retrievedEpisodeCount: number,
  redactedCount: number,
  domainBoundary: DomainBoundaryAssessment,
  probingAssessment: ReturnType<typeof registerAndAssessProbing>["assessment"],
  principalAudit?: MemoryAccessPrincipalAuditSnapshot
): Promise<void> {
  await appendMemoryAccessAudit(
    memoryAccessAuditStore,
    taskId,
    query,
    retrievedCount,
    retrievedEpisodeCount,
    redactedCount,
    domainBoundary.lanes,
    {
      eventType: "PROBING_DETECTED",
      storeLoadCount,
      ingestOperationCount: requestTelemetry.ingestOperationCount,
      retrievalOperationCount: requestTelemetry.retrievalOperationCount,
      synthesisOperationCount: requestTelemetry.synthesisOperationCount,
      renderOperationCount: requestTelemetry.renderOperationCount,
      promptMemoryOwnerCount: requestTelemetry.promptMemoryOwnerCount,
      promptMemorySurfaceCount: requestTelemetry.promptMemorySurfaceCount,
      mixedMemoryOwnerDecisionCount: requestTelemetry.mixedMemoryOwnerDecisionCount,
      principalAudit,
      promptCutoverGateDecision: promptCutoverGate.decision,
      promptCutoverGateReasons: promptCutoverGate.reasons,
      retrievedEpisodeCount,
      probeSignals: probingAssessment.matchedSignals,
      probeWindowSize: probingAssessment.windowSize,
      probeMatchCount: probingAssessment.matchCount,
      probeMatchRatio: probingAssessment.matchRatio
    }
  );
}

/** Converts one readable planner episode into the bounded synthesis episode shape. */
function toMemorySynthesisEpisodeRecord(
  episode: ProfileReadableEpisode
): MemorySynthesisEpisodeRecord {
  return {
    episodeId: episode.episodeId,
    title: episode.title,
    summary: episode.summary,
    status: episode.status,
    lastMentionedAt: episode.lastMentionedAt,
    entityRefs: [...episode.entityRefs],
    entityLinks: episode.entityRefs.map((entityRef: string, index: number) => ({
      entityKey: `episode_entity_${episode.episodeId}_${index}`,
      canonicalName: entityRef
    })),
    openLoopLinks: episode.openLoopRefs.map((loopId: string, index: number) => ({
      loopId,
      threadKey: `episode_thread_${episode.episodeId}_${index}`,
      status: episode.status === "resolved" ? "resolved" : "open",
      priority: 1
    }))
  };
}

/** Converts one readable planner fact into the bounded synthesis fact shape. */
function toMemorySynthesisFactRecord(
  fact: ProfileReadableFact,
  decisionRecord?: ProfileFactPlanningInspectionResult["entries"][number]["decisionRecord"]
): MemorySynthesisFactRecord {
  return {
    factId: fact.factId,
    key: fact.key,
    value: fact.value,
    status: fact.status,
    observedAt: fact.observedAt,
    lastUpdatedAt: fact.lastUpdatedAt,
    confidence: fact.confidence,
    decisionRecord
  };
}
