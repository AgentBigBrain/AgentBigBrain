/**
 * @fileoverview Deterministic Stage 6.86 open-loop helpers for checkpoint 6.86.D (creation, resolve, and pulse surfacing).
 */

import {
  ConversationStackV1,
  OpenLoopV1,
  ThreadFrameV1
} from "../types";
import { countLanguageTermOverlap } from "../languageRuntime/languageScoring";
import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";
import { isConversationStackV1 } from "./conversationStack";

const OPEN_LOOP_DEFER_SEQUENCES: readonly (readonly string[])[] = [
  ["remind", "me"],
  ["circle", "back"],
  ["follow", "up"],
  ["not", "now"],
  ["park", "this"],
  ["park", "it"]
] as const;
const OPEN_LOOP_DEFER_TOKENS = new Set(["revisit", "later", "defer"]);
const OPEN_LOOP_DECISION_SEQUENCES: readonly (readonly string[])[] = [
  ["still", "need", "to", "decide"],
  ["need", "to", "choose"],
  ["decision", "pending"],
  ["to", "be", "decided"]
] as const;
const OPEN_LOOP_DECISION_TOKENS = new Set(["undecided", "tbd"]);
const MAX_DESCRIPTOR_CHARS = 180;
const DEFAULT_MAX_OPEN_LOOPS_SURFACED = 1;
const DEFAULT_OPEN_LOOP_STALE_DAYS = 30;
const DEFAULT_FRESH_PRIORITY_THRESHOLD = 0.35;
const DEFAULT_STALE_PRIORITY_THRESHOLD = 0.7;

const THREAD_STATE_SORT_WEIGHT: Record<ThreadFrameV1["state"], number> = {
  active: 0,
  paused: 1,
  resolved: 2
};

const OPEN_LOOP_STATUS_SORT_WEIGHT: Record<OpenLoopV1["status"], number> = {
  open: 0,
  resolved: 1,
  superseded: 2
};

export type OpenLoopTriggerCodeV1 = "DEFERRED_QUESTION" | "UNRESOLVED_DECISION";

export type OpenLoopSuppressionReasonV1 =
  | "FRESH_PRIORITY_TOO_LOW"
  | "STALE_PRIORITY_TOO_LOW"
  | "OPEN_LOOP_CAP_REACHED";

export interface OpenLoopTriggerV1 {
  triggered: boolean;
  triggerCode: OpenLoopTriggerCodeV1 | null;
  descriptor: string | null;
}

export interface UpsertOpenLoopInputV1 {
  stack: ConversationStackV1;
  threadKey: string;
  text: string;
  observedAt: string;
  entityRefs?: readonly string[];
  priorityHint?: number;
}

export interface UpsertOpenLoopResultV1 {
  stack: ConversationStackV1;
  loop: OpenLoopV1 | null;
  triggerCode: OpenLoopTriggerCodeV1 | null;
  created: boolean;
  updated: boolean;
}

export interface ResolveOpenLoopInputV1 {
  stack: ConversationStackV1;
  threadKey: string;
  loopId: string;
  observedAt: string;
  status?: Extract<OpenLoopV1["status"], "resolved" | "superseded">;
}

export interface ResolveOpenLoopResultV1 {
  stack: ConversationStackV1;
  resolved: boolean;
  loop: OpenLoopV1 | null;
}

export interface OpenLoopPulseSelectionOptionsV1 {
  maxOpenLoopsSurfaced?: number;
  openLoopStaleDays?: number;
  freshPriorityThreshold?: number;
  stalePriorityThreshold?: number;
}

export interface OpenLoopPulseCandidateV1 {
  loopId: string;
  threadKey: string;
  threadState: ThreadFrameV1["state"];
  priority: number;
  stale: boolean;
  ageDays: number;
  suppressionReason: OpenLoopSuppressionReasonV1 | null;
}

export interface OpenLoopPulseSelectionResultV1 {
  selected: readonly OpenLoopPulseCandidateV1[];
  suppressed: readonly OpenLoopPulseCandidateV1[];
}

