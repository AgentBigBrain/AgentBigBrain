/**
 * @fileoverview Deterministic Stage 6.86 conversation-stack and topic-thread helpers for checkpoint 6.86.C.
 */

import type {
  ConversationStackV1,
  OpenLoopV1,
  ThreadFrameV1,
  TopicKeyCandidateV1,
  TopicNodeV1
} from "../types";
import {
  type ApplyConversationTurnOptionsV1,
  type ConversationStackMigrationInputV1,
  type ConversationStackMigrationResultV1,
  type ConversationStackTurnV1
} from "./conversationStackContracts";
import {
  assertValidIsoTimestamp,
  buildResumeHint,
  buildThreadFromTopicCandidate,
  computeTopicConfidence,
  copyThreadsByKey,
  DEFAULT_MAX_THREADS,
  DEFAULT_TOPIC_SWITCH_THRESHOLD,
  evictThreadsOverCap,
  normalizeTopicToken,
  normalizeWhitespace,
  resolveExplicitReturnThread,
  RETURN_SIGNAL_PATTERN,
  setActiveThread,
  sortThreads,
  sortTopicNodes,
  toTopicKey,
  toTopicLabel,
  tokenizeTopicWords,
  touchTopicNode
} from "./conversationStackHelpers";

export type {
  ApplyConversationTurnOptionsV1,
  ConversationStackMigrationInputV1,
  ConversationStackMigrationResultV1,
  ConversationStackTurnV1
} from "./conversationStackContracts";

/**
 * Builds empty conversation stack v1 for this module's runtime flow.
 *
 * @param updatedAt - Stack timestamp to assign at initialization.
 * @returns Empty ConversationStackV1 baseline.
 */
export function createEmptyConversationStackV1(updatedAt: string): ConversationStackV1 {
  assertValidIsoTimestamp(updatedAt, "updatedAt");
  return {
    schemaVersion: "v1",
    updatedAt,
    activeThreadKey: null,
    threads: [],
    topics: []
  };
}

/**
 * Evaluates conversation stack v1 and returns a deterministic policy signal.
 *
 * @param value - Unknown value to validate.
 * @returns `true` when value satisfies ConversationStackV1 structural requirements.
 */
