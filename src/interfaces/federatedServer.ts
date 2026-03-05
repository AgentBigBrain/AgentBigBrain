/**
 * @fileoverview Federation HTTP server for agent-to-agent task delegation with async result delivery.
 *
 * Exposes the FederatedDelegationGateway over HTTP so external agents
 * can submit tasks via JSON and retrieve asynchronous execution results.
 */

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  FederatedAuthenticationDecision,
  FederatedDelegationDecision,
  FederatedDelegationGateway,
  FederatedInboundTask
} from "../core/federatedDelegation";
import { writeFileAtomic } from "../core/fileLock";

export interface FederatedHttpServerOptions {
  /** Port to listen on. Default: 9100 */
  port: number;
  /** Bind host. Default: 127.0.0.1 (localhost only for safety). */
  host?: string;
  /** Maximum request body size in bytes. Default: 65536. */
  maxBodyBytes?: number;
  /** Gateway that validates contracts and converts inbound requests into local tasks. */
  gateway: FederatedDelegationGateway;
  /** Optional async callback used to execute accepted federated tasks. */
  onTaskAccepted?: (decision: FederatedDelegationDecision) => Promise<void>;
  /** How long to retain completed/failed results before eviction (ms). */
  resultTtlMs?: number;
  /** Sweep interval for TTL eviction (ms). */
  evictionIntervalMs?: number;
  /** Persistent result-store path for restart safety. */
  resultStorePath?: string;
}

export type FederatedTaskStatus = "pending" | "completed" | "failed";

export interface FederatedTaskResult {
  taskId: string;
  status: FederatedTaskStatus;
  output: string | null;
  error: string | null;
  acceptedAt: string;
  completedAt: string | null;
}

interface FederatedDelegateResponse {
  ok: boolean;
  decision: FederatedDelegationDecision;
  taskId: string | null;
}

interface FederatedErrorResponse {
  ok: false;
  error: string;
}

interface FederatedResultsStoreDocument {
  updatedAt: string;
  results: FederatedTaskResult[];
}

const DEFAULT_MAX_BODY_BYTES = 65_536;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_RESULT_TTL_MS = 3_600_000;
const DEFAULT_EVICTION_INTERVAL_MS = 60_000;
const DEFAULT_RESULT_STORE_PATH = path.resolve(process.cwd(), "runtime/federated_results.json");
const AUTH_AGENT_ID_HEADER = "x-federation-agent-id";
const AUTH_SECRET_HEADER = "x-federation-shared-secret";

/**
 * Constrains and sanitizes utf8 bom to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for utf8 bom before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function stripUtf8Bom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

/**
 * Reads body needed for this execution step.
 *
 * **Why it exists:**
 * Separates body read-path handling from orchestration and mutation code.
 *
 * **What it talks to:**
 * - Uses `IncomingMessage` (import `IncomingMessage`) from `node:http`.
 *
 * @param req - Value for req.
 * @param maxBytes - Numeric bound, counter, or index used by this logic.
 * @returns Promise resolving to string.
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Sends json through the module's deterministic transport path.
 *
 * **Why it exists:**
 * Keeps outbound transport behavior for json consistent across runtime call sites.
 *
 * **What it talks to:**
 * - Uses `ServerResponse` (import `ServerResponse`) from `node:http`.
 *
 * @param res - Value for res.
 * @param status - Value for status.
 * @param body - Value for body.
 */
