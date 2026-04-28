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

import { resolveOllamaModel } from "./ollama/modelResolution";
import { isKnownModelSchemaName } from "./schema/contracts";
import { buildJsonSchemaForKnownModelSchema } from "./schema/jsonSchemas";
import {
    normalizeStructuredModelOutput,
    validateStructuredModelOutput
} from "./schemaValidation";
import { ModelClient, ModelUsageSnapshot, StructuredCompletionRequest } from "./types";

const STRUCTURED_JSON_ATTEMPT_COUNT = 2;

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
 * Reduces provider parse/validation failures to a prompt-safe diagnostic string.
 *
 * @param error - Error thrown while parsing or validating structured output.
 * @returns Short diagnostic for a bounded retry prompt.
 */
function formatStructuredJsonFailure(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message.trim().slice(0, 240);
    }
    return "Structured JSON output was invalid.";
}

/**
 * Builds a retry prompt that asks the local model for fresh structured JSON.
 *
 * @param request - Original structured completion request.
 * @param previousError - Previous parse or schema validation failure.
 * @returns Prompt pair for the retry attempt.
 */
function buildStructuredJsonRetryPrompt(
    request: StructuredCompletionRequest,
    previousError: unknown
): { systemPrompt: string; userPrompt: string } {
    return {
        systemPrompt:
            `${request.systemPrompt}\n\n` +
            "The previous response was rejected before execution because it was not valid " +
            `${request.schemaName} JSON. Return exactly one JSON object. Do not include Markdown, ` +
            "comments, prose before the object, prose after the object, or trailing commas.",
        userPrompt: JSON.stringify({
            retryInstruction:
                "Produce a fresh valid JSON object for the original request and schema.",
            schemaName: request.schemaName,
            previousError: formatStructuredJsonFailure(previousError),
            originalUserPrompt: request.userPrompt
        })
    };
}

/**
 * Parses and validates one provider JSON payload at the model boundary.
 *
 * @param request - Original structured request.
 * @param content - Provider response content.
 * @returns Normalized structured payload.
 */
function parseStructuredJsonContent<T>(
    request: StructuredCompletionRequest,
    content: string
): T {
    const parsed = JSON.parse(content) as unknown;
    const normalized = normalizeStructuredModelOutput(request.schemaName, parsed);
    validateStructuredModelOutput(request.schemaName, normalized);
    return normalized as T;
}

/**
 * Resolves the strongest JSON format contract Ollama can accept for a structured request.
 *
 * @param schemaName - Requested model-output schema name.
 * @returns JSON schema object for known schemas, or JSON mode for compatibility.
 */
function resolveOllamaStructuredFormat(schemaName: string): unknown {
    if (isKnownModelSchemaName(schemaName)) {
        return buildJsonSchemaForKnownModelSchema(schemaName);
    }
    return "json";
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
        billingMode: "local",
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
        const resolvedModel = resolveOllamaModel(request.model);
        let lastStructuredJsonError: unknown = null;

        for (let attemptIndex = 0; attemptIndex < STRUCTURED_JSON_ATTEMPT_COUNT; attemptIndex += 1) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
            const prompt =
                attemptIndex === 0
                    ? {
                        systemPrompt: request.systemPrompt,
                        userPrompt: request.userPrompt
                    }
                    : buildStructuredJsonRetryPrompt(request, lastStructuredJsonError);

            try {
            const response = await fetch(`${this.options.baseUrl}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: resolvedModel.providerModel,
                    messages: [
                        { role: "system", content: prompt.systemPrompt },
                        { role: "user", content: prompt.userPrompt }
                    ],
                        format: resolveOllamaStructuredFormat(request.schemaName),
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

                try {
                    return parseStructuredJsonContent<T>(request, content);
                } catch (error) {
                    lastStructuredJsonError = error;
                    if (attemptIndex < STRUCTURED_JSON_ATTEMPT_COUNT - 1) {
                        continue;
                    }
                    throw new Error(
                        `Ollama returned invalid structured JSON for ${request.schemaName} after ` +
                        `${STRUCTURED_JSON_ATTEMPT_COUNT} attempt(s): ${formatStructuredJsonFailure(error)}`
                    );
                }
            } finally {
                clearTimeout(timeoutId);
            }
        }

        throw new Error(
            `Ollama returned invalid structured JSON for ${request.schemaName}: ` +
            formatStructuredJsonFailure(lastStructuredJsonError)
        );
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
