/**
 * @fileoverview Brokered planner-input assembly extracted from the memory-broker entrypoint.
 */

import { ProfileMemoryStore } from "../core/profileMemoryStore";
import { MemoryAccessAuditStore } from "../core/memoryAccessAudit";
import { LanguageUnderstandingOrgan } from "./languageUnderstanding/episodeExtraction";
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
  buildSuppressedContextPacket,
  countRetrievedProfileFacts,
  sanitizeProfileContextForModelEgress
} from "./memoryContext/contextInjection";
import {
  countRetrievedEpisodeSummaries,
  sanitizeEpisodeContextForModelEgress
} from "./memoryContext/episodeContextInjection";
import type {
  DomainBoundaryAssessment,
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
  probingDetectorConfig: ReturnType<typeof resolveProbingDetectorConfig>;
  recentProbeSignals: ProbingSignalSnapshot[];
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
  if (!deps.profileMemoryStore) {
    return {
      userInput: task.userInput,
      profileMemoryStatus: "disabled"
    };
  }

  const currentUserRequest = extractCurrentUserRequest(task.userInput);
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
  const resolvedRouteMemoryIntent =
    extractResolvedRouteMemoryIntent(task.userInput) as ProfileMemoryIngestMemoryIntent | null;

  try {
    const requestTelemetry = createProfileMemoryRequestTelemetry();
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
    if (!shouldSkipProfileIngest) {
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
            sourceFingerprint
          },
          ingestPolicy: buildProfileMemoryIngestPolicy({
            memoryIntent: resolvedRouteMemoryIntent ?? "profile_update",
            sourceSurface: "broker_task_ingest"
          }),
          requestTelemetry
        }
      );
      recordProfileMemoryIngestOperation(requestTelemetry);
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

    if (!profileContext && !episodeContext && !memorySynthesisContext) {
      const domainBoundary = assessDomainBoundary(
        currentUserRequest,
        [],
        options.sessionDomainContext
      );
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
        domainBoundary
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
          probing.assessment
        );
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
    const promptMemoryOwnerCount = brokeredContext.trim().length > 0 ? 1 : 0;
    const promptMemorySurfaceCount = brokeredContext.trim().length > 0 ? 1 : 0;
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
      domainBoundary
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
        probing.assessment
      );
    }

    if (
      domainBoundary.decision === "suppress_profile_context" ||
      promptCutoverGate.decision === "block"
    ) {
      return {
        userInput: buildSuppressedContextPacket(
          task,
          domainBoundary.lanes,
          domainBoundary.scores,
          promptCutoverGate.decision === "block"
            ? `prompt_cutover_gate_blocked:${promptCutoverGate.reasons.join(",")}`
            : domainBoundary.reason
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
        brokeredContext
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
  domainBoundary: DomainBoundaryAssessment
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
  probingAssessment: ReturnType<typeof registerAndAssessProbing>["assessment"]
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
