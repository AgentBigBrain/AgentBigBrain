/**
 * @fileoverview Persists append-only memory-access audit events for brokered retrieval paths.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { withFileLock, writeFileAtomic } from "./fileLock";
import { makeId } from "./ids";
import {
  normalizeSourceRecallRetrievalMode,
  type SourceRecallRetrievalMode
} from "./sourceRecall/contracts";

const MAX_AUDIT_EVENTS = 5_000;

export type MemoryAccessDomainLane =
  | "profile"
  | "relationship"
  | "workflow"
  | "system_policy"
  | "unknown";

export type MemoryAccessAuditEventType = "retrieval" | "PROBING_DETECTED";
export type MemoryAccessCutoverGateDecision = "allow" | "block";

export interface MemoryAccessAuditEvent {
  id: string;
  recordedAt: string;
  eventType: MemoryAccessAuditEventType;
  taskId: string;
  queryHash: string;
  storeLoadCount?: number;
  ingestOperationCount?: number;
  retrievalOperationCount?: number;
  synthesisOperationCount?: number;
  renderOperationCount?: number;
  promptMemoryOwnerCount?: number;
  promptMemorySurfaceCount?: number;
  mixedMemoryOwnerDecisionCount?: number;
  aliasSafetyDecisionCount?: number;
  identitySafetyDecisionCount?: number;
  selfIdentityParityCheckCount?: number;
  selfIdentityParityMismatchCount?: number;
  promptCutoverGateDecision?: MemoryAccessCutoverGateDecision;
  promptCutoverGateReasons?: string[];
  retrievedCount: number;
  retrievedEpisodeCount: number;
  redactedCount: number;
  domainLanes: MemoryAccessDomainLane[];
  probeSignals?: string[];
  probeWindowSize?: number;
  probeMatchCount?: number;
  probeMatchRatio?: number;
  sourceRecallQueryHash?: string;
  sourceRecallRetrievalMode?: SourceRecallRetrievalMode;
  sourceRecallSourceRecordIds?: string[];
  sourceRecallChunkIds?: string[];
  sourceRecallTotalExcerptChars?: number;
  sourceRecallBlockedRedactedCount?: number;
}

interface MemoryAccessAuditDocument {
  events: MemoryAccessAuditEvent[];
}

interface AppendMemoryAccessAuditInput {
  taskId: string;
  query: string;
  storeLoadCount?: number;
  ingestOperationCount?: number;
  retrievalOperationCount?: number;
  synthesisOperationCount?: number;
  renderOperationCount?: number;
  promptMemoryOwnerCount?: number;
  promptMemorySurfaceCount?: number;
  mixedMemoryOwnerDecisionCount?: number;
  aliasSafetyDecisionCount?: number;
  identitySafetyDecisionCount?: number;
  selfIdentityParityCheckCount?: number;
  selfIdentityParityMismatchCount?: number;
  promptCutoverGateDecision?: MemoryAccessCutoverGateDecision;
  promptCutoverGateReasons?: readonly string[];
  retrievedCount: number;
  retrievedEpisodeCount?: number;
  redactedCount: number;
  domainLanes: readonly MemoryAccessDomainLane[];
  eventType?: MemoryAccessAuditEventType;
  probeSignals?: readonly string[];
  probeWindowSize?: number;
  probeMatchCount?: number;
  probeMatchRatio?: number;
  sourceRecallQueryHash?: string;
  sourceRecallRetrievalMode?: SourceRecallRetrievalMode;
  sourceRecallSourceRecordIds?: readonly string[];
  sourceRecallChunkIds?: readonly string[];
  sourceRecallTotalExcerptChars?: number;
  sourceRecallBlockedRedactedCount?: number;
}

/**
 * Evaluates memory access domain lane and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the memory access domain lane policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is MemoryAccessDomainLane` result.
 */
function isMemoryAccessDomainLane(value: unknown): value is MemoryAccessDomainLane {
  return (
    value === "profile" ||
    value === "relationship" ||
    value === "workflow" ||
    value === "system_policy" ||
    value === "unknown"
  );
}

/**
 * Evaluates memory access audit event type and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the memory access audit event type policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is MemoryAccessAuditEventType` result.
 */
function isMemoryAccessAuditEventType(value: unknown): value is MemoryAccessAuditEventType {
  return value === "retrieval" || value === "PROBING_DETECTED";
}

/**
 * Evaluates cutover gate decision and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the cutover gate decision contract explicit and testable before persistence.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is MemoryAccessCutoverGateDecision` result.
 */
