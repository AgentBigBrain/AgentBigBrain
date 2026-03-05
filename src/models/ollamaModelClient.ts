/**
 * @fileoverview Ollama-backed model client for local LLM inference with structured JSON output.
 *
 * Implements the ModelClient interface using Ollama's HTTP API at localhost:11434.
 * Enables true offline autonomy — the agent can reason locally with full governance intact.
 *
 * Usage:
 *   BRAIN_MODEL_BACKEND=ollama
 *   OLLAMA_BASE_URL=http://localhost:11434  (default)
 *   OLLAMA_TIMEOUT_MS=60000                 (default 60s, local models are slower)
 *
 * Recommended models:
 *   - llama3.1:8b   — good balance of speed and quality for planning/governors
 *   - mistral:7b    — fast, good for deterministic-heavy governors
 *   - codellama:13b  — code-aware, good for code review governor
 */

import { ModelClient, ModelUsageSnapshot, StructuredCompletionRequest } from "./types";

interface OllamaModelClientOptions {
    baseUrl: string;
    requestTimeoutMs: number;
}

interface OllamaChatResponse {
    message?: {
        content?: string;
    };
    eval_count?: number;
    prompt_eval_count?: number;
}

/**
 * Executes `OllamaModelClient` as part of scope control flow.
 * Local LLM inference client using Ollama's /api/chat endpoint with JSON-mode output.
 */
export class OllamaModelClient implements ModelClient {
    readonly backend = "ollama" as const;

    private usage: ModelUsageSnapshot = {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimatedSpendUsd: 0
    };

    /**
     * Initializes `OllamaModelClient` with deterministic runtime dependencies.
     *
     * **Why it exists:**
     * Captures required dependencies at initialization time so runtime behavior remains explicit.
     *
     * **What it talks to:**
     * - Uses local constants/helpers within this module.
     *
     * @param options - Optional tuning knobs for this operation.
     */
    constructor(private readonly options: OllamaModelClientOptions) { }

    /**
     * Completes json through the configured model/provider path.
     *
     * **Why it exists:**
     * Keeps provider completion behavior for json behind a single typed boundary.
     *
     * **What it talks to:**
     * - Uses `StructuredCompletionRequest` (import `StructuredCompletionRequest`) from `./types`.
     *
     * @param request - Structured input object for this operation.
     * @returns Promise resolving to T.
     */
    async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);

        try {
            const response = await fetch(`${this.options.baseUrl}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: request.model,
                    messages: [
                        { role: "system", content: request.systemPrompt },
                        { role: "user", content: request.userPrompt }
                    ],
                    format: "json",
                    stream: false,
                    options: {
                        temperature: request.temperature ?? 0.7
                    }
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => "unknown error");
                throw new Error(
                    `Ollama request failed with status ${response.status}: ${errorText}`
                );
            }

            const result = (await response.json()) as OllamaChatResponse;

            const promptTokens = result.prompt_eval_count ?? 0;
            const completionTokens = result.eval_count ?? 0;
            this.usage.calls += 1;
            this.usage.promptTokens += promptTokens;
            this.usage.completionTokens += completionTokens;
            this.usage.totalTokens += promptTokens + completionTokens;
            // Ollama runs locally — no API cost
            this.usage.estimatedSpendUsd = 0;

            const content = result.message?.content;
            if (typeof content !== "string" || content.trim().length === 0) {
                throw new Error("Ollama returned empty or missing message content.");
            }

            return JSON.parse(content) as T;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Reads usage snapshot needed for this execution step.
     *
     * **Why it exists:**
     * Separates usage snapshot read-path handling from orchestration and mutation code.
     *
     * **What it talks to:**
     * - Uses `ModelUsageSnapshot` (import `ModelUsageSnapshot`) from `./types`.
     * @returns Computed `ModelUsageSnapshot` result.
     */
    getUsageSnapshot(): ModelUsageSnapshot {
        return { ...this.usage };
    }
}
