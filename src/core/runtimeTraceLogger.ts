/**
 * @fileoverview Persists structured JSONL runtime trace events with correlation IDs and timing spans.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  ExecutionMode,
  RuntimeTraceDetailValue,
  RuntimeTraceEvent,
  RuntimeTraceEventType
} from "./types";
import { withFileLock } from "./fileLock";
import { makeId } from "./ids";

interface RuntimeTraceLoggerOptions {
  enabled: boolean;
  filePath: string;
}

export interface AppendRuntimeTraceEventInput {
  eventType: RuntimeTraceEventType;
  taskId: string;
  actionId?: string;
  proposalId?: string;
  governanceEventId?: string;
  mode?: ExecutionMode;
  durationMs?: number;
  details?: Record<string, unknown>;
}

/**
 * Evaluates runtime trace event type and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the runtime trace event type policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `RuntimeTraceEventType` (import `RuntimeTraceEventType`) from `./types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is RuntimeTraceEventType` result.
 */
function isRuntimeTraceEventType(value: unknown): value is RuntimeTraceEventType {
  return (
    value === "task_started" ||
    value === "planner_completed" ||
    value === "constraint_blocked" ||
    value === "governance_voted" ||
    value === "action_executed" ||
    value === "governance_event_persisted" ||
    value === "task_completed"
  );
}

/**
 * Coerces duration ms into a safe deterministic representation.
 *
 * **Why it exists:**
 * Keeps type-coercion rules for duration ms explicit so malformed inputs fail predictably.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `number | undefined` result.
 */
function coerceDurationMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(value);
}

/**
 * Coerces details into a safe deterministic representation.
 *
 * **Why it exists:**
 * Keeps type-coercion rules for details explicit so malformed inputs fail predictably.
 *
 * **What it talks to:**
 * - Uses `RuntimeTraceDetailValue` (import `RuntimeTraceDetailValue`) from `./types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `Record<string, RuntimeTraceDetailValue> | undefined` result.
 */
function coerceDetails(value: unknown): Record<string, RuntimeTraceDetailValue> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const normalized: Record<string, RuntimeTraceDetailValue> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      typeof candidate === "boolean" ||
      candidate === null
    ) {
      normalized[key] = candidate;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Coerces mode into a safe deterministic representation.
 *
 * **Why it exists:**
 * Keeps type-coercion rules for mode explicit so malformed inputs fail predictably.
 *
 * **What it talks to:**
 * - Uses `ExecutionMode` (import `ExecutionMode`) from `./types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `ExecutionMode | undefined` result.
 */
function coerceMode(value: unknown): ExecutionMode | undefined {
  if (value === "fast_path" || value === "escalation_path") {
    return value;
  }
  return undefined;
}

/**
 * Coerces runtime trace event into a safe deterministic representation.
 *
 * **Why it exists:**
 * Keeps type-coercion rules for runtime trace event explicit so malformed inputs fail predictably.
 *
 * **What it talks to:**
 * - Uses `RuntimeTraceEvent` (import `RuntimeTraceEvent`) from `./types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `RuntimeTraceEvent | null` result.
 */
function coerceRuntimeTraceEvent(value: unknown): RuntimeTraceEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<RuntimeTraceEvent>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.recordedAt !== "string" ||
    typeof candidate.taskId !== "string" ||
    !isRuntimeTraceEventType(candidate.eventType)
  ) {
    return null;
  }

  const event: RuntimeTraceEvent = {
    id: candidate.id,
    recordedAt: candidate.recordedAt,
    eventType: candidate.eventType,
    taskId: candidate.taskId
  };

  if (typeof candidate.actionId === "string" && candidate.actionId.trim().length > 0) {
    event.actionId = candidate.actionId;
  }
  if (typeof candidate.proposalId === "string" && candidate.proposalId.trim().length > 0) {
    event.proposalId = candidate.proposalId;
  }
  if (
    typeof candidate.governanceEventId === "string" &&
    candidate.governanceEventId.trim().length > 0
  ) {
    event.governanceEventId = candidate.governanceEventId;
  }
  event.mode = coerceMode(candidate.mode);
  event.durationMs = coerceDurationMs(candidate.durationMs);
  event.details = coerceDetails(candidate.details);

  return event;
}

/**
 * Parses json line events and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for json line events so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `RuntimeTraceEvent` (import `RuntimeTraceEvent`) from `./types`.
 *
 * @param content - Value for content.
 * @returns Ordered collection produced by this step.
 */
function parseJsonLineEvents(content: string): RuntimeTraceEvent[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const events: RuntimeTraceEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      const event = coerceRuntimeTraceEvent(parsed);
      if (event) {
        events.push(event);
      }
    } catch {
      continue;
    }
  }

  return events;
}

export class RuntimeTraceLogger {
  private readonly enabled: boolean;
  private readonly filePath: string;

  /**
   * Initializes `RuntimeTraceLogger` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses `path` (import `default`) from `node:path`.
   *
   * @param options - Optional tuning knobs for this operation.
   */
  constructor(options: RuntimeTraceLoggerOptions) {
    this.enabled = options.enabled;
    this.filePath = path.isAbsolute(options.filePath)
      ? options.filePath
      : path.resolve(process.cwd(), options.filePath);
  }

  /**
   * Persists event with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes event mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `withFileLock` (import `withFileLock`) from `./fileLock`.
   * - Uses `makeId` (import `makeId`) from `./ids`.
   * - Uses `RuntimeTraceEvent` (import `RuntimeTraceEvent`) from `./types`.
   * - Uses `appendFile` (import `appendFile`) from `node:fs/promises`.
   * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
   * - Uses `path` (import `default`) from `node:path`.
   *
   * @param input - Structured input object for this operation.
   * @returns Promise resolving to RuntimeTraceEvent | null.
   */
  async appendEvent(input: AppendRuntimeTraceEventInput): Promise<RuntimeTraceEvent | null> {
    if (!this.enabled) {
      return null;
    }

    const event: RuntimeTraceEvent = {
      id: makeId("trace"),
      recordedAt: new Date().toISOString(),
      eventType: input.eventType,
      taskId: input.taskId
    };

    if (typeof input.actionId === "string" && input.actionId.trim().length > 0) {
      event.actionId = input.actionId;
    }
    if (typeof input.proposalId === "string" && input.proposalId.trim().length > 0) {
      event.proposalId = input.proposalId;
    }
    if (
      typeof input.governanceEventId === "string" &&
      input.governanceEventId.trim().length > 0
    ) {
      event.governanceEventId = input.governanceEventId;
    }
    event.mode = coerceMode(input.mode);
    event.durationMs = coerceDurationMs(input.durationMs);
    event.details = coerceDetails(input.details);

    await withFileLock(this.filePath, async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    });

    return event;
  }

  /**
   * Reads events needed for this execution step.
   *
   * **Why it exists:**
   * Separates events read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `RuntimeTraceEvent` (import `RuntimeTraceEvent`) from `./types`.
   * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
   *
   * @param limit - Numeric bound, counter, or index used by this logic.
   * @returns Ordered collection produced by this step.
   */
  async readEvents(limit?: number): Promise<RuntimeTraceEvent[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = parseJsonLineEvents(raw);
      if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
        return parsed;
      }
      const normalizedLimit = Math.floor(limit);
      return parsed.slice(-normalizedLimit);
    } catch {
      return [];
    }
  }
}
