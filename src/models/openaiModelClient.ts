/**
 * @fileoverview OpenAI-backed model client for structured JSON completions with provider-usage spend tracking.
 */

import { ModelClient, ModelUsageSnapshot, StructuredCompletionRequest } from "./types";
import { normalizeStructuredModelOutput, validateStructuredModelOutput } from "./schemaValidation";

interface OpenAIChatCompletionChoice {
  message?: {
    content?: string;
  };
}

interface OpenAIChatCompletionResponse {
  choices?: OpenAIChatCompletionChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

interface OpenAITokenPricing {
  inputPer1MUsd: number;
  outputPer1MUsd: number;
}

interface OpenAIModelClientOptions {
  apiKey: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  defaultPricing?: OpenAITokenPricing;
  aliasPricing?: Partial<Record<string, OpenAITokenPricing>>;
}

const OPENAI_MODEL_ALIAS_ENV: Record<string, string> = {
  "small-fast-model": "OPENAI_MODEL_SMALL_FAST",
  "small-policy-model": "OPENAI_MODEL_SMALL_POLICY",
  "medium-general-model": "OPENAI_MODEL_MEDIUM_GENERAL",
  "medium-policy-model": "OPENAI_MODEL_MEDIUM_POLICY",
  "large-reasoning-model": "OPENAI_MODEL_LARGE_REASONING"
};

const OPENAI_MODEL_ALIAS_IDS = new Set(Object.keys(OPENAI_MODEL_ALIAS_ENV));

interface ResolvedOpenAIModel {
  requestedModel: string;
  aliasModel: string | null;
  providerModel: string;
}

interface OpenAIJsonSchemaContract {
  readonly type: "json_schema";
  readonly json_schema: {
    readonly name: string;
    readonly strict: true;
    readonly schema: Record<string, unknown>;
  };
}

interface OpenAIJsonObjectContract {
  readonly type: "json_object";
}

type OpenAIResponseFormatContract = OpenAIJsonSchemaContract | OpenAIJsonObjectContract;

const PLANNER_ACTION_TYPE_VALUES = [
  "respond",
  "read_file",
  "write_file",
  "delete_file",
  "list_directory",
  "create_skill",
  "run_skill",
  "network_write",
  "self_modify",
  "shell_command",
  "memory_mutation",
  "pulse_emit"
] as const;

const GOVERNOR_REJECT_CATEGORY_VALUES = [
  "ABUSE_MALWARE_OR_FRAUD",
  "SECURITY_BOUNDARY",
  "IDENTITY_INTEGRITY",
  "COMPLIANCE_POLICY",
  "RESOURCE_BUDGET",
  "RATIONALE_QUALITY",
  "UTILITY_ALIGNMENT",
  "MODEL_ADVISORY_BLOCK",
  "GOVERNOR_TIMEOUT_OR_FAILURE",
  "GOVERNOR_MALFORMED_VOTE",
  "GOVERNOR_MISSING",
  "OTHER_POLICY"
] as const;

const PLANNER_PARAMS_SCHEMA: Record<string, unknown> = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: []
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        message: { type: "string" }
      },
      required: ["message"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string" }
      },
      required: ["text"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" }
      },
      required: ["path"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        content: { type: "string" }
      },
      required: ["path", "content"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string" }
      },
      required: ["command"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" }
      },
      required: ["name"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        code: { type: "string" }
      },
      required: ["name", "code"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        input: { type: "string" }
      },
      required: ["name", "input"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        endpoint: { type: "string" }
      },
      required: ["endpoint"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string" }
      },
      required: ["url"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        target: { type: "string" }
      },
      required: ["target"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        actorIdentity: { type: "string" }
      },
      required: ["actorIdentity"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        speakerRole: { type: "string" }
      },
      required: ["speakerRole"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        sharePersonalData: { type: "boolean" },
        explicitHumanApproval: { type: "boolean" },
        approvalId: { type: "string" }
      },
      required: ["sharePersonalData", "explicitHumanApproval", "approvalId"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        impersonateHuman: { type: "boolean" }
      },
      required: ["impersonateHuman"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        store: { type: "string", enum: ["entity_graph", "conversation_stack", "pulse_state"] },
        operation: { type: "string", enum: ["upsert", "merge", "supersede", "resolve", "evict"] },
        payload: {
          type: "object",
          additionalProperties: false,
          properties: {},
          required: []
        }
      },
      required: ["store", "operation", "payload"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          enum: ["bridge_question", "open_loop_resume", "topic_resume", "stale_fact_revalidation"]
        },
        reasonCode: { type: "string" }
      },
      required: ["kind", "reasonCode"]
    }
  ]
};