export function isConversationStackV1(value: unknown): value is ConversationStackV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ConversationStackV1>;
  if (
    candidate.schemaVersion !== "v1" ||
    typeof candidate.updatedAt !== "string" ||
    (candidate.activeThreadKey !== null && typeof candidate.activeThreadKey !== "string") ||
    !Array.isArray(candidate.threads) ||
    !Array.isArray(candidate.topics)
  ) {
    return false;
  }

  for (const thread of candidate.threads) {
    if (!thread || typeof thread !== "object" || Array.isArray(thread)) {
      return false;
    }
    const threadCandidate = thread as Partial<ThreadFrameV1>;
    if (
      typeof threadCandidate.threadKey !== "string" ||
      typeof threadCandidate.topicKey !== "string" ||
      typeof threadCandidate.topicLabel !== "string" ||
      (threadCandidate.state !== "active" &&
        threadCandidate.state !== "paused" &&
        threadCandidate.state !== "resolved") ||
      typeof threadCandidate.resumeHint !== "string" ||
      typeof threadCandidate.lastTouchedAt !== "string" ||
      !Array.isArray(threadCandidate.openLoops)
    ) {
      return false;
    }
  }

  for (const topic of candidate.topics) {
    if (!topic || typeof topic !== "object" || Array.isArray(topic)) {
      return false;
    }
    const topicCandidate = topic as Partial<TopicNodeV1>;
    if (
      typeof topicCandidate.topicKey !== "string" ||
      typeof topicCandidate.label !== "string" ||
      typeof topicCandidate.firstSeenAt !== "string" ||
      typeof topicCandidate.lastSeenAt !== "string" ||
      typeof topicCandidate.mentionCount !== "number"
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Derives topic key candidates v1 from available runtime inputs.
 *
 * @param text - Turn text to analyze for topic signals.
 * @param observedAt - Timestamp to stamp on emitted candidates.
 * @returns Ordered collection produced by this step.
 */
export function deriveTopicKeyCandidatesV1(
  text: string,
  observedAt: string
): readonly TopicKeyCandidateV1[] {
  assertValidIsoTimestamp(observedAt, "observedAt");
  const tokens = tokenizeTopicWords(text);
  if (tokens.length === 0) {
    return [];
  }

  const candidateTokenSets: string[][] = [];
  candidateTokenSets.push(tokens.slice(0, Math.min(3, tokens.length)));
  if (tokens.length >= 2) {
    candidateTokenSets.push(tokens.slice(0, 2));
  }
  candidateTokenSets.push(tokens.slice(0, 1));

  const uniqueCandidatesByKey = new Map<string, TopicKeyCandidateV1>();
  for (const tokenSet of candidateTokenSets) {
    const normalizedSet = [...new Set(tokenSet.map((token) => normalizeTopicToken(token)))].filter(Boolean);
    if (normalizedSet.length === 0) {
      continue;
    }
    const topicKey = toTopicKey(normalizedSet);
    const candidate: TopicKeyCandidateV1 = {
      topicKey,
      label: toTopicLabel(normalizedSet),
      confidence: computeTopicConfidence(normalizedSet, text),
      source: normalizedSet.length > 1 ? "heuristic_phrase" : "heuristic_tokens",
      observedAt
    };
    const existing = uniqueCandidatesByKey.get(topicKey);
    if (!existing || candidate.confidence > existing.confidence) {
      uniqueCandidatesByKey.set(topicKey, candidate);
    }
  }

  return [...uniqueCandidatesByKey.values()].sort((left, right) => {
    if (left.confidence !== right.confidence) {
      return right.confidence - left.confidence;
    }
    return left.topicKey.localeCompare(right.topicKey);
  });
}

/**
 * Resolves the highest-confidence topic candidate for a turn.
 *
 * @param text - Source text used for topic extraction.
 * @param observedAt - Timestamp attached to derived topic candidates.
 * @returns Highest-confidence topic candidate or `null` when none are available.
 */
function findPrimaryTopicCandidate(text: string, observedAt: string): TopicKeyCandidateV1 | null {
  const candidates = deriveTopicKeyCandidatesV1(text, observedAt);
  return candidates[0] ?? null;
}

/**
 * Executes user turn to conversation stack v1 as part of this module's control flow.
 *
 * @param stack - Current conversation stack state.
 * @param turn - User turn to apply.
 * @param options - Optional tuning knobs for this operation.
 * @returns Updated conversation stack after user-turn routing/switching logic.
 */
export function applyUserTurnToConversationStackV1(
  stack: ConversationStackV1,
  turn: ConversationStackTurnV1,
  options: ApplyConversationTurnOptionsV1 = {}
): ConversationStackV1 {
  if (!isConversationStackV1(stack)) {
    throw new Error("Invalid ConversationStackV1 payload.");
  }
  assertValidIsoTimestamp(turn.at, "turn.at");

  const maxThreads = options.maxThreads ?? DEFAULT_MAX_THREADS;
  const topicSwitchThreshold = options.topicSwitchThreshold ?? DEFAULT_TOPIC_SWITCH_THRESHOLD;
  const threadMap = copyThreadsByKey(stack.threads);
  const topicsByKey = new Map(stack.topics.map((topic) => [topic.topicKey, { ...topic }]));
  const currentActive = stack.activeThreadKey ? threadMap.get(stack.activeThreadKey) ?? null : null;
  const normalizedTurnText = normalizeWhitespace(turn.text);
  const turnHint = buildResumeHint(normalizedTurnText);

  if (options.activeMissionThreadKey && threadMap.has(options.activeMissionThreadKey)) {
    const missionThread = threadMap.get(options.activeMissionThreadKey)!;
    threadMap.set(missionThread.threadKey, {
      ...missionThread,
      state: missionThread.state === "resolved" ? "resolved" : "active",
      lastTouchedAt: turn.at,
      resumeHint: turnHint
    });
    touchTopicNode(topicsByKey, missionThread.topicKey, missionThread.topicLabel, turn.at);
    const missionThreads = setActiveThread([...threadMap.values()], missionThread.threadKey);
    const cappedMissionThreads = evictThreadsOverCap(missionThreads, missionThread.threadKey, maxThreads);
    return {
      schemaVersion: "v1",
      updatedAt: turn.at,
      activeThreadKey: missionThread.threadKey,
      threads: cappedMissionThreads,
      topics: sortTopicNodes([...topicsByKey.values()])
    };
  }

  const explicitReturn = resolveExplicitReturnThread(stack, normalizedTurnText);
  const hasReturnSignal = RETURN_SIGNAL_PATTERN.test(normalizedTurnText);
  if (explicitReturn && explicitReturn !== "AMBIGUOUS") {
    const resumed = threadMap.get(explicitReturn.threadKey) ?? explicitReturn;
    threadMap.set(resumed.threadKey, {
      ...resumed,
      state: "active",
      lastTouchedAt: turn.at,
      resumeHint: turnHint
    });
    touchTopicNode(topicsByKey, resumed.topicKey, resumed.topicLabel, turn.at);
    const resumedThreads = setActiveThread([...threadMap.values()], resumed.threadKey);
    const cappedResumedThreads = evictThreadsOverCap(resumedThreads, resumed.threadKey, maxThreads);
    return {
      schemaVersion: "v1",
      updatedAt: turn.at,
      activeThreadKey: resumed.threadKey,
      threads: cappedResumedThreads,
      topics: sortTopicNodes([...topicsByKey.values()])
    };
  }

  if (explicitReturn === "AMBIGUOUS" && currentActive) {
    threadMap.set(currentActive.threadKey, {
      ...currentActive,
      lastTouchedAt: turn.at,
      resumeHint: turnHint
    });
    touchTopicNode(topicsByKey, currentActive.topicKey, currentActive.topicLabel, turn.at);
    return {
      schemaVersion: "v1",
      updatedAt: turn.at,
      activeThreadKey: currentActive.threadKey,
      threads: evictThreadsOverCap(
        setActiveThread([...threadMap.values()], currentActive.threadKey),
        currentActive.threadKey,
        maxThreads
      ),
      topics: sortTopicNodes([...topicsByKey.values()])
    };
  }

  if (hasReturnSignal && explicitReturn === null && currentActive) {
    threadMap.set(currentActive.threadKey, {
      ...currentActive,
      lastTouchedAt: turn.at,
      resumeHint: turnHint
    });
    touchTopicNode(topicsByKey, currentActive.topicKey, currentActive.topicLabel, turn.at);
    return {
      schemaVersion: "v1",
      updatedAt: turn.at,
      activeThreadKey: currentActive.threadKey,
      threads: evictThreadsOverCap(
        setActiveThread([...threadMap.values()], currentActive.threadKey),
        currentActive.threadKey,
        maxThreads
      ),
      topics: sortTopicNodes([...topicsByKey.values()])
    };
  }

  const primaryCandidate = findPrimaryTopicCandidate(normalizedTurnText, turn.at);
  if (!primaryCandidate || primaryCandidate.confidence < topicSwitchThreshold) {
    if (currentActive) {
      threadMap.set(currentActive.threadKey, {
        ...currentActive,
        lastTouchedAt: turn.at,
        resumeHint: turnHint
      });
      touchTopicNode(topicsByKey, currentActive.topicKey, currentActive.topicLabel, turn.at);
      return {
        schemaVersion: "v1",
        updatedAt: turn.at,
        activeThreadKey: currentActive.threadKey,
        threads: evictThreadsOverCap(
          setActiveThread([...threadMap.values()], currentActive.threadKey),
          currentActive.threadKey,
          maxThreads
        ),
        topics: sortTopicNodes([...topicsByKey.values()])
      };
    }
    return {
      ...stack,
      updatedAt: turn.at
    };
  }

  const existingByTopic = [...threadMap.values()].find((thread) => thread.topicKey === primaryCandidate.topicKey);
  const nextActiveThread: ThreadFrameV1 = existingByTopic
    ? {
        ...existingByTopic,
        state: existingByTopic.state === "resolved" ? "resolved" : "active",
        lastTouchedAt: turn.at,
        resumeHint: turnHint
      }
    : buildThreadFromTopicCandidate(primaryCandidate, turn.at, turnHint);

  threadMap.set(nextActiveThread.threadKey, nextActiveThread);
  touchTopicNode(topicsByKey, nextActiveThread.topicKey, nextActiveThread.topicLabel, turn.at);
  const switchedThreads = setActiveThread([...threadMap.values()], nextActiveThread.threadKey);
  const cappedThreads = evictThreadsOverCap(switchedThreads, nextActiveThread.threadKey, maxThreads);

  return {
    schemaVersion: "v1",
    updatedAt: turn.at,
    activeThreadKey: nextActiveThread.threadKey,
    threads: cappedThreads,
    topics: sortTopicNodes([...topicsByKey.values()])
  };
}

/**
 * Executes assistant turn to conversation stack v1 as part of this module's control flow.
 *
 * @param stack - Current conversation stack state.
 * @param turn - Assistant turn to apply.
 * @returns Updated conversation stack after assistant-turn touch updates.
 */
export function applyAssistantTurnToConversationStackV1(
  stack: ConversationStackV1,
  turn: ConversationStackTurnV1
): ConversationStackV1 {
  if (!isConversationStackV1(stack)) {
    throw new Error("Invalid ConversationStackV1 payload.");
  }
  assertValidIsoTimestamp(turn.at, "turn.at");
  if (!stack.activeThreadKey) {
    return {
      ...stack,
      updatedAt: turn.at
    };
  }

  const threadMap = copyThreadsByKey(stack.threads);
  const activeThread = threadMap.get(stack.activeThreadKey);
  if (!activeThread) {
    return {
      ...stack,
      updatedAt: turn.at
    };
  }

  threadMap.set(activeThread.threadKey, {
    ...activeThread,
    lastTouchedAt: turn.at,
    resumeHint: buildResumeHint(turn.text)
  });
  return {
    schemaVersion: "v1",
    updatedAt: turn.at,
    activeThreadKey: activeThread.threadKey,
    threads: sortThreads([...threadMap.values()]),
    topics: stack.topics
  };
}

/**
 * Builds conversation stack from turns v1 for this module's runtime flow.
 *
 * @param turns - Historical turns to replay in chronological order.
 * @param updatedAt - Target stack timestamp after replay.
 * @param options - Optional tuning knobs for this operation.
 * @param existingStack - Optional existing stack to refresh instead of rebuilding from empty.
 * @returns Replayed/updated conversation stack snapshot.
 */
export function buildConversationStackFromTurnsV1(
  turns: readonly ConversationStackTurnV1[],
  updatedAt: string,
  options: ApplyConversationTurnOptionsV1 = {},
  existingStack: ConversationStackV1 | null = null
): ConversationStackV1 {
  assertValidIsoTimestamp(updatedAt, "updatedAt");
  const orderedTurns = [...turns]
    .filter((turn) => Number.isFinite(Date.parse(turn.at)))
    .sort((left, right) => {
      if (left.at !== right.at) {
        return left.at.localeCompare(right.at);
      }
      return left.role.localeCompare(right.role);
    });

  let stack = existingStack && isConversationStackV1(existingStack)
    ? {
        ...existingStack,
        threads: sortThreads(existingStack.threads),
        topics: sortTopicNodes(existingStack.topics)
      }
    : createEmptyConversationStackV1(updatedAt);

  for (const turn of orderedTurns) {
    if (turn.role === "user") {
      stack = applyUserTurnToConversationStackV1(stack, turn, options);
      continue;
    }
    stack = applyAssistantTurnToConversationStackV1(stack, turn);
  }

  if (stack.updatedAt < updatedAt) {
    stack = {
      ...stack,
      updatedAt
    };
  }

  return stack;
}

/**
 * Migrates session conversation stack to v2 to the next deterministic lifecycle state.
 *
 * @param input - Session schema/version state plus turns and optional existing stack.
 * @returns Migration result with v2 schema marker and rebuilt/refreshed stack.
 */
export function migrateSessionConversationStackToV2(
  input: ConversationStackMigrationInputV1
): ConversationStackMigrationResultV1 {
  assertValidIsoTimestamp(input.updatedAt, "updatedAt");

  const hasValidStack = input.conversationStack !== null && isConversationStackV1(input.conversationStack);
  const validExistingStack: ConversationStackV1 | null = hasValidStack ? input.conversationStack : null;
  const latestTurnAt = [...input.conversationTurns]
    .map((turn) => turn.at)
    .filter((at) => Number.isFinite(Date.parse(at)))
    .sort((left, right) => right.localeCompare(left))[0] ?? null;

  if (input.sessionSchemaVersion === "v2" && validExistingStack) {
    if (latestTurnAt && latestTurnAt > validExistingStack.updatedAt) {
      return {
        sessionSchemaVersion: "v2",
        conversationStack: buildConversationStackFromTurnsV1(
          input.conversationTurns,
          latestTurnAt,
          {
            activeMissionThreadKey: input.activeMissionThreadKey ?? null,
            maxThreads: input.maxThreads
          },
          validExistingStack
        ),
        migrationApplied: false,
        migrationReason: "REFRESHED_FROM_TURNS"
      };
    }

    return {
      sessionSchemaVersion: "v2",
      conversationStack: validExistingStack,
      migrationApplied: false,
      migrationReason: "ALREADY_V2"
    };
  }

  const migrationUpdatedAt = latestTurnAt && latestTurnAt > input.updatedAt ? latestTurnAt : input.updatedAt;
  const rebuilt = buildConversationStackFromTurnsV1(
    input.conversationTurns,
    migrationUpdatedAt,
    {
      activeMissionThreadKey: input.activeMissionThreadKey ?? null,
      maxThreads: input.maxThreads
    },
    validExistingStack
  );

  return {
    sessionSchemaVersion: "v2",
    conversationStack: rebuilt,
    migrationApplied: true,
    migrationReason:
      input.sessionSchemaVersion === "v1" || input.sessionSchemaVersion === null
        ? "LEGACY_SCHEMA"
        : "MISSING_STACK"
  };
}

/**
 * Evaluates open loop v1 and returns a deterministic policy signal.
 *
 * @param value - Unknown value to validate.
 * @returns `true` when value satisfies OpenLoopV1 structural requirements.
 */
export function isOpenLoopV1(value: unknown): value is OpenLoopV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<OpenLoopV1>;
  return (
    typeof candidate.loopId === "string" &&
    typeof candidate.threadKey === "string" &&
    Array.isArray(candidate.entityRefs) &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.lastMentionedAt === "string" &&
    typeof candidate.priority === "number" &&
    (candidate.status === "open" || candidate.status === "resolved" || candidate.status === "superseded")
  );
}
