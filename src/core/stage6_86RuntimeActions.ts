/**
 * @fileoverview Executes Stage 6.86 `memory_mutation` and `pulse_emit` actions with durable state adapters and deterministic lifecycle updates.
 */

import { LedgerBackend } from "./config";
import { EntityGraphStore } from "./entityGraphStore";
import {
  applyMemoryMutationV1,
  Stage686MemoryStoresV1,
  Stage686PulseStateV1
} from "./stage6_86MemoryGovernance";
import {
  evaluateBridgeQuestionEmissionV1,
  resolveBridgeQuestionAnswerV1
} from "./stage6_86BridgeQuestions";
import {
  resolveOpenLoopOnConversationStackV1,
  selectOpenLoopsForPulseV1,
  upsertOpenLoopOnConversationStackV1
} from "./stage6_86OpenLoops";
import { Stage686RuntimeStateSnapshot, Stage686RuntimeStateStore } from "./stage6_86RuntimeStateStore";
import {
  BridgeQuestionV1,
  ConstraintViolationCode,
  ConversationStackV1,
  EntityGraphV1,
  MemoryMutationActionParams,
  PulseEmitActionParams,
  TaskRunResult
} from "./types";

type Metadata = Record<string, string | number | boolean | null>;

export interface Stage686RuntimeActionEngineOptions {
  backend: LedgerBackend;
  sqlitePath: string;
  exportJsonOnWrite: boolean;
  entityGraphStore?: EntityGraphStore;
  runtimeStateStore?: Stage686RuntimeStateStore;
}

export interface ExecuteStage686RuntimeActionInput {
  taskId: string;
  proposalId: string;
  missionId: string;
  missionAttemptId: number;
  action: TaskRunResult["plan"]["actions"][number];
}

export interface Stage686RuntimeActionResult {
  approved: boolean;
  output: string;
  violationCode: Extract<ConstraintViolationCode, "MEMORY_MUTATION_BLOCKED" | "PULSE_BLOCKED"> | null;
  violationMessage: string | null;
  executionMetadata: Metadata;
  traceDetails: Metadata;
}

/**
 * Normalizes optional string into trimmed non-empty text.
 *
 * @param value - Candidate text value.
 * @returns Trimmed text or `null`.
 */
function toText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalizes unknown list into unique sorted string refs.
 *
 * @param value - Candidate list.
 * @returns Deterministic string refs.
 */
function toStringRefs(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const refs = value.map((entry) => toText(entry)).filter((entry): entry is string => entry !== null);
  return [...new Set(refs)].sort((left, right) => left.localeCompare(right));
}

/**
 * Evaluates plain object record and returns a deterministic policy signal.
 *
 * @param value - Candidate object.
 * @returns `true` when value is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Builds UTC day key for pulse daily counters.
 *
 * @param iso - ISO timestamp.
 * @returns `YYYY-MM-DD` UTC day key.
 */
function utcDayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * Registers one pulse emission in pulse-state counters.
 *
 * @param pulseState - Existing pulse-state.
 * @param observedAt - Emission timestamp.
 * @returns Updated pulse-state.
 */
function registerPulseEmission(pulseState: Stage686PulseStateV1, observedAt: string): Stage686PulseStateV1 {
  const previousKey = pulseState.lastPulseAt ? utcDayKey(pulseState.lastPulseAt) : null;
  const nextKey = utcDayKey(observedAt);
  return {
    ...pulseState,
    updatedAt: observedAt,
    lastPulseAt: observedAt,
    emittedTodayCount: previousKey === nextKey ? pulseState.emittedTodayCount + 1 : 1
  };
}

/**
 * Ensures stack has target thread before open-loop/topic operations.
 *
 * @param stack - Existing conversation stack.
 * @param threadKey - Target thread key.
 * @param observedAt - Mutation timestamp.
 * @returns Stack with ensured thread.
 */
