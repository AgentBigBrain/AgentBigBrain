/**
 * @fileoverview Codex-backed model client using the local Codex CLI auth/session state.
 */

import os from "node:os";
import path from "node:path";

import type { ModelClient, ModelUsageSnapshot, StructuredCompletionRequest } from "./types";
import { completeCodexJsonRequest } from "./codex/clientRuntime";
import { readCodexAuthStatus } from "./codex/authStore";
import { resolveCodexModel } from "./codex/modelResolution";

export interface CodexModelClientOptions {
  requestTimeoutMs?: number;
  isolatedWorkingDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

export class CodexModelClient implements ModelClient {
  readonly backend = "codex_oauth" as const;
  private readonly requestTimeoutMs: number;
  private readonly isolatedWorkingDirectory: string;
  private readonly env: NodeJS.ProcessEnv;
  private usage: ModelUsageSnapshot = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    billingMode: "subscription_quota",
    estimatedSpendUsd: 0
  };

  /**
   * Configures Codex CLI runtime settings for structured model turns.
   *
   * @param options - Timeout, working-directory, and environment overrides.
   */
  constructor(options: CodexModelClientOptions = {}) {
    this.requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 180_000);
    this.isolatedWorkingDirectory = path.resolve(
      options.isolatedWorkingDirectory ?? os.tmpdir()
    );
    this.env = options.env ?? process.env;
  }

  /**
   * Ensures Codex auth is available before dispatching a structured request.
   */
  private async assertAuthReady(): Promise<void> {
    const status = await readCodexAuthStatus(this.env);
    if (!status.available) {
      throw new Error(
        "BRAIN_MODEL_BACKEND=codex_oauth requested but Codex auth is not available. " +
        "Run `tsx src/index.ts auth codex login` or sign in through the Codex app first."
      );
    }
  }

  /**
   * Returns a copy of cumulative token-usage telemetry for this client instance.
   *
   * @returns Snapshot of current call counts, token counts, and billing mode.
   */
  getUsageSnapshot(): ModelUsageSnapshot {
    return { ...this.usage };
  }

  /**
   * Executes a structured JSON completion against the local Codex CLI runtime.
   *
   * @param request - Structured completion request routed through the model client.
   * @returns Parsed and validated structured output typed as `T`.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    await this.assertAuthReady();
    const resolvedModel = resolveCodexModel(request.model, this.env);
    const result = await completeCodexJsonRequest<T>(
      {
        requestTimeoutMs: this.requestTimeoutMs,
        workingDirectory: this.isolatedWorkingDirectory,
        env: this.env
      },
      resolvedModel,
      request
    );

    this.usage.calls += 1;
    if (result.turn.usage) {
      const promptTokens = Math.max(
        0,
        result.turn.usage.inputTokens + result.turn.usage.cachedInputTokens
      );
      const completionTokens = Math.max(0, result.turn.usage.outputTokens);
      this.usage.promptTokens += promptTokens;
      this.usage.completionTokens += completionTokens;
      this.usage.totalTokens += promptTokens + completionTokens;
    }

    return result.output;
  }
}