function isMemoryAccessCutoverGateDecision(value: unknown): value is MemoryAccessCutoverGateDecision {
  return value === "allow" || value === "block";
}

/**
 * Converts values into non negative integer form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for non negative integer deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed numeric value.
 */
function toNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

/**
 * Converts values into unit interval number form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for unit interval number deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed numeric value.
 */
function toUnitIntervalNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, Number(value)));
}

/**
 * Converts values into normalized probe signals form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for probe signals deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Ordered collection produced by this step.
 */
function normalizeProbeSignals(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return [...new Set(normalized)];
}

/**
 * Converts values into bounded string-id collections for audit-only Source Recall references.
 *
 * **Why it exists:**
 * Source Recall retrieval audit may identify returned records/chunks, but it must never persist
 * raw source text, prompt text, or excerpts in the memory access log.
 *
 * **What it talks to:**
 * - Uses local string normalization only.
 *
 * @param value - Candidate id collection.
 * @returns Unique, trimmed id strings.
 */
function normalizeAuditIdList(value: unknown): string[] {
  return normalizeProbeSignals(value).slice(0, 100);
}

/**
 * Normalizes optional SHA-256-like query hashes without accepting raw query text.
 *
 * **Why it exists:**
 * Source Recall retrieval audit should record bounded query fingerprints only. Malformed values are
 * dropped instead of repaired from raw text.
 *
 * **What it talks to:**
 * - Uses local validation only.
 *
 * @param value - Candidate query hash.
 * @returns Query hash when valid, otherwise undefined.
 */