const OPENAI_SCHEMA_CONTRACTS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  planner_v1: {
    type: "object",
    additionalProperties: false,
    properties: {
      plannerNotes: { type: "string" },
      actions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: [...PLANNER_ACTION_TYPE_VALUES] },
            description: { type: "string" },
            params: PLANNER_PARAMS_SCHEMA
          },
          required: ["type", "description", "params"]
        }
      }
    },
    required: ["plannerNotes", "actions"]
  },
  response_v1: {
    type: "object",
    additionalProperties: false,
    properties: {
      message: { type: "string" }
    },
    required: ["message"]
  },
  reflection_v1: {
    type: "object",
    additionalProperties: false,
    properties: {
      lessons: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["lessons"]
  },
  reflection_success_v1: {
    type: "object",
    additionalProperties: false,
    properties: {
      lesson: { type: "string" },
      nearMiss: {
        anyOf: [{ type: "string" }, { type: "null" }]
      }
    },
    required: ["lesson", "nearMiss"]
  },
  governor_v1: {
    type: "object",
    additionalProperties: false,
    properties: {
      approve: { type: "boolean" },
      reason: { type: "string" },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1
      },
      rejectCategory: {
        type: "string",
        enum: [...GOVERNOR_REJECT_CATEGORY_VALUES]
      }
    },
    required: ["approve", "reason", "confidence"]
  },
  autonomous_next_step_v1: {
    type: "object",
    additionalProperties: false,
    properties: {
      isGoalMet: { type: "boolean" },
      nextUserInput: { type: "string" },
      reasoning: { type: "string" }
    },
    required: ["isGoalMet", "nextUserInput", "reasoning"]
  },
  proactive_goal_v1: {
    type: "object",
    additionalProperties: false,
    properties: {
      proactiveGoal: { type: "string" },
      reasoning: { type: "string" }
    },
    required: ["proactiveGoal", "reasoning"]
  },
  intent_interpretation_v1: {
    type: "object",
    additionalProperties: false,
    properties: {
      intentType: { type: "string", enum: ["pulse_control", "none"] },
      mode: {
        anyOf: [
          {
            type: "string",
            enum: ["on", "off", "private", "public", "status"]
          },
          { type: "null" }
        ]
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1
      },
      rationale: { type: "string" }
    },
    required: ["intentType", "mode", "confidence", "rationale"]
  }
});

/**
 * Sanitizes schema names for OpenAI `response_format.json_schema.name` constraints.
 *
 * **Why it exists:**
 * OpenAI schema names must stay short and ASCII-safe; planner schema ids may include
 * unsupported characters.
 *
 * **What it talks to:**
 * - Local regex/length guards only.
 *
 * @param schemaName - Internal schema id requested by the caller.
 * @returns Safe schema name to send to the provider API.
 */
function sanitizeSchemaContractName(schemaName: string): string {
  const normalized = schemaName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return normalized.length > 0 ? normalized : "schema_contract";
}

/**
 * Builds the provider `response_format` contract for a known schema.
 *
 * **Why it exists:**
 * Ensures all model completions request structured output in a deterministic way. Unknown
 * schemas fall back to `json_object` instead of sending an invalid contract.
 *
 * **What it talks to:**
 * - `OPENAI_SCHEMA_CONTRACTS` registry.
 * - `sanitizeSchemaContractName` for provider-compatible schema ids.
 *
 * @param schemaName - Requested logical schema name.
 * @returns OpenAI response-format contract used in the chat completion request body.
 */
function buildOpenAIResponseFormatContract(schemaName: string): OpenAIResponseFormatContract {
  const contractSchema = OPENAI_SCHEMA_CONTRACTS[schemaName];
  if (!contractSchema) {
    return { type: "json_object" };
  }

  return {
    type: "json_schema",
    json_schema: {
      name: sanitizeSchemaContractName(schemaName),
      strict: true,
      schema: contractSchema
    }
  };
}

/**
 * Resolves a safe provider model fallback when an alias env override is missing.
 *
 * **Why it exists:**
 * Alias labels are used across the codebase; this function defines the deterministic fallback
 * model instead of scattering defaults.
 *
 * **What it talks to:**
 * - `OPENAI_MODEL_ALIAS_ENV` alias registry.
 *
 * @param alias - Requested model alias (for example `small-fast-model`).
 * @returns Provider model id to use for that alias.
 */
function defaultOpenAIModelForAlias(alias: string): string {
  if (Object.prototype.hasOwnProperty.call(OPENAI_MODEL_ALIAS_ENV, alias)) {
    // Keep defaults broadly compatible; deployments can override per-tier via env.
    return "gpt-4o-mini";
  }

  return alias;
}

