/**
 * @fileoverview Deterministic Stage 6.86 memory-governance helpers for mutation receipts, typed conflicts, and rollback parity in checkpoint 6.86.G.
 */

import {
  ConversationStackV1,
  EntityGraphV1,
  MemoryConflictCodeV1,
  MemoryMutationActionParams,
  MemoryMutationOperationV1,
  MemoryMutationReceiptV1,
  MemoryMutationStoreV1,
  Stage686BlockCodeV1,
  Stage686ConflictObjectV1
} from "./types";
import { sha256HexFromCanonicalJson } from "./normalizers/canonicalizationRules";

export interface Stage686PulseStateV1 {
  schemaVersion: "v1";
  updatedAt: string;
  lastPulseAt: string | null;
  emittedTodayCount: number;
  bridgeHistory: readonly {
    questionId: string;
    sourceEntityKey: string;
    targetEntityKey: string;
    askedAt: string;
    status: "asked" | "confirmed" | "deferred";
    cooldownUntil: string;
    deferralCount: number;
    conversationKey: string;
  }[];
}

export interface Stage686MemoryStoresV1 {
  entityGraph: EntityGraphV1;
  conversationStack: ConversationStackV1;
  pulseState: Stage686PulseStateV1;
}

export interface Stage686CanonicalDiffV1 {
  store: MemoryMutationStoreV1;
  operation: MemoryMutationOperationV1;
  mutationPath: readonly string[];
  beforeFingerprint: string;
  afterFingerprint: string;
}

export interface Stage686TraceLinkV1 {
  traceId: string;
  observedAt: string;
  evidenceRefs: readonly string[];
}

export interface ApplyMemoryMutationInputV1 {
  stores: Stage686MemoryStoresV1;
  params: MemoryMutationActionParams;
  observedAt: string;
  scopeId: string;
  taskId: string;
  proposalId: string;
  actionId: string;
  missionId?: string;
  missionAttemptId?: string;
  priorReceiptHash: string | null;
}

export interface ApplyMemoryMutationResultV1 {
  stores: Stage686MemoryStoresV1;
  receipt: MemoryMutationReceiptV1 | null;
  conflict: Stage686ConflictObjectV1 | null;
  blockCode: Extract<Stage686BlockCodeV1, "MEMORY_MUTATION_BLOCKED"> | null;
  blockDetailReason: MemoryConflictCodeV1 | null;
  canonicalDiff: Stage686CanonicalDiffV1 | null;
  traceLink: Stage686TraceLinkV1 | null;
}

export interface RunMemoryRollbackDrillInputV1 {
  currentStores: Stage686MemoryStoresV1;
  lastKnownGoodStores: Stage686MemoryStoresV1;
  observedAt: string;
  scopeId: string;
  taskId: string;
  proposalId: string;
  actionId: string;
  priorReceiptHash: string | null;
  evidenceRefs?: readonly string[];
}

export interface RunMemoryRollbackDrillResultV1 {
  restoredStores: Stage686MemoryStoresV1;
  rollbackReceipt: MemoryMutationReceiptV1;
  traceLink: Stage686TraceLinkV1;
}

interface ConversationStackPathResolutionV1 {
  resolvedPath: readonly string[];
  conflict: MemoryConflictCodeV1 | null;
}