function ensureThread(stack: ConversationStackV1, threadKey: string, observedAt: string): ConversationStackV1 {
  if (stack.threads.some((thread) => thread.threadKey === threadKey)) return stack;
  const topicKey = `topic_${threadKey}`;
  return {
    schemaVersion: "v1",
    updatedAt: observedAt,
    activeThreadKey: stack.activeThreadKey ?? threadKey,
    threads: [
      ...stack.threads,
      {
        threadKey,
        topicKey,
        topicLabel: threadKey.replace(/[_-]+/g, " "),
        state: "active",
        resumeHint: "Resume deterministic continuity follow-up.",
        openLoops: [],
        lastTouchedAt: observedAt
      }
    ],
    topics: [
      ...stack.topics,
      {
        topicKey,
        label: threadKey.replace(/[_-]+/g, " "),
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        mentionCount: 1
      }
    ]
  };
}

/**
 * Ensures graph has one deterministic placeholder entity node.
 *
 * @param graph - Current entity graph.
 * @param entityKey - Entity key.
 * @param observedAt - Mutation timestamp.
 * @param evidenceRefs - Evidence refs.
 * @returns Updated graph.
 */
function ensureEntity(graph: EntityGraphV1, entityKey: string, observedAt: string, evidenceRefs: readonly string[]): EntityGraphV1 {
  if (graph.entities.some((entity) => entity.entityKey === entityKey)) return graph;
  return {
    ...graph,
    updatedAt: observedAt,
    entities: [
      ...graph.entities,
      {
        entityKey,
        canonicalName: entityKey.replace(/^entity_/, "").replace(/[_-]+/g, " "),
        entityType: "concept" as const,
        disambiguator: null,
        aliases: [entityKey],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        salience: 4,
        evidenceRefs
      }
    ].sort((left, right) => left.entityKey.localeCompare(right.entityKey))
  };
}

/**
 * Ensures graph has one deterministic co-mention edge for bridge flow.
 *
 * @param graph - Current graph.
 * @param sourceEntityKey - Source entity key.
 * @param targetEntityKey - Target entity key.
 * @param observedAt - Mutation timestamp.
 * @param evidenceRefs - Evidence refs.
 * @returns Updated graph.
 */
function ensureCoMentionEdge(
  graph: EntityGraphV1,
  sourceEntityKey: string,
  targetEntityKey: string,
  observedAt: string,
  evidenceRefs: readonly string[]
): EntityGraphV1 {
  const pair = [sourceEntityKey, targetEntityKey].sort((left, right) => left.localeCompare(right));
  const exists = graph.edges.some((edge) => {
    const edgePair = [edge.sourceEntityKey, edge.targetEntityKey].sort((left, right) => left.localeCompare(right));
    return edgePair[0] === pair[0] && edgePair[1] === pair[1];
  });
  if (exists) return graph;
  return {
    ...graph,
    updatedAt: observedAt,
    edges: [
      ...graph.edges,
      {
        edgeKey: `edge_${pair[0]}_${pair[1]}`,
        sourceEntityKey: pair[0]!,
        targetEntityKey: pair[1]!,
        relationType: "co_mentioned" as const,
        status: "uncertain" as const,
        coMentionCount: 3,
        strength: 0.6,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        evidenceRefs
      }
    ].sort((left, right) => left.edgeKey.localeCompare(right.edgeKey))
  };
}

/**
 * Executes Stage 6.86 runtime action semantics.
 */
export class Stage686RuntimeActionEngine {
  private readonly entityGraphStore: EntityGraphStore;
  private readonly runtimeStateStore: Stage686RuntimeStateStore;

  /**
   * Initializes Stage 6.86 runtime action engine dependencies.
   *
   * @param options - Runtime backend/store options.
   */
  constructor(options: Stage686RuntimeActionEngineOptions) {
    this.entityGraphStore =
      options.entityGraphStore ??
      new EntityGraphStore(undefined, {
        backend: options.backend,
        sqlitePath: options.sqlitePath,
        exportJsonOnWrite: options.exportJsonOnWrite
      });
    this.runtimeStateStore =
      options.runtimeStateStore ??
      new Stage686RuntimeStateStore(undefined, {
        backend: options.backend,
        sqlitePath: options.sqlitePath,
        exportJsonOnWrite: options.exportJsonOnWrite
      });
  }