/**
 * Resolves logical model labels into concrete provider model ids.
 *
 * **Why it exists:**
 * Planner/governor/executor code refers to stable alias names, while provider calls need
 * concrete model ids and optional env-based overrides.
 *
 * **What it talks to:**
 * - `OPENAI_MODEL_ALIAS_ENV` for alias-to-env mapping.
 * - Process environment (`OPENAI_MODEL_*`) for deployment-specific overrides.
 * - `defaultOpenAIModelForAlias` fallback policy.
 *
 * @param modelLabel - Model label selected by routing logic.
 * @returns Requested alias context plus final provider model id.
 */
function resolveOpenAIModel(modelLabel: string): ResolvedOpenAIModel {
  const envKey = OPENAI_MODEL_ALIAS_ENV[modelLabel];
  if (!envKey) {
    return {
      requestedModel: modelLabel,
      aliasModel: null,
      providerModel: modelLabel
    };
  }

  const envModel = process.env[envKey];
  if (typeof envModel === "string" && envModel.trim().length > 0) {
    return {
      requestedModel: modelLabel,
      aliasModel: modelLabel,
      providerModel: envModel.trim()
    };
  }

  return {
    requestedModel: modelLabel,
    aliasModel: modelLabel,
    providerModel: defaultOpenAIModelForAlias(modelLabel)
  };
}

/**
 * Extracts the first JSON object from model text content.
 *
 * **Why it exists:**
 * Some providers wrap JSON with extra text; this isolates the defensive extraction logic
 * before schema validation.
 *
 * **What it talks to:**
 * - Local string parsing only.
 *
 * @param content - Raw assistant message content from provider response.
 * @returns JSON object string ready for `JSON.parse`.
 */
function extractJsonPayload(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }

  throw new Error("Model response did not contain a JSON object.");
}

/**
 * Wraps an async operation with a hard timeout and caller-provided timeout side effect.
 *
 * **Why it exists:**
 * Provider requests must fail deterministically under deadline pressure.
 *
 * **What it talks to:**
 * - Node.js timer primitives.
 * - Caller timeout callback (used to abort fetch requests).
 *
 * @param promise - Underlying async operation to race against the timeout.
 * @param timeoutMs - Deadline in milliseconds.
 * @param onTimeout - Callback invoked just before timeout rejection.
 * @returns Original promise result when completed before the deadline.
 */
async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => {
      try {
        onTimeout();
      } finally {
        reject(new Error(`OpenAI request timed out after ${timeoutMs}ms.`));
      }
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(handle);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(handle);
        reject(error);
      });
  });
}

/**
 * Normalizes provider token metrics to non-negative integer counts.
 *
 * **Why it exists:**
 * Usage fields can be missing, fractional, or malformed; spend accounting should remain safe.
 *
 * **What it talks to:**
 * - Local numeric guards only.
 *
 * @param value - Raw token metric from provider payload.
 * @returns Floor-rounded token count, or `0` when invalid.
 */
function safeTokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * Estimates USD spend from prompt/completion token counts and pricing.
 *
 * **Why it exists:**
 * Runtime budget policy depends on deterministic spend estimation from provider usage data.
 *
 * **What it talks to:**
 * - `OpenAITokenPricing` values configured for aliases/defaults.
 *
 * @param promptTokens - Prompt token count for the request.
 * @param completionTokens - Completion token count for the response.
 * @param pricing - Per-1M token input/output price configuration.
 * @returns Rounded spend estimate in USD.
 */
function estimateSpendUsd(
  promptTokens: number,
  completionTokens: number,
  pricing: OpenAITokenPricing
): number {
  const inputCost = (promptTokens / 1_000_000) * pricing.inputPer1MUsd;
  const outputCost = (completionTokens / 1_000_000) * pricing.outputPer1MUsd;
  return Number((inputCost + outputCost).toFixed(8));
}

