/**
 * @fileoverview Persists append-only memory-access audit events for brokered retrieval paths.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { withFileLock, writeFileAtomic } from "./fileLock";
import { makeId } from "./ids";

const MAX_AUDIT_EVENTS = 5_000;

export type MemoryAccessDomainLane =
  | "profile"
  | "relationship"
  | "workflow"
  | "system_policy"
  | "unknown";

export type MemoryAccessAuditEventType = "retrieval" | "PROBING_DETECTED";

export interface MemoryAccessAuditEvent {
  id: string;
  recordedAt: string;
  eventType: MemoryAccessAuditEventType;
  taskId: string;
  queryHash: string;
  storeLoadCount?: number;
  retrievedCount: number;
  retrievedEpisodeCount: number;
  redactedCount: number;
  domainLanes: MemoryAccessDomainLane[];
  probeSignals?: string[];
  probeWindowSize?: number;
  probeMatchCount?: number;
  probeMatchRatio?: number;
}

interface MemoryAccessAuditDocument {
  events: MemoryAccessAuditEvent[];
}

interface AppendMemoryAccessAuditInput {
  taskId: string;
  query: string;
  storeLoadCount?: number;
  retrievedCount: number;
  retrievedEpisodeCount?: number;
  redactedCount: number;
  domainLanes: readonly MemoryAccessDomainLane[];
  eventType?: MemoryAccessAuditEventType;
  probeSignals?: readonly string[];
  probeWindowSize?: number;
  probeMatchCount?: number;
  probeMatchRatio?: number;
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
      const probeWindowSize = toNonNegativeInteger(raw.probeWindowSize);
      const probeMatchCount = toNonNegativeInteger(raw.probeMatchCount);
      const probeMatchRatio = toUnitIntervalNumber(raw.probeMatchRatio);
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
        retrievedCount: toNonNegativeInteger(raw.retrievedCount),
        retrievedEpisodeCount: toNonNegativeInteger(raw.retrievedEpisodeCount),
        redactedCount: toNonNegativeInteger(raw.redactedCount),
        domainLanes: normalizedDomainLanes.length > 0 ? normalizedDomainLanes : ["unknown"],
        probeSignals: probeSignals.length > 0 ? probeSignals : undefined,
        probeWindowSize: eventType === "PROBING_DETECTED" ? probeWindowSize : undefined,
        probeMatchCount: eventType === "PROBING_DETECTED" ? probeMatchCount : undefined,
        probeMatchRatio: eventType === "PROBING_DETECTED" ? probeMatchRatio : undefined
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
      const event: MemoryAccessAuditEvent = {
        id: makeId("memory_access"),
        recordedAt: new Date().toISOString(),
        eventType,
      taskId: input.taskId,
      queryHash: hashQuery(input.query),
      storeLoadCount: toNonNegativeInteger(input.storeLoadCount),
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
          eventType === "PROBING_DETECTED" ? toUnitIntervalNumber(input.probeMatchRatio) : undefined
      };

      document.events.push(event);
      if (document.events.length > MAX_AUDIT_EVENTS) {
        document.events = document.events.slice(-MAX_AUDIT_EVENTS);
      }

      await writeFileAtomic(this.filePath, JSON.stringify(document, null, 2));
    });
  }
}