export interface OpenLoopResumeMatchV1 {
  loopId: string;
  threadKey: string;
  threadState: ThreadFrameV1["state"];
  topicLabel: string;
  matchedTerms: readonly string[];
  lookupTerms: readonly string[];
  overlapCount: number;
  priority: number;
  lastTouchedAt: string;
}

/**
 * Builds deterministic lookup terms for one open loop plus its owning thread context.
 *
 * @param loop - Open loop to normalize.
 * @param thread - Owning thread context.
 * @returns Stable lookup terms for continuity linkage.
 */
export function getOpenLoopLookupTermsV1(
  loop: Pick<OpenLoopV1, "entityRefs">,
  thread: Pick<ThreadFrameV1, "topicLabel" | "resumeHint">
): readonly string[] {
  const normalized = new Set<string>();
  for (const value of [
    thread.topicLabel,
    thread.resumeHint,
    ...normalizeEntityRefs(loop.entityRefs)
  ]) {
    for (const term of normalizeWhitespace(value).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      if (term.trim().length >= 3) {
        normalized.add(term.trim());
      }
    }
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

/**
 * Resolves the best open-loop resume match from bounded interpreted hint terms.
 *
 * @param stack - Canonical conversation stack to inspect.
 * @param hintTerms - Normalized lexical hints proposed by deterministic or interpreted context.
 * @returns Best open-loop resume match, or `null` when no bounded overlap exists.
 */
export function findBestOpenLoopResumeMatchV1(
  stack: ConversationStackV1,
  hintTerms: readonly string[]
): OpenLoopResumeMatchV1 | null {
  if (!isConversationStackV1(stack)) {
    throw new Error("Invalid ConversationStackV1 payload.");
  }

  const normalizedHints = [...new Set(
    hintTerms
      .filter((term) => typeof term === "string")
      .flatMap((term) => normalizeWhitespace(term).toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .filter((term) => term.trim().length >= 3)
  )].sort((left, right) => left.localeCompare(right));
  if (normalizedHints.length === 0) {
    return null;
  }

  let best: OpenLoopResumeMatchV1 | null = null;
  let bestScore = -1;

  for (const thread of stack.threads) {
    if (thread.state === "resolved") {
      continue;
    }
    for (const loop of thread.openLoops) {
      if (loop.status !== "open") {
        continue;
      }
      const lookupTerms = getOpenLoopLookupTermsV1(loop, thread);
      const matchedTerms = lookupTerms.filter((term) => normalizedHints.includes(term));
      const overlapCount = countLanguageTermOverlap(normalizedHints, lookupTerms);
      if (overlapCount <= 0 || matchedTerms.length === 0) {
        continue;
      }

      const stateWeight = thread.state === "paused" ? 2 : 1;
      const recencyValue = Number.isFinite(Date.parse(thread.lastTouchedAt))
        ? Date.parse(thread.lastTouchedAt) / 1_000_000_000_000
        : 0;
      const score = (overlapCount * 10) + (loop.priority * 2) + stateWeight + recencyValue;
      const candidate: OpenLoopResumeMatchV1 = {
        loopId: loop.loopId,
        threadKey: thread.threadKey,
        threadState: thread.state,
        topicLabel: thread.topicLabel,
        matchedTerms,
        lookupTerms,
        overlapCount,
        priority: loop.priority,
        lastTouchedAt: thread.lastTouchedAt
      };

      if (score > bestScore) {
        best = candidate;
        bestScore = score;
        continue;
      }
      if (score === bestScore && best) {
        if (candidate.threadState !== best.threadState) {
          best = candidate.threadState === "paused" ? candidate : best;
          continue;
        }
        if (candidate.priority !== best.priority) {
          best = candidate.priority > best.priority ? candidate : best;
          continue;
        }
        if (candidate.lastTouchedAt !== best.lastTouchedAt) {
          best = candidate.lastTouchedAt > best.lastTouchedAt ? candidate : best;
          continue;
        }
        if (candidate.loopId.localeCompare(best.loopId) < 0) {
          best = candidate;
        }
      }
    }
  }

  return best;
}

/**
 * Applies deterministic validity checks for valid iso timestamp.
 *
 * **Why it exists:**
 * Fails fast when valid iso timestamp is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fieldName - Value for field name.
 */
function assertValidIsoTimestamp(value: string, fieldName: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ISO timestamp for ${fieldName}: ${value}`);
  }
}

/**
 * Normalizes whitespace into a stable shape for `stage6_86OpenLoops` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for whitespace so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Tokenizes open loop text.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function tokenizeOpenLoopText(value: string): readonly string[] {
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (!normalized) {
    return [];
  }
  return normalized
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Evaluates whether token sequence.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @param sequence - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function hasTokenSequence(
  tokens: readonly string[],
  sequence: readonly string[]
): boolean {
  if (sequence.length === 0 || sequence.length > tokens.length) {
    return false;
  }
  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (tokens[index + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates whether any token sequence.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @param sequences - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function hasAnyTokenSequence(
  tokens: readonly string[],
  sequences: readonly (readonly string[])[]
): boolean {
  return sequences.some((sequence) => hasTokenSequence(tokens, sequence));
}

/**
 * Evaluates whether any token.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @param allowed - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function hasAnyToken(tokens: readonly string[], allowed: ReadonlySet<string>): boolean {
  return tokens.some((token) => allowed.has(token));
}

/**
 * Normalizes entity refs into a stable shape for `stage6_86OpenLoops` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for entity refs so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param entityRefs - Value for entity refs.
 * @returns Ordered collection produced by this step.
 */
function normalizeEntityRefs(entityRefs: readonly string[] | undefined): readonly string[] {
  if (!entityRefs) {
    return [];
  }
  const normalized = new Set<string>();
  for (const ref of entityRefs) {
    if (typeof ref !== "string") {
      continue;
    }
    const value = normalizeWhitespace(ref);
    if (!value) {
      continue;
    }
    normalized.add(value);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

/**
 * Constrains and sanitizes priority to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for priority before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed numeric value.
 */
function clampPriority(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Number(Math.min(1, Math.max(0, value)).toFixed(4));
}

/**
 * Constrains and sanitizes threshold to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for threshold before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
function clampThreshold(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return fallback;
  }
  return clampPriority(value as number);
}

/**
 * Converts values into descriptor form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for descriptor deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @returns Resulting string value.
 */
function toDescriptor(text: string): string {
  const normalized = normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= MAX_DESCRIPTOR_CHARS) {
    return normalized;
  }
  return normalized.slice(0, MAX_DESCRIPTOR_CHARS);
}

/**
 * Derives trigger code from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for trigger code in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @returns Computed `OpenLoopTriggerCodeV1 | null` result.
 */
function deriveTriggerCode(text: string): OpenLoopTriggerCodeV1 | null {
  const tokens = tokenizeOpenLoopText(text);
  if (hasAnyTokenSequence(tokens, OPEN_LOOP_DEFER_SEQUENCES) || hasAnyToken(tokens, OPEN_LOOP_DEFER_TOKENS)) {
    return "DEFERRED_QUESTION";
  }
  if (
    hasAnyTokenSequence(tokens, OPEN_LOOP_DECISION_SEQUENCES) ||
    hasAnyToken(tokens, OPEN_LOOP_DECISION_TOKENS)
  ) {
    return "UNRESOLVED_DECISION";
  }
  return null;
}

/**
 * Derives base priority from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for base priority in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param triggerCode - Value for trigger code.
 * @returns Computed numeric value.
 */
function deriveBasePriority(triggerCode: OpenLoopTriggerCodeV1): number {
  if (triggerCode === "DEFERRED_QUESTION") {
    return 0.78;
  }
  return 0.66;
}

/**
 * Builds open loop id v1 for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of open loop id v1 consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `./normalizers/canonicalizationRules`.
 *
 * @param threadKey - Lookup key or map field identifier.
 * @param descriptor - Value for descriptor.
 * @returns Resulting string value.
 */
export function buildOpenLoopIdV1(threadKey: string, descriptor: string): string {
  const fingerprint = sha256HexFromCanonicalJson({
    threadKey,
    descriptor
  });
  return `loop_${fingerprint.slice(0, 20)}`;
}

/**
 * Normalizes ordering and duplication for open loops.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for open loops in one place.
 *
 * **What it talks to:**
 * - Uses `OpenLoopV1` (import `OpenLoopV1`) from `./types`.
 *
 * @param openLoops - Value for open loops.
 * @returns Ordered collection produced by this step.
 */
function sortOpenLoops(openLoops: readonly OpenLoopV1[]): readonly OpenLoopV1[] {
  return [...openLoops].sort((left, right) => {
    const statusOrder = OPEN_LOOP_STATUS_SORT_WEIGHT[left.status] - OPEN_LOOP_STATUS_SORT_WEIGHT[right.status];
    if (statusOrder !== 0) {
      return statusOrder;
    }
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    if (left.lastMentionedAt !== right.lastMentionedAt) {
      return right.lastMentionedAt.localeCompare(left.lastMentionedAt);
    }
    return left.loopId.localeCompare(right.loopId);
  });
}

/**
 * Normalizes ordering and duplication for threads.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for threads in one place.
 *
 * **What it talks to:**
 * - Uses `ThreadFrameV1` (import `ThreadFrameV1`) from `./types`.
 *
 * @param threads - Value for threads.
 * @returns Ordered collection produced by this step.
 */
function sortThreads(threads: readonly ThreadFrameV1[]): readonly ThreadFrameV1[] {
  return [...threads].sort((left, right) => {
    const stateOrder = THREAD_STATE_SORT_WEIGHT[left.state] - THREAD_STATE_SORT_WEIGHT[right.state];
    if (stateOrder !== 0) {
      return stateOrder;
    }
    if (left.lastTouchedAt !== right.lastTouchedAt) {
      return right.lastTouchedAt.localeCompare(left.lastTouchedAt);
    }
    return left.threadKey.localeCompare(right.threadKey);
  });
}

/**
 * Evaluates open loop trigger v1 and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the open loop trigger v1 policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @returns Computed `OpenLoopTriggerV1` result.
 */
export function detectOpenLoopTriggerV1(text: string): OpenLoopTriggerV1 {
  const normalizedText = normalizeWhitespace(text);
  if (!normalizedText) {
    return {
      triggered: false,
      triggerCode: null,
      descriptor: null
    };
  }

  const triggerCode = deriveTriggerCode(normalizedText);
  if (!triggerCode) {
    return {
      triggered: false,
      triggerCode: null,
      descriptor: null
    };
  }

  return {
    triggered: true,
    triggerCode,
    descriptor: toDescriptor(normalizedText)
  };
}

/**
 * Persists open loop on conversation stack v1 with deterministic state semantics.
 *
 * **Why it exists:**
 * Centralizes open loop on conversation stack v1 mutations for auditability and replay.
 *
 * **What it talks to:**
 * - Uses `isConversationStackV1` (import `isConversationStackV1`) from `./stage6_86ConversationStack`.
 * - Uses `OpenLoopV1` (import `OpenLoopV1`) from `./types`.
 * - Uses `ThreadFrameV1` (import `ThreadFrameV1`) from `./types`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `UpsertOpenLoopResultV1` result.
 */
export function upsertOpenLoopOnConversationStackV1(
  input: UpsertOpenLoopInputV1
): UpsertOpenLoopResultV1 {
  if (!isConversationStackV1(input.stack)) {
    throw new Error("Invalid ConversationStackV1 payload.");
  }
  assertValidIsoTimestamp(input.observedAt, "observedAt");
  const trigger = detectOpenLoopTriggerV1(input.text);
  if (!trigger.triggered || !trigger.triggerCode || !trigger.descriptor) {
    return {
      stack: input.stack,
      loop: null,
      triggerCode: null,
      created: false,
      updated: false
    };
  }

  const threadIndex = input.stack.threads.findIndex((thread) => thread.threadKey === input.threadKey);
  if (threadIndex < 0) {
    return {
      stack: input.stack,
      loop: null,
      triggerCode: trigger.triggerCode,
      created: false,
      updated: false
    };
  }

  const thread = input.stack.threads[threadIndex];
  const loopId = buildOpenLoopIdV1(thread.threadKey, trigger.descriptor);
  const targetPriority = clampPriority(
    input.priorityHint ?? deriveBasePriority(trigger.triggerCode)
  );
  const normalizedEntityRefs = normalizeEntityRefs(input.entityRefs);
  const loopIndex = thread.openLoops.findIndex((loop) => loop.loopId === loopId);

  let nextLoop: OpenLoopV1;
  let created = false;
  let updated = false;

  if (loopIndex >= 0) {
    const existing = thread.openLoops[loopIndex];
    const mergedRefs = normalizeEntityRefs([...existing.entityRefs, ...normalizedEntityRefs]);
    nextLoop = {
      ...existing,
      status: "open",
      lastMentionedAt: input.observedAt,
      priority: clampPriority(Math.max(existing.priority, targetPriority)),
      entityRefs: mergedRefs
    };
    updated = true;
  } else {
    nextLoop = {
      loopId,
      threadKey: thread.threadKey,
      entityRefs: normalizedEntityRefs,
      createdAt: input.observedAt,
      lastMentionedAt: input.observedAt,
      priority: targetPriority,
      status: "open"
    };
    created = true;
  }

  const nextOpenLoops = sortOpenLoops(
    loopIndex >= 0
      ? thread.openLoops.map((loop) => (loop.loopId === loopId ? nextLoop : loop))
      : [...thread.openLoops, nextLoop]
  );

  const nextThread: ThreadFrameV1 = {
    ...thread,
    openLoops: nextOpenLoops,
    lastTouchedAt: input.observedAt
  };

  const nextThreads = sortThreads(
    input.stack.threads.map((entry, index) => (index === threadIndex ? nextThread : entry))
  );

  return {
    stack: {
      schemaVersion: "v1",
      updatedAt: input.observedAt,
      activeThreadKey: input.stack.activeThreadKey,
      threads: nextThreads,
      topics: input.stack.topics
    },
    loop: nextLoop,
    triggerCode: trigger.triggerCode,
    created,
    updated
  };
}

/**
 * Resolves open loop on conversation stack v1 from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of open loop on conversation stack v1 by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `isConversationStackV1` (import `isConversationStackV1`) from `./stage6_86ConversationStack`.
 * - Uses `OpenLoopV1` (import `OpenLoopV1`) from `./types`.
 * - Uses `ThreadFrameV1` (import `ThreadFrameV1`) from `./types`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `ResolveOpenLoopResultV1` result.
 */
export function resolveOpenLoopOnConversationStackV1(
  input: ResolveOpenLoopInputV1
): ResolveOpenLoopResultV1 {
  if (!isConversationStackV1(input.stack)) {
    throw new Error("Invalid ConversationStackV1 payload.");
  }
  assertValidIsoTimestamp(input.observedAt, "observedAt");

  const threadIndex = input.stack.threads.findIndex((thread) => thread.threadKey === input.threadKey);
  if (threadIndex < 0) {
    return {
      stack: input.stack,
      resolved: false,
      loop: null
    };
  }

  const thread = input.stack.threads[threadIndex];
  const loopIndex = thread.openLoops.findIndex((loop) => loop.loopId === input.loopId);
  if (loopIndex < 0) {
    return {
      stack: input.stack,
      resolved: false,
      loop: null
    };
  }

  const existingLoop = thread.openLoops[loopIndex];
  const nextLoop: OpenLoopV1 = {
    ...existingLoop,
    status: input.status ?? "resolved",
    lastMentionedAt: input.observedAt
  };
  const nextOpenLoops = sortOpenLoops(
    thread.openLoops.map((loop, index) => (index === loopIndex ? nextLoop : loop))
  );
  const nextThread: ThreadFrameV1 = {
    ...thread,
    openLoops: nextOpenLoops,
    lastTouchedAt: input.observedAt
  };
  const nextThreads = sortThreads(
    input.stack.threads.map((entry, index) => (index === threadIndex ? nextThread : entry))
  );

  return {
    stack: {
      schemaVersion: "v1",
      updatedAt: input.observedAt,
      activeThreadKey: input.stack.activeThreadKey,
      threads: nextThreads,
      topics: input.stack.topics
    },
    resolved: true,
    loop: nextLoop
  };
}

/**
 * Resolves open loops for pulse v1 from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of open loops for pulse v1 by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `isConversationStackV1` (import `isConversationStackV1`) from `./stage6_86ConversationStack`.
 * - Uses `ConversationStackV1` (import `ConversationStackV1`) from `./types`.
 *
 * @param stack - Value for stack.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param options - Optional tuning knobs for this operation.
 * @returns Computed `OpenLoopPulseSelectionResultV1` result.
 */
export function selectOpenLoopsForPulseV1(
  stack: ConversationStackV1,
  observedAt: string,
  options: OpenLoopPulseSelectionOptionsV1 = {}
): OpenLoopPulseSelectionResultV1 {
  if (!isConversationStackV1(stack)) {
    throw new Error("Invalid ConversationStackV1 payload.");
  }
  assertValidIsoTimestamp(observedAt, "observedAt");

  const maxOpenLoopsSurfaced = Math.max(
    1,
    Math.floor(options.maxOpenLoopsSurfaced ?? DEFAULT_MAX_OPEN_LOOPS_SURFACED)
  );
  const staleDays = Math.max(
    1,
    Math.floor(options.openLoopStaleDays ?? DEFAULT_OPEN_LOOP_STALE_DAYS)
  );
  const freshThreshold = clampThreshold(
    options.freshPriorityThreshold,
    DEFAULT_FRESH_PRIORITY_THRESHOLD
  );
  const staleThreshold = clampThreshold(
    options.stalePriorityThreshold,
    DEFAULT_STALE_PRIORITY_THRESHOLD
  );

  const observedAtMs = Date.parse(observedAt);
  const eligible: OpenLoopPulseCandidateV1[] = [];
  const suppressed: OpenLoopPulseCandidateV1[] = [];

  for (const thread of stack.threads) {
    for (const loop of thread.openLoops) {
      if (loop.status !== "open") {
        continue;
      }
      const ageDays = Math.max(
        0,
        (observedAtMs - Date.parse(loop.lastMentionedAt)) / (24 * 60 * 60 * 1_000)
      );
      const stale = ageDays >= staleDays;
      const requiredPriority = stale ? staleThreshold : freshThreshold;
      if (loop.priority < requiredPriority) {
        suppressed.push({
          loopId: loop.loopId,
          threadKey: thread.threadKey,
          threadState: thread.state,
          priority: loop.priority,
          stale,
          ageDays: Number(ageDays.toFixed(4)),
          suppressionReason: stale ? "STALE_PRIORITY_TOO_LOW" : "FRESH_PRIORITY_TOO_LOW"
        });
        continue;
      }
      eligible.push({
        loopId: loop.loopId,
        threadKey: thread.threadKey,
        threadState: thread.state,
        priority: loop.priority,
        stale,
        ageDays: Number(ageDays.toFixed(4)),
        suppressionReason: null
      });
    }
  }

  const ordered = [...eligible].sort((left, right) => {
    const threadWeight = THREAD_STATE_SORT_WEIGHT[left.threadState] - THREAD_STATE_SORT_WEIGHT[right.threadState];
    if (threadWeight !== 0) {
      return threadWeight;
    }
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    if (left.ageDays !== right.ageDays) {
      return left.ageDays - right.ageDays;
    }
    return left.loopId.localeCompare(right.loopId);
  });

  const selected = ordered.slice(0, maxOpenLoopsSurfaced);
  const capped = ordered.slice(maxOpenLoopsSurfaced).map((candidate) => ({
    ...candidate,
    suppressionReason: "OPEN_LOOP_CAP_REACHED" as const
  }));

  return {
    selected,
    suppressed: [...suppressed, ...capped].sort((left, right) => left.loopId.localeCompare(right.loopId))
  };
}