export class OpenAIModelClient implements ModelClient {
  readonly backend = "openai" as const;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly defaultPricing: OpenAITokenPricing;
  private readonly aliasPricing: Partial<Record<string, OpenAITokenPricing>>;
  private usage: ModelUsageSnapshot = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedSpendUsd: 0
  };

  /**
   * Configures provider endpoint, timeout policy, and pricing tables for usage tracking.
   *
   * **Why it exists:**
   * All OpenAI request behavior should be defined once at client construction time.
   *
   * **What it talks to:**
   * - Constructor options passed by model-client bootstrap code.
   *
   * @param options - API key plus optional endpoint/timeout/pricing overrides.
   */
  constructor(private readonly options: OpenAIModelClientOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 15_000);
    this.defaultPricing = options.defaultPricing ?? {
      inputPer1MUsd: 0,
      outputPer1MUsd: 0
    };
    this.aliasPricing = options.aliasPricing ?? {};
  }

  /**
   * Returns a copy of aggregated provider-usage telemetry for this client instance.
   *
   * **Why it exists:**
   * Orchestrator/task-runner budget checks need read-only usage snapshots between task phases.
   *
   * **What it talks to:**
   * - Local `usage` accumulator state.
   *
   * @returns Copy of current model-usage counters and estimated spend.
   */
  getUsageSnapshot(): ModelUsageSnapshot {
    return { ...this.usage };
  }

  /**
   * Chooses which token-pricing table applies to a resolved model selection.
   *
   * **Why it exists:**
   * Usage accounting supports alias-specific pricing while keeping a deterministic default path.
   *
   * **What it talks to:**
   * - `aliasPricing` overrides set in constructor options.
   * - `defaultPricing` fallback values.
   *
   * @param model - Resolved provider model metadata for the request.
   * @returns Pricing record used to estimate spend for this call.
   */
  private resolvePricing(model: ResolvedOpenAIModel): OpenAITokenPricing {
    if (model.aliasModel && this.aliasPricing[model.aliasModel]) {
      return this.aliasPricing[model.aliasModel] as OpenAITokenPricing;
    }

    if (OPENAI_MODEL_ALIAS_IDS.has(model.requestedModel)) {
      return this.defaultPricing;
    }

    return this.defaultPricing;
  }

  /**
   * Updates cumulative usage and spend metrics from a provider response.
   *
   * **Why it exists:**
   * Centralized accounting keeps budget enforcement and trace reporting consistent.
   *
   * **What it talks to:**
   * - Provider `usage` payload fields.
   * - `resolvePricing` and `estimateSpendUsd`.
   * - Local `usage` accumulator state.
   *
   * @param payload - Parsed OpenAI chat completion response payload.
   * @param model - Resolved model metadata used for pricing lookup.
   */
  private trackUsage(payload: OpenAIChatCompletionResponse, model: ResolvedOpenAIModel): void {
    const promptTokens = safeTokenCount(payload.usage?.prompt_tokens);
    const completionTokens = safeTokenCount(payload.usage?.completion_tokens);
    const totalTokens = safeTokenCount(payload.usage?.total_tokens) || promptTokens + completionTokens;
    const pricing = this.resolvePricing(model);
    const estimatedSpendUsd = estimateSpendUsd(promptTokens, completionTokens, pricing);

    this.usage.calls += 1;
    this.usage.promptTokens += promptTokens;
    this.usage.completionTokens += completionTokens;
    this.usage.totalTokens += totalTokens;
    this.usage.estimatedSpendUsd = Number((this.usage.estimatedSpendUsd + estimatedSpendUsd).toFixed(8));
  }

  /**
   * Executes a structured JSON completion against OpenAI and validates the result.
   *
   * **Why it exists:**
   * Provides one governed adapter boundary from internal structured prompts to provider output.
   *
   * **What it talks to:**
   * - OpenAI `chat/completions` endpoint via `fetch`.
   * - Timeout/abort control via `withDeadline` and `AbortController`.
   * - Schema normalization/validation via `normalizeStructuredModelOutput` and
   *   `validateStructuredModelOutput`.
   * - Usage telemetry accumulation via `trackUsage`.
   *
   * @param request - Structured completion request (prompts, schema name, model, temperature).
   * @returns Parsed and schema-validated JSON payload typed as `T`.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    const abortController = new AbortController();
    const resolvedModel = resolveOpenAIModel(request.model);
    const response = await withDeadline(
      fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: resolvedModel.providerModel,
          temperature: request.temperature ?? 0,
          response_format: buildOpenAIResponseFormatContract(request.schemaName),
          messages: [
            {
              role: "system",
              content: `${request.systemPrompt}\nReturn only valid JSON for schema ${request.schemaName}.`
            },
            {
              role: "user",
              content: request.userPrompt
            }
          ]
        }),
        signal: abortController.signal
      }),
      this.requestTimeoutMs,
      () => abortController.abort()
    );

    const payload = (await response.json()) as OpenAIChatCompletionResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `OpenAI request failed with ${response.status}.`);
    }

    this.trackUsage(payload, resolvedModel);

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI response was missing message content.");
    }

    const jsonPayload = extractJsonPayload(content);
    const parsed = JSON.parse(jsonPayload) as unknown;
    const normalized = normalizeStructuredModelOutput(request.schemaName, parsed);
    validateStructuredModelOutput(request.schemaName, normalized);
    return normalized as T;
  }
}
