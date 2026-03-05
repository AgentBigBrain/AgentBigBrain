/**
 * @fileoverview Federation HTTP client for submitting task requests and polling async task results.
 */

import type {
  FederatedDelegationDecision,
  FederatedInboundTask
} from "../core/federatedDelegation";
import type { FederatedTaskResult, FederatedTaskStatus } from "./federatedServer";

export type { FederatedTaskResult, FederatedTaskStatus };

export interface FederatedAgentAuth {
  externalAgentId: string;
  sharedSecret: string;
}

export interface FederatedHttpClientOptions {
  /** Base URL of the remote federation server, for example http://localhost:9100 */
  baseUrl: string;
  /** Request timeout in milliseconds. Default: 10000. */
  timeoutMs?: number;
  /** Optional default credentials used for result polling endpoints. */
  auth?: FederatedAgentAuth;
}

export interface FederatedDelegateResult {
  ok: boolean;
  decision: FederatedDelegationDecision | null;
  taskId: string | null;
  error: string | null;
  httpStatus: number;
}

export interface FederatedPollResult {
  ok: boolean;
  result: FederatedTaskResult | null;
  error: string | null;
}

export interface AwaitResultOptions {
  /** Poll interval in milliseconds. Default: 500. */
  pollIntervalMs?: number;
  /** Maximum time to wait in milliseconds. Default: 30000. */
  timeoutMs?: number;
  /** Optional per-call auth override. */
  auth?: FederatedAgentAuth;
}

export interface FederatedHealthResult {
  healthy: boolean;
  error: string | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const AUTH_AGENT_ID_HEADER = "x-federation-agent-id";
const AUTH_SECRET_HEADER = "x-federation-shared-secret";

/**
 * Converts values into error message form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for error message deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param error - Value for error.
 * @returns Resulting string value.
 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

export class FederatedHttpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly auth: FederatedAgentAuth | null;

  /**
   * Initializes `FederatedHttpClient` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param options - Optional tuning knobs for this operation.
   */
  constructor(options: FederatedHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.auth = options.auth ?? null;
  }

  /**
   * Resolves auth from available runtime context.
   *
   * **Why it exists:**
   * Prevents divergent selection of auth by keeping rules in one function.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param authOverride - Stable identifier used to reference an entity or record.
   * @returns Computed `FederatedAgentAuth | null` result.
   */
  private resolveAuth(authOverride?: FederatedAgentAuth): FederatedAgentAuth | null {
    const auth = authOverride ?? this.auth;
    if (!auth || !auth.externalAgentId.trim() || !auth.sharedSecret) {
      return null;
    }
    return auth;
  }

  /**
   * Implements delegate behavior used by `federatedClient`.
   *
   * **Why it exists:**
   * Keeps `delegate` behavior centralized so collaborating call sites stay consistent.
   *
   * **What it talks to:**
   * - Uses `FederatedDelegationDecision` (import `FederatedDelegationDecision`) from `../core/federatedDelegation`.
   * - Uses `FederatedInboundTask` (import `FederatedInboundTask`) from `../core/federatedDelegation`.
   *
   * @param task - Value for task.
   * @param authOverride - Stable identifier used to reference an entity or record.
   * @returns Promise resolving to FederatedDelegateResult.
   */
  async delegate(
    task: FederatedInboundTask,
    authOverride?: FederatedAgentAuth
  ): Promise<FederatedDelegateResult> {
    const auth = this.resolveAuth(authOverride);
    if (!auth) {
      return {
        ok: false,
        decision: null,
        taskId: null,
        error: "Missing federation auth credentials for delegate request.",
        httpStatus: 0
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/federation/delegate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [AUTH_AGENT_ID_HEADER]: auth.externalAgentId,
          [AUTH_SECRET_HEADER]: auth.sharedSecret
        },
        body: JSON.stringify(task),
        signal: controller.signal
      });

      const body = (await response.json()) as {
        ok?: boolean;
        decision?: FederatedDelegationDecision;
        taskId?: string;
        error?: string;
      };

      return {
        ok: body.ok === true,
        decision: body.decision ?? null,
        taskId: body.taskId ?? null,
        error: body.error ?? null,
        httpStatus: response.status
      };
    } catch (error) {
      const message = toErrorMessage(error);
      return {
        ok: false,
        decision: null,
        taskId: null,
        error: message.toLowerCase().includes("abort") ? "Request timed out" : message,
        httpStatus: 0
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Implements health behavior used by `federatedClient`.
   *
   * **Why it exists:**
   * Keeps `health` logic in one place to reduce behavior drift.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   * @returns Promise resolving to FederatedHealthResult.
   */
  async health(): Promise<FederatedHealthResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/federation/health`, {
        method: "GET",
        signal: controller.signal
      });

      if (response.ok) {
        return { healthy: true, error: null };
      }

      return { healthy: false, error: `HTTP ${response.status}` };
    } catch (error) {
      return { healthy: false, error: toErrorMessage(error) };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Implements poll result behavior used by `federatedClient`.
   *
   * **Why it exists:**
   * Keeps `poll result` behavior centralized so collaborating call sites stay consistent.
   *
   * **What it talks to:**
   * - Uses `FederatedTaskResult` (import `FederatedTaskResult`) from `./federatedServer`.
   *
   * @param taskId - Stable identifier used to reference an entity or record.
   * @param authOverride - Stable identifier used to reference an entity or record.
   * @returns Promise resolving to FederatedPollResult.
   */
  async pollResult(taskId: string, authOverride?: FederatedAgentAuth): Promise<FederatedPollResult> {
    const auth = this.resolveAuth(authOverride);
    if (!auth) {
      return {
        ok: false,
        result: null,
        error: "Missing federation auth credentials for result polling."
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(
        `${this.baseUrl}/federation/results/${encodeURIComponent(taskId)}`,
        {
          method: "GET",
          headers: {
            [AUTH_AGENT_ID_HEADER]: auth.externalAgentId,
            [AUTH_SECRET_HEADER]: auth.sharedSecret
          },
          signal: controller.signal
        }
      );

      const body = (await response.json()) as {
        ok?: boolean;
        result?: FederatedTaskResult;
        error?: string;
      };

      return {
        ok: body.ok === true,
        result: body.result ?? null,
        error: body.error ?? null
      };
    } catch (error) {
      const message = toErrorMessage(error);
      return {
        ok: false,
        result: null,
        error: message.toLowerCase().includes("abort") ? "Request timed out" : message
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Implements await result behavior used by `federatedClient`.
   *
   * **Why it exists:**
   * Keeps `await result` logic in one place to reduce behavior drift.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param taskId - Stable identifier used to reference an entity or record.
   * @param options - Optional tuning knobs for this operation.
   * @returns Promise resolving to FederatedPollResult.
   */
  async awaitResult(taskId: string, options?: AwaitResultOptions): Promise<FederatedPollResult> {
    const pollInterval = options?.pollIntervalMs ?? 500;
    const timeout = options?.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const poll = await this.pollResult(taskId, options?.auth);

      if (!poll.ok) {
        return poll;
      }
      if (poll.result && poll.result.status !== "pending") {
        return poll;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, pollInterval));
    }

    return {
      ok: false,
      result: null,
      error: `Timed out waiting for task ${taskId} after ${timeout}ms`
    };
  }
}