  /**
   * Executes Stage 6.86 semantics for one action when supported.
   *
   * @param input - Task/mission/action context.
   * @returns Stage 6.86 result or `null` for non-Stage-6.86 actions.
   */
  async execute(input: ExecuteStage686RuntimeActionInput): Promise<Stage686RuntimeActionResult | null> {
    if (input.action.type === "memory_mutation") return this.executeMemoryMutation(input);
    if (input.action.type === "pulse_emit") return this.executePulseEmit(input);
    return null;
  }

  /**
   * Executes Stage 6.86 memory mutation flow with durable adapter persistence.
   *
   * @param input - Task/mission/action context.
   * @returns Runtime result for memory mutation.
   */
  private async executeMemoryMutation(input: ExecuteStage686RuntimeActionInput): Promise<Stage686RuntimeActionResult> {
    const observedAt = new Date().toISOString();
    const runtimeState = await this.runtimeStateStore.load();
    const graph = await this.entityGraphStore.getGraph();
    const params = input.action.params as MemoryMutationActionParams;

    let seededStores: Stage686MemoryStoresV1 = {
      entityGraph: graph,
      conversationStack: runtimeState.conversationStack,
      pulseState: runtimeState.pulseState
    };
    if (params.store === "conversation_stack" && isRecord(params.payload)) {
      const openLoopText = toText(params.payload.openLoopText);
      if (openLoopText) {
        const targetThread = toText(params.payload.threadKey) ?? seededStores.conversationStack.activeThreadKey ?? "thread_runtime_memory";
        const seededStack = ensureThread(seededStores.conversationStack, targetThread, observedAt);
        const upserted = upsertOpenLoopOnConversationStackV1({
          stack: seededStack,
          threadKey: targetThread,
          text: openLoopText,
          observedAt,
          entityRefs: toStringRefs(params.payload.entityRefs),
          priorityHint: 0.71
        });
        seededStores = {
          ...seededStores,
          conversationStack: upserted.stack
        };
      }
    }

    const mutationResult = applyMemoryMutationV1({
      stores: seededStores,
      params,
      observedAt,
      scopeId: input.missionId,
      taskId: input.taskId,
      proposalId: input.proposalId,
      actionId: input.action.id,
      missionId: input.missionId,
      missionAttemptId: String(input.missionAttemptId),
      priorReceiptHash: runtimeState.lastMemoryMutationReceiptHash
    });

    if (mutationResult.blockCode) {
      const reason = mutationResult.blockDetailReason ?? "unknown_conflict";
      return {
        approved: false,
        output: `Memory mutation blocked: ${reason}.`,
        violationCode: "MEMORY_MUTATION_BLOCKED",
        violationMessage: `Stage 6.86 memory mutation blocked: ${reason}.`,
        executionMetadata: {
          stage686MutationBlocked: true,
          stage686MutationBlockReason: reason
        },
        traceDetails: {
          stage686MutationBlocked: true,
          stage686MutationBlockReason: reason
        }
      };
    }

    const receipt = mutationResult.receipt;
    const canonicalDiff = mutationResult.canonicalDiff;
    if (!receipt || !canonicalDiff) {
      return {
        approved: false,
        output: "Memory mutation blocked: missing receipt or canonical diff.",
        violationCode: "MEMORY_MUTATION_BLOCKED",
        violationMessage: "Stage 6.86 memory mutation blocked: missing receipt or canonical diff.",
        executionMetadata: {
          stage686MutationBlocked: true,
          stage686MutationBlockReason: "missing_receipt_or_diff"
        },
        traceDetails: {
          stage686MutationBlocked: true,
          stage686MutationBlockReason: "missing_receipt_or_diff"
        }
      };
    }

    await this.entityGraphStore.persistGraph(mutationResult.stores.entityGraph);
    await this.runtimeStateStore.save({
      updatedAt: observedAt,
      conversationStack: mutationResult.stores.conversationStack,
      pulseState: mutationResult.stores.pulseState,
      pendingBridgeQuestions: runtimeState.pendingBridgeQuestions,
      lastMemoryMutationReceiptHash: receipt.mutationId
    });

    return {
      approved: true,
      output: `Memory mutation applied: store=${receipt.store}, operation=${receipt.operation}, mutationId=${receipt.mutationId}.`,
      violationCode: null,
      violationMessage: null,
      executionMetadata: {
        stage686MutationId: receipt.mutationId,
        stage686MutationStore: receipt.store,
        stage686MutationOperation: receipt.operation,
        stage686MutationBeforeFingerprint: canonicalDiff.beforeFingerprint,
        stage686MutationAfterFingerprint: canonicalDiff.afterFingerprint
      },
      traceDetails: {
        stage686MutationStore: receipt.store,
        stage686MutationOperation: receipt.operation,
        stage686MutationBeforeFingerprint: canonicalDiff.beforeFingerprint,
        stage686MutationAfterFingerprint: canonicalDiff.afterFingerprint
      }
    };
  }