function sendJson(
  res: ServerResponse,
  status: number,
  body: FederatedDelegateResponse | FederatedErrorResponse | Record<string, unknown>
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

/**
 * Parses result store document and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for result store document so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param raw - Value for raw.
 * @returns Computed `FederatedResultsStoreDocument` result.
 */
function parseResultStoreDocument(raw: string): FederatedResultsStoreDocument {
  const parsed = JSON.parse(stripUtf8Bom(raw)) as Partial<FederatedResultsStoreDocument>;
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  return {
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    results: results.filter((candidate): candidate is FederatedTaskResult => {
      if (!candidate || typeof candidate !== "object") {
        return false;
      }
      const item = candidate as Partial<FederatedTaskResult>;
      return (
        typeof item.taskId === "string" &&
        (item.status === "pending" || item.status === "completed" || item.status === "failed") &&
        (item.output === null || typeof item.output === "string") &&
        (item.error === null || typeof item.error === "string") &&
        typeof item.acceptedAt === "string" &&
        (item.completedAt === null || typeof item.completedAt === "string")
      );
    })
  };
}

/**
 * Converts values into header string form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for header string deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function asHeaderString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return typeof value === "string" ? value : "";
}

export class FederatedHttpServer {
  private server: Server | null = null;
  private evictionTimer: NodeJS.Timeout | null = null;
  private persistInFlight: Promise<void> | null = null;
  private persistRequested = false;
  private readonly pendingAcceptedTasks = new Set<Promise<void>>();
  private readonly results = new Map<string, FederatedTaskResult>();
  private readonly port: number;
  private readonly host: string;
  private readonly maxBodyBytes: number;
  private readonly gateway: FederatedDelegationGateway;
  private readonly onTaskAccepted?: (decision: FederatedDelegationDecision) => Promise<void>;
  private readonly resultTtlMs: number;
  private readonly evictionIntervalMs: number;
  private readonly resultStorePath: string;

  /**
   * Initializes `FederatedHttpServer` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses `path` (import `default`) from `node:path`.
   *
   * @param options - Optional tuning knobs for this operation.
   */
  constructor(options: FederatedHttpServerOptions) {
    this.port = options.port;
    this.host = options.host ?? DEFAULT_HOST;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.gateway = options.gateway;
    this.onTaskAccepted = options.onTaskAccepted;
    this.resultTtlMs = options.resultTtlMs ?? DEFAULT_RESULT_TTL_MS;
    this.evictionIntervalMs = options.evictionIntervalMs ?? DEFAULT_EVICTION_INTERVAL_MS;
    this.resultStorePath = options.resultStorePath
      ? path.resolve(process.cwd(), options.resultStorePath)
      : DEFAULT_RESULT_STORE_PATH;
  }

  /**
   * Starts input within this module's managed runtime lifecycle.
   *
   * **Why it exists:**
   * Keeps startup sequencing for input explicit and deterministic.
   *
   * **What it talks to:**
   * - Uses `createServer` (import `createServer`) from `node:http`.
   * @returns Promise resolving to void.
   */
  async start(): Promise<void> {
    await this.loadPersistedState();

    return new Promise((resolve, reject) => {
      this.server = createServer(async (req, res) => {
        try {
          await this.handleRequest(req, res);
        } catch {
          sendJson(res, 500, {
            ok: false,
            error: "Internal server error"
          });
        }
      });

      this.server.on("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.startEvictionSweep();
        resolve();
      });
    });
  }

  /**
   * Stops or clears input to keep runtime state consistent.
   *
   * **Why it exists:**
   * Centralizes teardown/reset behavior for input so lifecycle handling stays predictable.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   * @returns Promise resolving to void.
   */
  async stop(): Promise<void> {
    this.stopEvictionSweep();
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
    await this.waitForAcceptedTasksToSettle();
    await this.flushPersistIfNeeded();
  }

  /**
   * Reads address needed for this execution step.
   *
   * **Why it exists:**
   * Separates address read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   * @returns Computed `{ host: string; port: number } | null` result.
   */
  getAddress(): { host: string; port: number } | null {
    if (!this.server) {
      return null;
    }
    const addr = this.server.address();
    if (typeof addr === "string" || addr === null) {
      return null;
    }
    return { host: addr.address, port: addr.port };
  }

  /**
   * Implements submit result behavior used by `federatedServer`.
   *
   * **Why it exists:**
   * Keeps `submit result` logic in one place to reduce behavior drift.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param taskId - Stable identifier used to reference an entity or record.
   * @param output - Result object inspected or transformed in this step.
   * @param error - Value for error.
   */
  submitResult(taskId: string, output: string | null, error: string | null): void {
    const existing = this.results.get(taskId);
    const nowIso = new Date().toISOString();

    if (!existing) {
      this.results.set(taskId, {
        taskId,
        status: error ? "failed" : "completed",
        output,
        error,
        acceptedAt: nowIso,
        completedAt: nowIso
      });
      this.schedulePersist();
      return;
    }

    existing.status = error ? "failed" : "completed";
    existing.output = output;
    existing.error = error;
    existing.completedAt = nowIso;
    this.schedulePersist();
  }

  /**
   * Reads result needed for this execution step.
   *
   * **Why it exists:**
   * Separates result read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param taskId - Stable identifier used to reference an entity or record.
   * @returns Computed `FederatedTaskResult | null` result.
   */
  getResult(taskId: string): FederatedTaskResult | null {
    return this.results.get(taskId) ?? null;
  }

  /**
   * Reads pending task ids needed for this execution step.
   *
   * **Why it exists:**
   * Separates pending task ids read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   * @returns Ordered collection produced by this step.
   */
  getPendingTaskIds(): string[] {
    return [...this.results.entries()]
      .filter(([, result]) => result.status === "pending")
      .map(([taskId]) => taskId);
  }

  /**
   * Removes expired results according to deterministic lifecycle rules.
   *
   * **Why it exists:**
   * Ensures expired results removal follows deterministic lifecycle and retention rules.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   * @returns Computed numeric value.
   */
  evictExpiredResults(): number {
    const cutoff = Date.now() - this.resultTtlMs;
    let evictedCount = 0;

    for (const [taskId, result] of this.results.entries()) {
      if (result.status === "pending" || !result.completedAt) {
        continue;
      }
      const completedAtMs = Date.parse(result.completedAt);
      if (!Number.isFinite(completedAtMs)) {
        continue;
      }
      if (completedAtMs < cutoff) {
        this.results.delete(taskId);
        evictedCount += 1;
      }
    }

    if (evictedCount > 0) {
      this.schedulePersist();
    }

    return evictedCount;
  }

  /**
   * Executes request as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the request runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses `IncomingMessage` (import `IncomingMessage`) from `node:http`.
   * - Uses `ServerResponse` (import `ServerResponse`) from `node:http`.
   *
   * @param req - Value for req.
   * @param res - Value for res.
   * @returns Promise resolving to void.
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/federation/health" && req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        status: "healthy",
        pendingTasks: this.getPendingTaskIds().length,
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (url.pathname === "/federation/delegate" && req.method === "POST") {
      await this.handleDelegate(req, res);
      return;
    }

    const resultMatch = url.pathname.match(/^\/federation\/results\/([\w-]+)$/);
    if (resultMatch && req.method === "GET") {
      this.handleResultPoll(resultMatch[1], req, res);
      return;
    }

    if (url.pathname === "/federation/pending" && req.method === "GET") {
      this.handlePendingList(req, res);
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  }

  /**
   * Derives auth decision from available runtime inputs.
   *
   * **Why it exists:**
   * Keeps derivation logic for auth decision in one place so downstream policy uses the same signal.
   *
   * **What it talks to:**
   * - Uses `FederatedAuthenticationDecision` (import `FederatedAuthenticationDecision`) from `../core/federatedDelegation`.
   * - Uses `IncomingMessage` (import `IncomingMessage`) from `node:http`.
   *
   * @param req - Value for req.
   * @returns Computed `| FederatedAuthenticationDecision
    | { authenticated: false; errorMessage: string; statusCode: 401 }` result.
   */
  private extractAuthDecision(req: IncomingMessage):
    | FederatedAuthenticationDecision
    | { authenticated: false; errorMessage: string; statusCode: 401 } {
    const externalAgentId = asHeaderString(req.headers[AUTH_AGENT_ID_HEADER]).trim();
    const sharedSecret = asHeaderString(req.headers[AUTH_SECRET_HEADER]);

    if (!externalAgentId || !sharedSecret) {
      return {
        authenticated: false,
        errorMessage: `Missing required auth headers: ${AUTH_AGENT_ID_HEADER}, ${AUTH_SECRET_HEADER}`,
        statusCode: 401
      };
    }

    return this.gateway.authenticateInboundAgent(externalAgentId, sharedSecret);
  }

  /**
   * Executes result poll as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the result poll runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses `IncomingMessage` (import `IncomingMessage`) from `node:http`.
   * - Uses `ServerResponse` (import `ServerResponse`) from `node:http`.
   *
   * @param taskId - Stable identifier used to reference an entity or record.
   * @param req - Value for req.
   * @param res - Value for res.
   */
  private handleResultPoll(taskId: string, req: IncomingMessage, res: ServerResponse): void {
    const authDecision = this.extractAuthDecision(req);
    if (!authDecision.authenticated) {
      const status = "statusCode" in authDecision ? authDecision.statusCode : 403;
      const message = "errorMessage" in authDecision
        ? authDecision.errorMessage
        : authDecision.reasons.join(" ");
      sendJson(res, status, {
        ok: false,
        error: message,
        blockedBy: "blockedBy" in authDecision ? authDecision.blockedBy : undefined
      });
      return;
    }

    const result = this.results.get(taskId);
    if (!result) {
      sendJson(res, 404, { ok: false, error: `No task found with ID: ${taskId}` });
      return;
    }

    sendJson(res, 200, { ok: true, result });
  }

  /**
   * Executes pending list as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the pending list runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses `IncomingMessage` (import `IncomingMessage`) from `node:http`.
   * - Uses `ServerResponse` (import `ServerResponse`) from `node:http`.
   *
   * @param req - Value for req.
   * @param res - Value for res.
   */
  private handlePendingList(req: IncomingMessage, res: ServerResponse): void {
    const authDecision = this.extractAuthDecision(req);
    if (!authDecision.authenticated) {
      const status = "statusCode" in authDecision ? authDecision.statusCode : 403;
      const message = "errorMessage" in authDecision
        ? authDecision.errorMessage
        : authDecision.reasons.join(" ");
      sendJson(res, status, {
        ok: false,
        error: message,
        blockedBy: "blockedBy" in authDecision ? authDecision.blockedBy : undefined
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      pendingTaskIds: this.getPendingTaskIds()
    });
  }

  /**
   * Executes delegate as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the delegate runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses `FederatedInboundTask` (import `FederatedInboundTask`) from `../core/federatedDelegation`.
   * - Uses `IncomingMessage` (import `IncomingMessage`) from `node:http`.
   * - Uses `ServerResponse` (import `ServerResponse`) from `node:http`.
   *
   * @param req - Value for req.
   * @param res - Value for res.
   * @returns Promise resolving to void.
   */
  private async handleDelegate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const externalAgentId = asHeaderString(req.headers[AUTH_AGENT_ID_HEADER]).trim();
    const sharedSecret = asHeaderString(req.headers[AUTH_SECRET_HEADER]);
    if (!externalAgentId || !sharedSecret) {
      sendJson(res, 401, {
        ok: false,
        error: `Missing required auth headers: ${AUTH_AGENT_ID_HEADER}, ${AUTH_SECRET_HEADER}`
      });
      return;
    }

    let body: string;
    try {
      body = await readBody(req, this.maxBodyBytes);
    } catch {
      sendJson(res, 413, { ok: false, error: "Request body too large" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
      return;
    }

    const candidate = parsed as Partial<FederatedInboundTask>;
    if (
      typeof candidate.quoteId !== "string" ||
      typeof candidate.quotedCostUsd !== "number" ||
      typeof candidate.goal !== "string" ||
      typeof candidate.userInput !== "string"
    ) {
      sendJson(res, 400, {
        ok: false,
        error: "Missing required fields: quoteId, quotedCostUsd, goal, userInput"
      });
      return;
    }

    const inboundTask: FederatedInboundTask = {
      quoteId: candidate.quoteId,
      quotedCostUsd: candidate.quotedCostUsd,
      goal: candidate.goal,
      userInput: candidate.userInput,
      requestedAt: typeof candidate.requestedAt === "string" ? candidate.requestedAt : undefined
    };

    const decision = this.gateway.routeInboundRequest(inboundTask, externalAgentId, sharedSecret);
    const taskId = decision.taskRequest?.id ?? null;

    if (decision.accepted && taskId) {
      this.results.set(taskId, {
        taskId,
        status: "pending",
        output: null,
        error: null,
        acceptedAt: new Date().toISOString(),
        completedAt: null
      });
      this.schedulePersist();
    }

    if (decision.accepted && taskId && this.onTaskAccepted) {
      const taskPromise = this.handleAcceptedTask(decision, taskId);
      this.pendingAcceptedTasks.add(taskPromise);
      void taskPromise.finally(() => {
        this.pendingAcceptedTasks.delete(taskPromise);
      });
    }

    const status = decision.accepted ? 200 : 403;
    sendJson(res, status, { ok: decision.accepted, decision, taskId });
  }

  /**
   * Executes accepted task as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the accepted task runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses `FederatedDelegationDecision` (import `FederatedDelegationDecision`) from `../core/federatedDelegation`.
   *
   * @param decision - Value for decision.
   * @param taskId - Stable identifier used to reference an entity or record.
   * @returns Promise resolving to void.
   */
  private async handleAcceptedTask(decision: FederatedDelegationDecision, taskId: string): Promise<void> {
    if (!this.onTaskAccepted) {
      return;
    }

    try {
      await this.onTaskAccepted(decision);
      const current = this.results.get(taskId);
      if (current && current.status === "pending") {
        this.submitResult(taskId, null, "Accepted task completed without explicit result payload.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown execution failure";
      this.submitResult(taskId, null, `Task acceptance callback failed: ${message}`);
    }
  }

  /**
   * Implements wait for accepted tasks to settle behavior used by `federatedServer`.
   *
   * **Why it exists:**
   * Keeps `wait for accepted tasks to settle` logic in one place to reduce behavior drift.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   * @returns Promise resolving to void.
   */
  private async waitForAcceptedTasksToSettle(): Promise<void> {
    if (this.pendingAcceptedTasks.size === 0) {
      return;
    }
    await Promise.allSettled([...this.pendingAcceptedTasks]);
  }

  /**
   * Starts eviction sweep within this module's managed runtime lifecycle.
   *
   * **Why it exists:**
   * Keeps startup sequencing for eviction sweep explicit and deterministic.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   */
  private startEvictionSweep(): void {
    this.stopEvictionSweep();
    this.evictionTimer = setInterval(() => {
      this.evictExpiredResults();
    }, this.evictionIntervalMs);
    this.evictionTimer.unref();
  }

  /**
   * Stops or clears eviction sweep to keep runtime state consistent.
   *
   * **Why it exists:**
   * Centralizes teardown/reset behavior for eviction sweep so lifecycle handling stays predictable.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   */
  private stopEvictionSweep(): void {
    if (!this.evictionTimer) {
      return;
    }
    clearInterval(this.evictionTimer);
    this.evictionTimer = null;
  }

  /**
   * Reads persisted state needed for this execution step.
   *
   * **Why it exists:**
   * Separates persisted state read-path handling from orchestration and mutation code.
   *
   * **What it talks to:**
   * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
   * @returns Promise resolving to void.
   */
  private async loadPersistedState(): Promise<void> {
    try {
      const raw = await readFile(this.resultStorePath, "utf8");
      const document = parseResultStoreDocument(raw);
      this.results.clear();
      for (const result of document.results) {
        this.results.set(result.taskId, { ...result });
      }
      this.evictExpiredResults();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  /**
   * Starts persist within this module's managed runtime lifecycle.
   *
   * **Why it exists:**
   * Keeps startup sequencing for persist explicit and deterministic.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   */
  private schedulePersist(): void {
    if (this.persistInFlight) {
      this.persistRequested = true;
      return;
    }

    this.persistInFlight = this.persistNow()
      .catch(() => {
        // Non-fatal for runtime behavior. Next mutation or stop() flush will retry.
      })
      .finally(() => {
        this.persistInFlight = null;
        if (this.persistRequested) {
          this.persistRequested = false;
          this.schedulePersist();
        }
      });
  }

  /**
   * Implements flush persist if needed behavior used by `federatedServer`.
   *
   * **Why it exists:**
   * Keeps `flush persist if needed` logic in one place to reduce behavior drift.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   * @returns Promise resolving to void.
   */
  private async flushPersistIfNeeded(): Promise<void> {
    while (this.persistInFlight || this.persistRequested) {
      if (this.persistInFlight) {
        await this.persistInFlight;
        continue;
      }

      this.persistRequested = false;
      await this.persistNow();
    }
  }

  /**
   * Persists now with deterministic state semantics.
   *
   * **Why it exists:**
   * Centralizes now mutations for auditability and replay.
   *
   * **What it talks to:**
   * - Uses `writeFileAtomic` (import `writeFileAtomic`) from `../core/fileLock`.
   * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
   * - Uses `path` (import `default`) from `node:path`.
   * @returns Promise resolving to void.
   */
  private async persistNow(): Promise<void> {
    const document: FederatedResultsStoreDocument = {
      updatedAt: new Date().toISOString(),
      results: [...this.results.values()].sort((left, right) => left.acceptedAt.localeCompare(right.acceptedAt))
    };
    await mkdir(path.dirname(this.resultStorePath), { recursive: true });
    await writeFileAtomic(this.resultStorePath, JSON.stringify(document, null, 2));
  }
}
