/**
 * @fileoverview Shared bounded continuity-scope helpers for thread- and conversation-local recall.
 */

import type { ConversationStackV1, ThreadFrameV1 } from "../types";
import type { ProfileMemoryTemporalRelevanceScope } from "./profileMemoryTemporalQueryContracts";

const MAX_CONTINUITY_SCOPE_THREADS = 3;
const MAX_CONTINUITY_SCOPE_OPEN_LOOPS_PER_THREAD = 3;

/**
 * Orders threads so active-thread and recency scoped recall stay deterministic.
 *
 * @param left - Left thread candidate.
 * @param right - Right thread candidate.
 * @param activeThreadKey - Current active thread key.
 * @returns Stable scoped thread sort order.
 */
function compareContinuityScopedThreadPriority(
  left: ThreadFrameV1,
  right: ThreadFrameV1,
  activeThreadKey: string | null
): number {
  const leftActive = left.threadKey === activeThreadKey ? 1 : 0;
  const rightActive = right.threadKey === activeThreadKey ? 1 : 0;
  if (leftActive !== rightActive) {
    return rightActive - leftActive;
  }
  const leftTouched = Date.parse(left.lastTouchedAt);
  const rightTouched = Date.parse(right.lastTouchedAt);
  if (Number.isFinite(leftTouched) && Number.isFinite(rightTouched) && leftTouched !== rightTouched) {
    return rightTouched - leftTouched;
  }
  return left.threadKey.localeCompare(right.threadKey);
}

/**
 * Selects the bounded thread window that should contribute continuity scope text.
 *
 * @param stack - Current conversation stack.
 * @param relevanceScope - Requested continuity scope.
 * @returns Ordered scoped threads.
 */
export function selectProfileMemoryContinuityScopedThreads(
  stack: ConversationStackV1 | undefined,
  relevanceScope: ProfileMemoryTemporalRelevanceScope
): readonly ThreadFrameV1[] {
  if (!stack || relevanceScope === "global_profile") {
    return [];
  }

  const threads = [...stack.threads].sort((left, right) =>
    compareContinuityScopedThreadPriority(left, right, stack.activeThreadKey)
  );
  if (relevanceScope === "thread_local") {
    return threads.filter((thread) => thread.threadKey === stack.activeThreadKey).slice(0, 1);
  }
  return threads.slice(0, MAX_CONTINUITY_SCOPE_THREADS);
}

/**
 * Collects deterministic topic, resume, and open-loop text for scoped recall queries.
 *
 * @param stack - Current conversation stack.
 * @param relevanceScope - Requested continuity scope.
 * @returns Deduplicated scoped text surfaces.
 */
export function collectProfileMemoryContinuityScopeText(
  stack: ConversationStackV1 | undefined,
  relevanceScope: ProfileMemoryTemporalRelevanceScope
): readonly string[] {
  const scopedThreads = selectProfileMemoryContinuityScopedThreads(stack, relevanceScope);
  if (scopedThreads.length === 0) {
    return [];
  }

  const scopedText: string[] = [];
  for (const thread of scopedThreads) {
    scopedText.push(thread.topicLabel, thread.resumeHint);
    for (const openLoop of thread.openLoops.slice(0, MAX_CONTINUITY_SCOPE_OPEN_LOOPS_PER_THREAD)) {
      scopedText.push(...openLoop.entityRefs);
    }
  }
  return [...new Set(scopedText.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

/**
 * Builds one continuity query string from explicit entity hints plus bounded local scope text.
 *
 * @param entityHints - Explicit entity hints from the caller.
 * @param relevanceScope - Requested continuity scope.
 * @param stack - Current conversation stack used for scope expansion.
 * @returns One bounded continuity query string.
 */
export function buildProfileMemoryContinuityScopeQueryInput(
  entityHints: readonly string[],
  relevanceScope: ProfileMemoryTemporalRelevanceScope,
  stack?: ConversationStackV1
): string {
  return [
    entityHints.join(" ").trim(),
    ...collectProfileMemoryContinuityScopeText(stack, relevanceScope)
  ]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join(" ")
    .trim();
}