  /**
   * Executes Stage 6.86 pulse kinds with bridge/open-loop/topic/stale-fact semantics.
   *
   * @param input - Task/mission/action context.
   * @returns Runtime result for pulse emit.
   */
  private async executePulseEmit(input: ExecuteStage686RuntimeActionInput): Promise<Stage686RuntimeActionResult> {
    const observedAt = new Date().toISOString();
    const runtimeState = await this.runtimeStateStore.load();
    let graph = await this.entityGraphStore.getGraph();
    const params = input.action.params as PulseEmitActionParams;
    const kind = toText(params.kind);
    if (!kind) {
      return {
        approved: false,
        output: "Pulse blocked: missing kind.",
        violationCode: "PULSE_BLOCKED",
        violationMessage: "Stage 6.86 pulse blocked: missing kind.",
        executionMetadata: { stage686PulseBlocked: true, stage686PulseKind: "missing" },
        traceDetails: { stage686PulseBlocked: true, stage686PulseKind: "missing" }
      };
    }

    let nextStack = runtimeState.conversationStack;
    let nextPulseState = runtimeState.pulseState;
    let nextPendingQuestions: readonly BridgeQuestionV1[] = runtimeState.pendingBridgeQuestions;
    const refs = toStringRefs(params.entityRefs);

    if (kind === "bridge_question") {
      const answerKind = toText(params.answerKind);
      if (answerKind) {
        const questionId = toText(params.questionId);
        const question =
          nextPendingQuestions.find((entry) => entry.questionId === questionId) ??
          (nextPendingQuestions.length > 0 ? nextPendingQuestions[nextPendingQuestions.length - 1] : null);
        if (!question) {
          return {
            approved: false,
            output: "Pulse blocked: no pending bridge question.",
            violationCode: "PULSE_BLOCKED",
            violationMessage: "Stage 6.86 pulse blocked: no pending bridge question.",
            executionMetadata: { stage686PulseBlocked: true, stage686PulseKind: kind, stage686PulseBlockReason: "BRIDGE_INSUFFICIENT_EVIDENCE" },
            traceDetails: { stage686PulseBlocked: true, stage686PulseKind: kind, stage686PulseBlockReason: "BRIDGE_INSUFFICIENT_EVIDENCE" }
          };
        }
        const relationType = toText(params.relationType);
        const resolved = resolveBridgeQuestionAnswerV1({
          graph,
          question,
          observedAt,
          evidenceRef: toText(toStringRefs(params.evidenceRefs)[0]) ?? `trace:${input.taskId}:bridge_resolution`,
          answer: {
            kind: answerKind === "confirmed" ? "confirmed" : "deferred",
            relationType:
              relationType === "friend" ||
              relationType === "family" ||
              relationType === "coworker" ||
              relationType === "project_related" ||
              relationType === "other"
                ? relationType
                : undefined
          },
          recentBridgeHistory: nextPulseState.bridgeHistory
        });
        graph = resolved.graph;
        nextPendingQuestions = nextPendingQuestions.filter((entry) => entry.questionId !== question.questionId);
        nextPulseState = {
          ...registerPulseEmission(nextPulseState, observedAt),
          bridgeHistory: [...nextPulseState.bridgeHistory.filter((entry) => entry.questionId !== resolved.historyRecord.questionId), resolved.historyRecord]
            .sort((left, right) => left.askedAt.localeCompare(right.askedAt))
            .slice(-200)
        };
        await this.entityGraphStore.persistGraph(graph);
        await this.runtimeStateStore.save({
          updatedAt: observedAt,
          conversationStack: nextStack,
          pulseState: nextPulseState,
          pendingBridgeQuestions: nextPendingQuestions,
          lastMemoryMutationReceiptHash: runtimeState.lastMemoryMutationReceiptHash
        });
        const approved = resolved.deniedConflictCode === null;
        return {
          approved,
          output: approved ? `Bridge question resolved: ${question.questionId}.` : `Bridge resolution deferred: ${resolved.deniedConflictCode}.`,
          violationCode: approved ? null : "PULSE_BLOCKED",
          violationMessage: approved ? null : `Stage 6.86 pulse blocked: bridge resolution denied (${resolved.deniedConflictCode}).`,
          executionMetadata: { stage686PulseKind: kind, stage686BridgeResolvedQuestionId: question.questionId, stage686BridgeResolutionApproved: approved, stage686BridgeResolutionConflict: resolved.deniedConflictCode ?? null },
          traceDetails: { stage686PulseKind: kind, stage686BridgeResolvedQuestionId: question.questionId, stage686BridgeResolutionApproved: approved, stage686BridgeResolutionConflict: resolved.deniedConflictCode ?? null }
        };
      }

      if (refs.length < 2) {
        return {
          approved: false,
          output: "Pulse blocked: bridge_question requires two entity refs.",
          violationCode: "PULSE_BLOCKED",
          violationMessage: "Stage 6.86 pulse blocked: bridge_question requires two entity refs.",
          executionMetadata: { stage686PulseBlocked: true, stage686PulseKind: kind, stage686PulseBlockReason: "BRIDGE_INSUFFICIENT_EVIDENCE" },
          traceDetails: { stage686PulseBlocked: true, stage686PulseKind: kind, stage686PulseBlockReason: "BRIDGE_INSUFFICIENT_EVIDENCE" }
        };
      }
      const evidenceRefs = toStringRefs(params.evidenceRefs);
      graph = ensureEntity(graph, refs[0]!, observedAt, evidenceRefs);
      graph = ensureEntity(graph, refs[1]!, observedAt, evidenceRefs);
      graph = ensureCoMentionEdge(graph, refs[0]!, refs[1]!, observedAt, evidenceRefs);
      const threadKey = toText(params.threadKey) ?? nextStack.activeThreadKey ?? "thread_runtime_bridge";
      const bridgeCandidate = {
        candidateId: `bridge_${refs[0]}_${refs[1]}`,
        reasonCode: "RELATIONSHIP_CLARIFICATION" as const,
        score: 0.9,
        scoreBreakdown: { recency: 0.9, frequency: 0.9, unresolvedImportance: 0.8, sensitivityPenalty: 0, cooldownPenalty: 0 },
        lastTouchedAt: observedAt,
        threadKey,
        entityRefs: [refs[0]!, refs[1]!],
        evidenceRefs,
        stableHash: `bridge:${refs[0]}:${refs[1]}`
      };
      const decision = evaluateBridgeQuestionEmissionV1(
        { graph, candidate: bridgeCandidate, observedAt, recentBridgeHistory: nextPulseState.bridgeHistory },
        { coMentionThreshold: 2 }
      );
      if (!decision.approved || !decision.bridgeQuestion) {
        return {
          approved: false,
          output: `Pulse blocked: bridge_question denied (${decision.blockDetailReason ?? "unknown"}).`,
          violationCode: "PULSE_BLOCKED",
          violationMessage: `Stage 6.86 pulse blocked: bridge_question denied (${decision.blockDetailReason ?? "unknown"}).`,
          executionMetadata: { stage686PulseBlocked: true, stage686PulseKind: kind, stage686PulseBlockReason: decision.blockDetailReason ?? "unknown" },
          traceDetails: { stage686PulseBlocked: true, stage686PulseKind: kind, stage686PulseBlockReason: decision.blockDetailReason ?? "unknown" }
        };
      }
      const question = decision.bridgeQuestion;
      nextPendingQuestions = [...nextPendingQuestions.filter((entry) => entry.questionId !== question.questionId), question]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(-64);
      nextPulseState = registerPulseEmission(
        {
          ...nextPulseState,
          bridgeHistory: [
            ...nextPulseState.bridgeHistory.filter((entry) => entry.questionId !== question.questionId),
            {
              questionId: question.questionId,
              sourceEntityKey: question.sourceEntityKey,
              targetEntityKey: question.targetEntityKey,
              askedAt: observedAt,
              status: "asked" as const,
              cooldownUntil: question.cooldownUntil,
              deferralCount: 0,
              conversationKey: threadKey
            }
          ].sort((left, right) => left.askedAt.localeCompare(right.askedAt)).slice(-200)
        },
        observedAt
      );
      await this.entityGraphStore.persistGraph(graph);
      await this.runtimeStateStore.save({
        updatedAt: observedAt,
        conversationStack: nextStack,
        pulseState: nextPulseState,
        pendingBridgeQuestions: nextPendingQuestions,
        lastMemoryMutationReceiptHash: runtimeState.lastMemoryMutationReceiptHash
      });
      return {
        approved: true,
        output: `Bridge question emitted: ${question.prompt}`,
        violationCode: null,
        violationMessage: null,
        executionMetadata: { stage686PulseKind: kind, stage686BridgeQuestionId: question.questionId, stage686BridgeThreadKey: question.threadKey ?? null },
        traceDetails: { stage686PulseKind: kind, stage686BridgeQuestionId: question.questionId, stage686BridgeThreadKey: question.threadKey ?? null }
      };
    }

    if (kind === "open_loop_resume") {
      const threadKey = toText(params.threadKey) ?? nextStack.activeThreadKey ?? "thread_runtime_open_loop";
      const stackWithThread = ensureThread(nextStack, threadKey, observedAt);
      const seeded = upsertOpenLoopOnConversationStackV1({
        stack: stackWithThread,
        threadKey,
        text: toText(params.seedText) ?? "Please follow up on this unresolved decision later.",
        observedAt,
        entityRefs: refs,
        priorityHint: 0.74
      });
      const selection = selectOpenLoopsForPulseV1(seeded.stack, observedAt, { maxOpenLoopsSurfaced: 1 });
      if (selection.selected.length === 0) {
        return {
          approved: false,
          output: "Pulse blocked: no eligible open-loop candidate.",
          violationCode: "PULSE_BLOCKED",
          violationMessage: "Stage 6.86 pulse blocked: no eligible open-loop candidate.",
          executionMetadata: { stage686PulseBlocked: true, stage686PulseKind: kind, stage686PulseBlockReason: "OPEN_LOOP_CAP_REACHED" },
          traceDetails: { stage686PulseBlocked: true, stage686PulseKind: kind, stage686PulseBlockReason: "OPEN_LOOP_CAP_REACHED" }
        };
      }
      const selected = selection.selected[0]!;
      const resolved = resolveOpenLoopOnConversationStackV1({
        stack: seeded.stack,
        threadKey: selected.threadKey,
        loopId: selected.loopId,
        observedAt,
        status: "resolved"
      });
      if (!resolved.resolved) {
        return {
          approved: false,
          output: "Pulse blocked: selected open loop could not be resolved.",
          violationCode: "PULSE_BLOCKED",
          violationMessage: "Stage 6.86 pulse blocked: selected open loop could not be resolved.",
          executionMetadata: { stage686PulseBlocked: true, stage686PulseKind: kind, stage686PulseBlockReason: "OPEN_LOOP_CAP_REACHED" },
          traceDetails: { stage686PulseBlocked: true, stage686PulseKind: kind, stage686PulseBlockReason: "OPEN_LOOP_CAP_REACHED" }
        };
      }
      nextStack = resolved.stack;
      nextPulseState = registerPulseEmission(nextPulseState, observedAt);
      await this.entityGraphStore.persistGraph(graph);
      await this.runtimeStateStore.save({
        updatedAt: observedAt,
        conversationStack: nextStack,
        pulseState: nextPulseState,
        pendingBridgeQuestions: nextPendingQuestions,
        lastMemoryMutationReceiptHash: runtimeState.lastMemoryMutationReceiptHash
      });
      return {
        approved: true,
        output: `Open loop resumed and resolved: ${selected.loopId}.`,
        violationCode: null,
        violationMessage: null,
        executionMetadata: { stage686PulseKind: kind, stage686PulseThreadKey: selected.threadKey, stage686PulseLoopId: selected.loopId },
        traceDetails: { stage686PulseKind: kind, stage686PulseThreadKey: selected.threadKey, stage686PulseLoopId: selected.loopId }
      };
    }

    if (kind === "topic_resume") {
      const threadKey = toText(params.threadKey) ?? nextStack.activeThreadKey ?? "thread_runtime_topic";
      const stackWithThread = ensureThread(nextStack, threadKey, observedAt);
      nextStack = {
        schemaVersion: "v1",
        updatedAt: observedAt,
        activeThreadKey: threadKey,
        threads: stackWithThread.threads.map((thread) => ({
          ...thread,
          state: thread.threadKey === threadKey ? "active" : thread.state,
          lastTouchedAt: thread.threadKey === threadKey ? observedAt : thread.lastTouchedAt
        })),
        topics: stackWithThread.topics
      };
      nextPulseState = registerPulseEmission(nextPulseState, observedAt);
      await this.entityGraphStore.persistGraph(graph);
      await this.runtimeStateStore.save({
        updatedAt: observedAt,
        conversationStack: nextStack,
        pulseState: nextPulseState,
        pendingBridgeQuestions: nextPendingQuestions,
        lastMemoryMutationReceiptHash: runtimeState.lastMemoryMutationReceiptHash
      });
      return {
        approved: true,
        output: `Topic resumed on thread: ${threadKey}.`,
        violationCode: null,
        violationMessage: null,
        executionMetadata: { stage686PulseKind: kind, stage686PulseThreadKey: threadKey },
        traceDetails: { stage686PulseKind: kind, stage686PulseThreadKey: threadKey }
      };
    }

    if (kind === "stale_fact_revalidation") {
      const entityKey = refs[0] ?? (graph.entities[0]?.entityKey ?? "entity_runtime_fact");
      graph = ensureEntity(graph, entityKey, observedAt, toStringRefs(params.evidenceRefs));
      nextPulseState = registerPulseEmission(nextPulseState, observedAt);
      await this.entityGraphStore.persistGraph(graph);
      await this.runtimeStateStore.save({
        updatedAt: observedAt,
        conversationStack: nextStack,
        pulseState: nextPulseState,
        pendingBridgeQuestions: nextPendingQuestions,
        lastMemoryMutationReceiptHash: runtimeState.lastMemoryMutationReceiptHash
      });
      return {
        approved: true,
        output: `Stale fact revalidation emitted for entity: ${entityKey}.`,
        violationCode: null,
        violationMessage: null,
        executionMetadata: { stage686PulseKind: kind, stage686PulseEntityKey: entityKey },
        traceDetails: { stage686PulseKind: kind, stage686PulseEntityKey: entityKey }
      };
    }

    return {
      approved: false,
      output: `Pulse blocked: unsupported kind=${kind}.`,
      violationCode: "PULSE_BLOCKED",
      violationMessage: `Stage 6.86 pulse blocked: unsupported kind "${kind}".`,
      executionMetadata: { stage686PulseBlocked: true, stage686PulseKind: kind },
      traceDetails: { stage686PulseBlocked: true, stage686PulseKind: kind }
    };
  }
}