function normalizeSourceRecallQueryHash(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return /^[a-f0-9]{64}$/i.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

/**
 * Converts values into normalized cutover-gate reasons form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for cutover-gate reasons deterministic so callers do not duplicate mapping
 * logic.
 *
 * **What it talks to:**
 * - Uses `normalizeProbeSignals(...)` within this module for bounded string normalization.
 *
 * @param value - Primary value processed by this function.
 * @returns Ordered collection produced by this step.
 */
function normalizeCutoverGateReasons(value: unknown): string[] {
  return normalizeProbeSignals(value);
}

/**
 * Computes a deterministic fingerprint for query.
 *
 * **Why it exists:**
 * Keeps `hash query` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `createHash` (import `createHash`) from `node:crypto`.
 *
 * @param query - Value for query.
 * @returns Resulting string value.
 */
function hashQuery(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

/**
 * Coerces memory access audit document into a safe deterministic representation.
 *
 * **Why it exists:**
 * Keeps type-coercion rules for memory access audit document explicit so malformed inputs fail predictably.
 *
 * **What it talks to:**
 * - Uses `makeId` (import `makeId`) from `./ids`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `MemoryAccessAuditDocument` result.
 */
function coerceMemoryAccessAuditDocument(input: unknown): MemoryAccessAuditDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { events: [] };
  }

  const record = input as { events?: unknown };
  if (!Array.isArray(record.events)) {
    return { events: [] };
  }

  const events = record.events
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const raw = item as Partial<MemoryAccessAuditEvent>;
      const normalizedDomainLanes = Array.isArray(raw.domainLanes)
        ? raw.domainLanes.filter(isMemoryAccessDomainLane)
        : [];
      const eventType = isMemoryAccessAuditEventType(raw.eventType)
        ? raw.eventType
        : "retrieval";
      const probeSignals = normalizeProbeSignals(raw.probeSignals);
      const cutoverGateReasons = normalizeCutoverGateReasons(raw.promptCutoverGateReasons);
      const probeWindowSize = toNonNegativeInteger(raw.probeWindowSize);
      const probeMatchCount = toNonNegativeInteger(raw.probeMatchCount);
      const probeMatchRatio = toUnitIntervalNumber(raw.probeMatchRatio);
      const sourceRecallQueryHash = normalizeSourceRecallQueryHash(raw.sourceRecallQueryHash);
      const sourceRecallSourceRecordIds = normalizeAuditIdList(raw.sourceRecallSourceRecordIds);
      const sourceRecallChunkIds = normalizeAuditIdList(raw.sourceRecallChunkIds);
      const hasSourceRecallAudit =
        Boolean(sourceRecallQueryHash) ||
        sourceRecallSourceRecordIds.length > 0 ||
        sourceRecallChunkIds.length > 0;
      return {
        id: typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id : makeId("memory_access"),
        recordedAt:
          typeof raw.recordedAt === "string" && raw.recordedAt.trim().length > 0
            ? raw.recordedAt
            : new Date().toISOString(),
        eventType,
        taskId:
          typeof raw.taskId === "string" && raw.taskId.trim().length > 0 ? raw.taskId : "unknown_task",
        queryHash:
          typeof raw.queryHash === "string" && raw.queryHash.trim().length > 0
            ? raw.queryHash
            : hashQuery(""),
        storeLoadCount: toNonNegativeInteger(raw.storeLoadCount),
        ingestOperationCount: toNonNegativeInteger(raw.ingestOperationCount),
        retrievalOperationCount: toNonNegativeInteger(raw.retrievalOperationCount),
        synthesisOperationCount: toNonNegativeInteger(raw.synthesisOperationCount),
        renderOperationCount: toNonNegativeInteger(raw.renderOperationCount),
        promptMemoryOwnerCount: toNonNegativeInteger(raw.promptMemoryOwnerCount),
        promptMemorySurfaceCount: toNonNegativeInteger(raw.promptMemorySurfaceCount),
        mixedMemoryOwnerDecisionCount: toNonNegativeInteger(raw.mixedMemoryOwnerDecisionCount),
        aliasSafetyDecisionCount: toNonNegativeInteger(raw.aliasSafetyDecisionCount),
        identitySafetyDecisionCount: toNonNegativeInteger(raw.identitySafetyDecisionCount),
        selfIdentityParityCheckCount: toNonNegativeInteger(raw.selfIdentityParityCheckCount),
        selfIdentityParityMismatchCount: toNonNegativeInteger(raw.selfIdentityParityMismatchCount),
        promptCutoverGateDecision: isMemoryAccessCutoverGateDecision(raw.promptCutoverGateDecision)
          ? raw.promptCutoverGateDecision
          : "allow",
        promptCutoverGateReasons: cutoverGateReasons.length > 0 ? cutoverGateReasons : undefined,
        retrievedCount: toNonNegativeInteger(raw.retrievedCount),
        retrievedEpisodeCount: toNonNegativeInteger(raw.retrievedEpisodeCount),
        redactedCount: toNonNegativeInteger(raw.redactedCount),
        domainLanes: normalizedDomainLanes.length > 0 ? normalizedDomainLanes : ["unknown"],
        probeSignals: probeSignals.length > 0 ? probeSignals : undefined,
        probeWindowSize: eventType === "PROBING_DETECTED" ? probeWindowSize : undefined,
        probeMatchCount: eventType === "PROBING_DETECTED" ? probeMatchCount : undefined,
        probeMatchRatio: eventType === "PROBING_DETECTED" ? probeMatchRatio : undefined,
        sourceRecallQueryHash,
        sourceRecallRetrievalMode:
          hasSourceRecallAudit
            ? normalizeSourceRecallRetrievalMode(raw.sourceRecallRetrievalMode)
            : undefined,
        sourceRecallSourceRecordIds:
          sourceRecallSourceRecordIds.length > 0 ? sourceRecallSourceRecordIds : undefined,
        sourceRecallChunkIds: sourceRecallChunkIds.length > 0 ? sourceRecallChunkIds : undefined,
        sourceRecallTotalExcerptChars: hasSourceRecallAudit
          ? toNonNegativeInteger(raw.sourceRecallTotalExcerptChars)
          : undefined,
        sourceRecallBlockedRedactedCount: hasSourceRecallAudit
          ? toNonNegativeInteger(raw.sourceRecallBlockedRedactedCount)
          : undefined
      } satisfies MemoryAccessAuditEvent;
    });

  return { events };
}

export class MemoryAccessAuditStore {
  /**
   * Initializes `MemoryAccessAuditStore` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param filePath - Filesystem location used by this operation.
   */
  constructor(private readonly filePath = "runtime/memory_access_log.json") {}