const VOLATILE_MUTATION_PAYLOAD_KEYS = new Set([
  "traceId",
  "nonce",
  "runtimeTimestamp",
  "runtimeTraceId",
  "randomId"
]);

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
 * Normalizes whitespace into a stable shape for `stage6_86MemoryGovernance` logic.
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
 * Evaluates plain object record and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the plain object record policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is Record<string, unknown>` result.
 */
function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Implements deep clone behavior used by `stage6_86MemoryGovernance`.
 *
 * **Why it exists:**
 * Keeps `deep clone` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `T` result.
 */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Normalizes string array into a stable shape for `stage6_86MemoryGovernance` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for string array so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param values - Value for values.
 * @returns Ordered collection produced by this step.
 */
function normalizeStringArray(values: readonly string[] | undefined): readonly string[] {
  if (!values) {
    return [];
  }
  const normalized = new Set<string>();
  for (const value of values) {
    const cleaned = normalizeWhitespace(value);
    if (!cleaned) {
      continue;
    }
    normalized.add(cleaned);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

/**
 * Normalizes mutation path into a stable shape for `stage6_86MemoryGovernance` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for mutation path so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param path - Filesystem location used by this operation.
 * @returns Ordered collection produced by this step.
 */
function normalizeMutationPath(path: readonly string[] | undefined): readonly string[] {
  if (!path) {
    return [];
  }
  const normalized: string[] = [];
  for (const segment of path) {
    const cleaned = normalizeWhitespace(segment);
    if (!cleaned) {
      continue;
    }
    normalized.push(cleaned);
  }
  return normalized;
}

/**
 * Normalizes mutation payload into a stable shape for `stage6_86MemoryGovernance` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for mutation payload so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param payload - Structured input object for this operation.
 * @returns Computed `Record<string, unknown>` result.
 */
function normalizeMutationPayload(payload: unknown): Record<string, unknown> {
  if (!isPlainObjectRecord(payload)) {
    return {};
  }
  const filtered = Object.entries(payload)
    .filter(([key]) => !VOLATILE_MUTATION_PAYLOAD_KEYS.has(key))
    .sort(([left], [right]) => left.localeCompare(right));
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of filtered) {
    normalized[key] = value;
  }
  return normalized;
}

/**
 * Converts values into store property key form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for store property key deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses `MemoryMutationStoreV1` (import `MemoryMutationStoreV1`) from `./types`.
 *
 * @param store - Value for store.
 * @returns Computed `keyof Stage686MemoryStoresV1` result.
 */
function toStorePropertyKey(store: MemoryMutationStoreV1): keyof Stage686MemoryStoresV1 {
  if (store === "entity_graph") {
    return "entityGraph";
  }
  if (store === "conversation_stack") {
    return "conversationStack";
  }
  return "pulseState";
}

/**
 * Builds trace id for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of trace id consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `./normalizers/canonicalizationRules`.
 * - Uses `MemoryMutationOperationV1` (import `MemoryMutationOperationV1`) from `./types`.
 * - Uses `MemoryMutationStoreV1` (import `MemoryMutationStoreV1`) from `./types`.
 *
 * @param actionId - Stable identifier used to reference an entity or record.
 * @param store - Value for store.
 * @param operation - Value for operation.
 * @returns Resulting string value.
 */
function buildTraceId(actionId: string, store: MemoryMutationStoreV1, operation: MemoryMutationOperationV1): string {
  const fingerprint = sha256HexFromCanonicalJson({
    actionId,
    store,
    operation
  });
  return `trace_stage686_mem_${fingerprint.slice(0, 20)}`;
}

/**
 * Builds mutation id for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of mutation id consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `./normalizers/canonicalizationRules`.
 *
 * @param scopeId - Stable identifier used to reference an entity or record.
 * @param actionId - Stable identifier used to reference an entity or record.
 * @param canonicalMutationPayload - Boolean gate controlling this branch.
 * @returns Resulting string value.
 */
function buildMutationId(
  scopeId: string,
  actionId: string,
  canonicalMutationPayload: Record<string, unknown>
): string {
  const payloadHash = sha256HexFromCanonicalJson(canonicalMutationPayload);
  const fingerprint = sha256HexFromCanonicalJson({
    scopeId,
    actionId,
    payloadHash
  });
  return `mutation_${fingerprint.slice(0, 24)}`;
}

/**
 * Builds conflict for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of conflict consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `MemoryConflictCodeV1` (import `MemoryConflictCodeV1`) from `./types`.
 * - Uses `Stage686ConflictObjectV1` (import `Stage686ConflictObjectV1`) from `./types`.
 *
 * @param conflictCode - Value for conflict code.
 * @param detail - Value for detail.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param evidenceRefs - Stable identifier used to reference an entity or record.
 * @returns Computed `Stage686ConflictObjectV1` result.
 */
function buildConflict(
  conflictCode: MemoryConflictCodeV1,
  detail: string,
  observedAt: string,
  evidenceRefs: readonly string[]
): Stage686ConflictObjectV1 {
  return {
    conflictCode,
    detail,
    observedAt,
    evidenceRefs
  };
}

/**
 * Builds blocked mutation result for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of blocked mutation result consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `MemoryConflictCodeV1` (import `MemoryConflictCodeV1`) from `./types`.
 *
 * @param stores - Value for stores.
 * @param conflictCode - Value for conflict code.
 * @param detail - Value for detail.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param evidenceRefs - Stable identifier used to reference an entity or record.
 * @returns Computed `ApplyMemoryMutationResultV1` result.
 */
function buildBlockedMutationResult(
  stores: Stage686MemoryStoresV1,
  conflictCode: MemoryConflictCodeV1,
  detail: string,
  observedAt: string,
  evidenceRefs: readonly string[]
): ApplyMemoryMutationResultV1 {
  return {
    stores,
    receipt: null,
    conflict: buildConflict(conflictCode, detail, observedAt, evidenceRefs),
    blockCode: "MEMORY_MUTATION_BLOCKED",
    blockDetailReason: conflictCode,
    canonicalDiff: null,
    traceLink: {
      traceId: buildTraceId("blocked", "entity_graph", "upsert"),
      observedAt,
      evidenceRefs
    }
  };
}

/**
 * Reads path value needed for this execution step.
 *
 * **Why it exists:**
 * Separates path value read-path handling from orchestration and mutation code.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param root - Value for root.
 * @param path - Filesystem location used by this operation.
 * @returns Computed `unknown` result.
 */
function readPathValue(root: unknown, path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        return undefined;
      }
      cursor = cursor[index];
      continue;
    }
    if (!isPlainObjectRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

/**
 * Persists path value with deterministic state semantics.
 *
 * **Why it exists:**
 * Centralizes path value mutations for auditability and replay.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param root - Value for root.
 * @param path - Filesystem location used by this operation.
 * @param value - Primary value processed by this function.
 * @returns `true` when this check passes.
 */
function setPathValue(root: unknown, path: readonly string[], value: unknown): boolean {
  if (path.length === 0) {
    return false;
  }
  let cursor: unknown = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (Array.isArray(cursor)) {
      const arrayIndex = Number(segment);
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= cursor.length) {
        return false;
      }
      cursor = cursor[arrayIndex];
      continue;
    }
    if (!isPlainObjectRecord(cursor) || !(segment in cursor)) {
      return false;
    }
    cursor = cursor[segment];
  }

  const terminal = path[path.length - 1];
  if (Array.isArray(cursor)) {
    const terminalIndex = Number(terminal);
    if (!Number.isInteger(terminalIndex) || terminalIndex < 0 || terminalIndex >= cursor.length) {
      return false;
    }
    cursor[terminalIndex] = value;
    return true;
  }
  if (!isPlainObjectRecord(cursor)) {
    return false;
  }
  cursor[terminal] = value;
  return true;
}

/**
 * Removes path value according to deterministic lifecycle rules.
 *
 * **Why it exists:**
 * Ensures path value removal follows deterministic lifecycle and retention rules.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param root - Value for root.
 * @param path - Filesystem location used by this operation.
 * @returns `true` when this check passes.
 */
function deletePathValue(root: unknown, path: readonly string[]): boolean {
  if (path.length === 0) {
    return false;
  }
  let cursor: unknown = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (Array.isArray(cursor)) {
      const arrayIndex = Number(segment);
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= cursor.length) {
        return false;
      }
      cursor = cursor[arrayIndex];
      continue;
    }
    if (!isPlainObjectRecord(cursor) || !(segment in cursor)) {
      return false;
    }
    cursor = cursor[segment];
  }

  const terminal = path[path.length - 1];
  if (Array.isArray(cursor)) {
    const terminalIndex = Number(terminal);
    if (!Number.isInteger(terminalIndex) || terminalIndex < 0 || terminalIndex >= cursor.length) {
      return false;
    }
    cursor.splice(terminalIndex, 1);
    return true;
  }
  if (!isPlainObjectRecord(cursor) || !(terminal in cursor)) {
    return false;
  }
  delete cursor[terminal];
  return true;
}

/**
 * Executes operation at path as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the operation at path runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `MemoryConflictCodeV1` (import `MemoryConflictCodeV1`) from `./types`.
 * - Uses `MemoryMutationOperationV1` (import `MemoryMutationOperationV1`) from `./types`.
 *
 * @param root - Value for root.
 * @param operation - Value for operation.
 * @param path - Filesystem location used by this operation.
 * @param payload - Structured input object for this operation.
 * @returns Computed `MemoryConflictCodeV1 | null` result.
 */
function applyOperationAtPath(
  root: unknown,
  operation: MemoryMutationOperationV1,
  path: readonly string[],
  payload: Record<string, unknown>
): MemoryConflictCodeV1 | null {
  if (path.length === 0) {
    return "CANONICALIZATION_CONFLICT";
  }

  if (operation === "upsert") {
    return setPathValue(root, path, payload) ? null : "CANONICALIZATION_CONFLICT";
  }

  if (operation === "merge") {
    const existingValue = readPathValue(root, path);
    if (!isPlainObjectRecord(existingValue)) {
      return "MERGE_AMBIGUITY";
    }
    const merged = { ...existingValue, ...payload };
    return setPathValue(root, path, merged) ? null : "CANONICALIZATION_CONFLICT";
  }

  if (operation === "resolve" || operation === "supersede") {
    const existingValue = readPathValue(root, path);
    if (isPlainObjectRecord(existingValue)) {
      const status = operation === "resolve" ? "resolved" : "superseded";
      const merged = { ...existingValue, status };
      return setPathValue(root, path, merged) ? null : "CANONICALIZATION_CONFLICT";
    }
    return setPathValue(root, path, payload) ? null : "CANONICALIZATION_CONFLICT";
  }

  if (operation === "evict") {
    return deletePathValue(root, path) ? null : "CANONICALIZATION_CONFLICT";
  }

  return "CANONICALIZATION_CONFLICT";
}

/**
 * Evaluates entity alias collision and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the entity alias collision policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `MemoryConflictCodeV1` (import `MemoryConflictCodeV1`) from `./types`.
 *
 * @param stores - Value for stores.
 * @param payload - Structured input object for this operation.
 * @returns Computed `MemoryConflictCodeV1 | null` result.
 */
function detectEntityAliasCollision(
  stores: Stage686MemoryStoresV1,
  payload: Record<string, unknown>
): MemoryConflictCodeV1 | null {
  if (!payload.entityKey || typeof payload.entityKey !== "string") {
    return null;
  }
  const incomingEntityKey = normalizeWhitespace(payload.entityKey);
  const aliases = Array.isArray(payload.aliases)
    ? payload.aliases.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (aliases.length === 0) {
    return null;
  }
  const aliasIndex = new Map<string, string>();
  for (const entity of stores.entityGraph.entities) {
    const labels = [entity.canonicalName, ...entity.aliases].map((label) => normalizeWhitespace(label).toLowerCase());
    for (const label of labels) {
      if (!label) {
        continue;
      }
      aliasIndex.set(label, entity.entityKey);
    }
  }
  for (const alias of aliases) {
    const normalizedAlias = normalizeWhitespace(alias).toLowerCase();
    if (!normalizedAlias) {
      continue;
    }
    const owner = aliasIndex.get(normalizedAlias);
    if (owner && owner !== incomingEntityKey) {
      return "ALIAS_COLLISION";
    }
  }
  return null;
}

/**
 * Applies deterministic validity checks for conversation stack mutation.
 *
 * **Why it exists:**
 * Fails fast when conversation stack mutation is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses `MemoryConflictCodeV1` (import `MemoryConflictCodeV1`) from `./types`.
 *
 * @param stores - Value for stores.
 * @param mutationPath - Filesystem location used by this operation.
 * @returns Computed `MemoryConflictCodeV1 | null` result.
 */
function validateConversationStackMutation(
  stores: Stage686MemoryStoresV1,
  mutationPath: readonly string[]
): MemoryConflictCodeV1 | null {
  if (stores.conversationStack.schemaVersion !== "v1") {
    return "SESSION_SCHEMA_MISMATCH";
  }
  if (mutationPath.length >= 2 && mutationPath[0] === "threads") {
    const threadKey = mutationPath[1];
    const threadExists = stores.conversationStack.threads.some((thread) => thread.threadKey === threadKey);
    if (!threadExists) {
      return "STALE_THREAD_FRAME";
    }
  }
  return null;
}

/**
 * Evaluates integer path segment and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the integer path segment policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param segment - Value for segment.
 * @returns `true` when this check passes.
 */
function isIntegerPathSegment(segment: string): boolean {
  return /^\d+$/.test(segment);
}

/**
 * Resolves conversation stack mutation path from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of conversation stack mutation path by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param stores - Value for stores.
 * @param mutationPath - Filesystem location used by this operation.
 * @returns Computed `ConversationStackPathResolutionV1` result.
 */
function resolveConversationStackMutationPath(
  stores: Stage686MemoryStoresV1,
  mutationPath: readonly string[]
): ConversationStackPathResolutionV1 {
  const validationConflict = validateConversationStackMutation(stores, mutationPath);
  if (validationConflict) {
    return {
      resolvedPath: mutationPath,
      conflict: validationConflict
    };
  }
  if (mutationPath.length < 2 || mutationPath[0] !== "threads") {
    return {
      resolvedPath: mutationPath,
      conflict: null
    };
  }

  const threadSegment = mutationPath[1];
  if (isIntegerPathSegment(threadSegment)) {
    const index = Number(threadSegment);
    if (!Number.isInteger(index) || index < 0 || index >= stores.conversationStack.threads.length) {
      return {
        resolvedPath: mutationPath,
        conflict: "STALE_THREAD_FRAME"
      };
    }
    return {
      resolvedPath: mutationPath,
      conflict: null
    };
  }

  const threadIndex = stores.conversationStack.threads.findIndex((thread) => thread.threadKey === threadSegment);
  if (threadIndex < 0) {
    return {
      resolvedPath: mutationPath,
      conflict: "STALE_THREAD_FRAME"
    };
  }
  return {
    resolvedPath: ["threads", String(threadIndex), ...mutationPath.slice(2)],
    conflict: null
  };
}

/**
 * Executes memory mutation v1 as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the memory mutation v1 runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `./normalizers/canonicalizationRules`.
 * - Uses `MemoryMutationOperationV1` (import `MemoryMutationOperationV1`) from `./types`.
 * - Uses `MemoryMutationReceiptV1` (import `MemoryMutationReceiptV1`) from `./types`.
 * - Uses `MemoryMutationStoreV1` (import `MemoryMutationStoreV1`) from `./types`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `ApplyMemoryMutationResultV1` result.
 */
export function applyMemoryMutationV1(input: ApplyMemoryMutationInputV1): ApplyMemoryMutationResultV1 {
  assertValidIsoTimestamp(input.observedAt, "observedAt");
  const store = (input.params.store ?? "entity_graph") as MemoryMutationStoreV1;
  const operation = (input.params.operation ?? "upsert") as MemoryMutationOperationV1;
  const mutationPath = normalizeMutationPath(input.params.mutationPath);
  const canonicalPayload = normalizeMutationPayload(input.params.payload);
  const evidenceRefs = normalizeStringArray(input.params.evidenceRefs);
  const traceId = buildTraceId(input.actionId, store, operation);
  const traceLink: Stage686TraceLinkV1 = {
    traceId,
    observedAt: input.observedAt,
    evidenceRefs
  };

  const storeKey = toStorePropertyKey(store);
  const beforeStores = deepClone(input.stores);
  const beforeStoreValue = beforeStores[storeKey];
  const beforeFingerprint = sha256HexFromCanonicalJson(beforeStoreValue);
  let resolvedMutationPath = mutationPath;

  const aliasConflict =
    store === "entity_graph" && (operation === "upsert" || operation === "merge")
      ? detectEntityAliasCollision(beforeStores, canonicalPayload)
      : null;
  if (aliasConflict) {
    return {
      ...buildBlockedMutationResult(
        beforeStores,
        aliasConflict,
        "Alias collision detected during entity mutation.",
        input.observedAt,
        evidenceRefs
      ),
      traceLink
    };
  }

  if (store === "conversation_stack") {
    const pathResolution = resolveConversationStackMutationPath(beforeStores, mutationPath);
    if (pathResolution.conflict) {
      return {
        ...buildBlockedMutationResult(
          beforeStores,
          pathResolution.conflict,
          "Conversation stack mutation validation failed.",
          input.observedAt,
          evidenceRefs
        ),
        traceLink
      };
    }
    resolvedMutationPath = pathResolution.resolvedPath;
  }

  const nextStores = deepClone(beforeStores);
  const targetStore = nextStores[storeKey];
  const operationConflict = applyOperationAtPath(
    targetStore,
    operation,
    resolvedMutationPath,
    canonicalPayload
  );
  if (operationConflict) {
    return {
      ...buildBlockedMutationResult(
        beforeStores,
        operationConflict,
        "Memory mutation operation could not be applied at the requested path.",
        input.observedAt,
        evidenceRefs
      ),
      traceLink
    };
  }

  if (isPlainObjectRecord(targetStore)) {
    targetStore.updatedAt = input.observedAt;
  }
  const afterStoreValue = nextStores[storeKey];
  const afterFingerprint = sha256HexFromCanonicalJson(afterStoreValue);
  const canonicalMutationPayload = {
    store,
    operation,
    mutationPath: resolvedMutationPath,
    payload: canonicalPayload
  };
  const mutationId = buildMutationId(input.scopeId, input.actionId, canonicalMutationPayload);
  const receipt: MemoryMutationReceiptV1 = {
    mutationId,
    scopeId: input.scopeId,
    taskId: input.taskId,
    proposalId: input.proposalId,
    actionId: input.actionId,
    missionId: input.missionId,
    missionAttemptId: input.missionAttemptId,
    canonicalMutationPayload,
    store,
    operation,
    beforeFingerprint,
    afterFingerprint,
    evidenceRefs,
    observedAt: input.observedAt,
    priorReceiptHash: input.priorReceiptHash
  };

  return {
    stores: nextStores,
    receipt,
    conflict: null,
    blockCode: null,
    blockDetailReason: null,
    canonicalDiff: {
      store,
      operation,
      mutationPath: resolvedMutationPath,
      beforeFingerprint,
      afterFingerprint
    },
    traceLink
  };
}

/**
 * Executes memory rollback drill v1 as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the memory rollback drill v1 runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `./normalizers/canonicalizationRules`.
 * - Uses `MemoryMutationReceiptV1` (import `MemoryMutationReceiptV1`) from `./types`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `RunMemoryRollbackDrillResultV1` result.
 */
export function runMemoryRollbackDrillV1(
  input: RunMemoryRollbackDrillInputV1
): RunMemoryRollbackDrillResultV1 {
  assertValidIsoTimestamp(input.observedAt, "observedAt");
  const restoredStores = deepClone(input.lastKnownGoodStores);
  const canonicalMutationPayload = {
    rollback: true,
    restoreTarget: "all_memory_stores_v1",
    sourceFingerprint: sha256HexFromCanonicalJson(input.lastKnownGoodStores)
  };
  const beforeFingerprint = sha256HexFromCanonicalJson(input.currentStores);
  const afterFingerprint = sha256HexFromCanonicalJson(restoredStores);
  const mutationId = buildMutationId(input.scopeId, input.actionId, canonicalMutationPayload);
  const evidenceRefs = normalizeStringArray(input.evidenceRefs);
  const traceLink: Stage686TraceLinkV1 = {
    traceId: buildTraceId(input.actionId, "conversation_stack", "supersede"),
    observedAt: input.observedAt,
    evidenceRefs
  };

  const rollbackReceipt: MemoryMutationReceiptV1 = {
    mutationId,
    scopeId: input.scopeId,
    taskId: input.taskId,
    proposalId: input.proposalId,
    actionId: input.actionId,
    canonicalMutationPayload,
    store: "conversation_stack",
    operation: "supersede",
    beforeFingerprint,
    afterFingerprint,
    evidenceRefs,
    observedAt: input.observedAt,
    priorReceiptHash: input.priorReceiptHash
  };

  return {
    restoredStores,
    rollbackReceipt,
    traceLink
  };
}