  /**
   * Reads input needed for this execution step.
   *
   * **Why it exists:**
   * Separates input read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
   * @returns Promise resolving to MemoryAccessAuditDocument.
   */
  async load(): Promise<MemoryAccessAuditDocument> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return coerceMemoryAccessAuditDocument(JSON.parse(raw));
    } catch {
      return { events: [] };
    }
  }

  /**
   * Persists event with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes event mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `withFileLock` (import `withFileLock`) from `./fileLock`.
   * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `./fileLock`.
   * - Uses `makeId` (import `makeId`) from `./ids`.
   *
   * @param input - Structured input object for this operation.
   * @returns Promise resolving to void.
   */
  async appendEvent(input: AppendMemoryAccessAuditInput): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const document = await this.load();
      const normalizedLanes = [...new Set(input.domainLanes.filter(isMemoryAccessDomainLane))];
      const eventType = isMemoryAccessAuditEventType(input.eventType)
        ? input.eventType
        : "retrieval";
      const probeSignals = normalizeProbeSignals(input.probeSignals);
      const cutoverGateReasons = normalizeCutoverGateReasons(input.promptCutoverGateReasons);
      const sourceRecallQueryHash = normalizeSourceRecallQueryHash(input.sourceRecallQueryHash);
      const sourceRecallSourceRecordIds = normalizeAuditIdList(input.sourceRecallSourceRecordIds);
      const sourceRecallChunkIds = normalizeAuditIdList(input.sourceRecallChunkIds);
      const hasSourceRecallAudit =
        Boolean(sourceRecallQueryHash) ||
        sourceRecallSourceRecordIds.length > 0 ||
        sourceRecallChunkIds.length > 0;
      const event: MemoryAccessAuditEvent = {
        id: makeId("memory_access"),
        recordedAt: new Date().toISOString(),
        eventType,
        taskId: input.taskId,
        queryHash: hashQuery(input.query),
        storeLoadCount: toNonNegativeInteger(input.storeLoadCount),
        ingestOperationCount: toNonNegativeInteger(input.ingestOperationCount),
        retrievalOperationCount: toNonNegativeInteger(input.retrievalOperationCount),
        synthesisOperationCount: toNonNegativeInteger(input.synthesisOperationCount),
        renderOperationCount: toNonNegativeInteger(input.renderOperationCount),
        promptMemoryOwnerCount: toNonNegativeInteger(input.promptMemoryOwnerCount),
        promptMemorySurfaceCount: toNonNegativeInteger(input.promptMemorySurfaceCount),
        mixedMemoryOwnerDecisionCount: toNonNegativeInteger(input.mixedMemoryOwnerDecisionCount),
        aliasSafetyDecisionCount: toNonNegativeInteger(input.aliasSafetyDecisionCount),
        identitySafetyDecisionCount: toNonNegativeInteger(input.identitySafetyDecisionCount),
        selfIdentityParityCheckCount: toNonNegativeInteger(input.selfIdentityParityCheckCount),
        selfIdentityParityMismatchCount: toNonNegativeInteger(input.selfIdentityParityMismatchCount),
        promptCutoverGateDecision: isMemoryAccessCutoverGateDecision(input.promptCutoverGateDecision)
          ? input.promptCutoverGateDecision
          : "allow",
        promptCutoverGateReasons: cutoverGateReasons.length > 0 ? cutoverGateReasons : undefined,
        retrievedCount: toNonNegativeInteger(input.retrievedCount),
        retrievedEpisodeCount: toNonNegativeInteger(input.retrievedEpisodeCount),
        redactedCount: toNonNegativeInteger(input.redactedCount),
        domainLanes: normalizedLanes.length > 0 ? normalizedLanes : ["unknown"],
        probeSignals: probeSignals.length > 0 ? probeSignals : undefined,
        probeWindowSize:
          eventType === "PROBING_DETECTED" ? toNonNegativeInteger(input.probeWindowSize) : undefined,
        probeMatchCount:
          eventType === "PROBING_DETECTED" ? toNonNegativeInteger(input.probeMatchCount) : undefined,
        probeMatchRatio:
          eventType === "PROBING_DETECTED" ? toUnitIntervalNumber(input.probeMatchRatio) : undefined,
        sourceRecallQueryHash,
        sourceRecallRetrievalMode:
          hasSourceRecallAudit
            ? normalizeSourceRecallRetrievalMode(input.sourceRecallRetrievalMode)
            : undefined,
        sourceRecallSourceRecordIds:
          sourceRecallSourceRecordIds.length > 0 ? sourceRecallSourceRecordIds : undefined,
        sourceRecallChunkIds: sourceRecallChunkIds.length > 0 ? sourceRecallChunkIds : undefined,
        sourceRecallTotalExcerptChars: hasSourceRecallAudit
          ? toNonNegativeInteger(input.sourceRecallTotalExcerptChars)
          : undefined,
        sourceRecallBlockedRedactedCount: hasSourceRecallAudit
          ? toNonNegativeInteger(input.sourceRecallBlockedRedactedCount)
          : undefined
      };

      document.events.push(event);
      if (document.events.length > MAX_AUDIT_EVENTS) {
        document.events = document.events.slice(-MAX_AUDIT_EVENTS);
      }

      await writeFileAtomic(this.filePath, JSON.stringify(document, null, 2));
    });
  }
}
