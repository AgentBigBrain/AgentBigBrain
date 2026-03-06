/**
 * @fileoverview Deterministic mock model backend for local development and CI testing.
 */

import { extractActiveRequestSegment } from "../core/currentRequestExtraction";
import { ActionType } from "../core/types";
import { estimateActionCostUsd } from "../core/actionCostPolicy";
import {
  AutonomousNextStepModelOutput,
  GovernorModelOutput,
  IntentInterpretationModelOutput,
  ModelClient,
  ModelUsageSnapshot,
  PlannerModelOutput,
  ProactiveGoalModelOutput,
  ResponseSynthesisModelOutput,
  ReflectionModelOutput,
  SuccessReflectionModelOutput,
  StructuredCompletionRequest
} from "./types";
import { normalizeStructuredModelOutput, validateStructuredModelOutput } from "./schemaValidation";

const HIGH_RISK_SELF_EDIT_HINTS = [
  "change governor",
  "rewrite governor",
  "update constitution",
  "modify dna",
  "disable safety",
  "override"
];
const MOCK_BUILD_EXECUTION_VERB_PATTERN =
  /\b(create|build|make|generate|scaffold|setup|set up|spin up)\b/i;
const MOCK_BUILD_EXECUTION_TARGET_PATTERN =
  /\b(app|application|project|dashboard|site|website|frontend|backend|api|cli|repo|repository|react|next\.?js|vue|svelte|angular|vite)\b/i;
const MOCK_BUILD_EXECUTION_DESTINATION_PATTERN =
  /\bon\s+my\s+(desktop|documents|downloads)\b|\bin\s+['"]?[a-z]:\\|\bin\s+['"]?\/(?:users|home|tmp|var|opt)\//i;
const MOCK_ROUTED_BUILD_PATTERNS: readonly RegExp[] = [
  /\bbuild\b.*\btypescript\b.*\bcli\b/i,
  /\bdeterministic\s+typescript\s+cli\s+scaffold\b/i,
  /\bscaffold\b/i,
  /\brunbook\b/i
] as const;
const MOCK_BUILD_EXPLANATION_ONLY_PATTERN =
  /^\s*(how\s+do\s+i|how\s+to|explain|show\s+me\s+how|tutorial|guide\s+me|what\s+is)\b|\b(without\s+executing|do\s+not\s+execute|don't\s+execute|guidance\s+only|instructions?\s+only)\b/i;

const ACTION_TYPES: ActionType[] = [
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
  "start_process",
  "check_process",
  "stop_process",
  "probe_port",
  "probe_http",
  "verify_browser"
];

/**
 * Evaluates action type and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the action type policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `ActionType` (import `ActionType`) from `../core/types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is ActionType` result.
 */
function isActionType(value: string): value is ActionType {
  return ACTION_TYPES.includes(value as ActionType);
}

/**
 * Parses json object and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for json object so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `Record<string, unknown>` result.
 */
function parseJsonObject(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through and return empty object.
  }

  return {};
}

/**
 * Converts values into string form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for string deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Resolves the active user request from structured mock-model input.
 *
 * **Why it exists:**
 * Keeps mock planner and response-synthesis behavior aligned with the wrapped interface payloads
 * used in production so tests evaluate the newest user turn instead of stale conversation context.
 *
 * **What it talks to:**
 * - Uses `extractActiveRequestSegment` (import `extractActiveRequestSegment`) from `../core/currentRequestExtraction`.
 * - Uses `asString` from this module.
 *
 * @param input - Parsed structured model input object.
 * @param fallbackPrompt - Raw prompt fallback used when no structured user input is present.
 * @returns Active request text used for deterministic mock intent matching.
 */
function resolveActiveMockUserInput(
  input: Record<string, unknown>,
  fallbackPrompt: string
): string {
  const currentUserRequest = asString(input.currentUserRequest).trim();
  if (currentUserRequest.length > 0) {
    return currentUserRequest;
  }

  const structuredUserInput = asString(input.userInput).trim();
  if (structuredUserInput.length > 0) {
    const activeRequest = extractActiveRequestSegment(structuredUserInput);
    return activeRequest.length > 0 ? activeRequest : structuredUserInput;
  }

  return fallbackPrompt;
}

/**
 * Evaluates any and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the any policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @param patterns - Value for patterns.
 * @returns `true` when this check passes.
 */
function includesAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

/**
 * Evaluates generic build-execution request and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps mock planner behavior aligned with real planner policy so CI and local dry runs exercise
 * execution-style build flows with non-respond actions instead of collapsing back to guidance-only
 * output.
 *
 * **What it talks to:**
 * - Uses local deterministic lexical patterns within this module.
 *
 * @param userInput - Raw user input text passed to the mock planner.
 * @returns `true` when the request looks like an execution-style build goal.
 */
function isMockExecutionStyleBuildRequest(userInput: string): boolean {
  if (MOCK_BUILD_EXPLANATION_ONLY_PATTERN.test(userInput)) {
    return false;
  }
  if (MOCK_ROUTED_BUILD_PATTERNS.some((pattern) => pattern.test(userInput))) {
    return true;
  }
  if (!MOCK_BUILD_EXECUTION_VERB_PATTERN.test(userInput)) {
    return false;
  }
  if (!MOCK_BUILD_EXECUTION_TARGET_PATTERN.test(userInput)) {
    return false;
  }
  return (
    MOCK_BUILD_EXECUTION_DESTINATION_PATTERN.test(userInput) ||
    /\bexecute\s+now\b/i.test(userInput) ||
    /\brun\s+(?:it|commands?)\b/i.test(userInput)
  );
}

/**
 * Evaluates whether a build request explicitly asks for live-run verification.
 *
 * **Why it exists:**
 * Lets the mock planner exercise managed-process plus readiness-probe planning paths when tests or
 * local runs ask to start and verify an app instead of only scaffolding it.
 *
 * **What it talks to:**
 * - Uses `isMockExecutionStyleBuildRequest` from this module.
 * - Uses local deterministic lexical patterns within this module.
 *
 * @param userInput - Raw user input text passed to the mock planner.
 * @returns `true` when live verification is explicitly requested.
 */
function isMockLiveVerificationBuildRequest(userInput: string): boolean {
  if (!isMockExecutionStyleBuildRequest(userInput)) {
    return false;
  }
  return (
    /\bnpm\s+start\b/i.test(userInput) ||
    /\bnpm\s+run\s+dev\b/i.test(userInput) ||
    /\b(?:pnpm|yarn)\s+(?:start|dev)\b/i.test(userInput) ||
    /\b(?:next|vite)\s+dev\b/i.test(userInput) ||
    /\bdev\s+server\b/i.test(userInput) ||
    /\b(run|start|launch|open)\b[\s\S]{0,80}\b(app|site|server|project|frontend)\b/i.test(
      userInput
    ) ||
    /\bverify\b[\s\S]{0,80}\b(ui|homepage|browser|render|renders|rendering)\b/i.test(
      userInput
    ) ||
    /\bopen\b[\s\S]{0,80}\bbrowser\b/i.test(userInput)
  );
}

/**
 * Evaluates whether a build request explicitly asks for browser or UI proof.
 *
 * **Why it exists:**
 * Lets the mock planner exercise the browser-verification action path so CI covers stronger live
 * app verification instead of stopping at port readiness.
 *
 * **What it talks to:**
 * - Uses `isMockLiveVerificationBuildRequest` from this module.
 * - Uses local deterministic lexical patterns within this module.
 *
 * @param userInput - Raw user input text passed to the mock planner.
 * @returns `true` when browser/UI proof is explicitly requested.
 */
function isMockBrowserVerificationBuildRequest(userInput: string): boolean {
  if (!isMockLiveVerificationBuildRequest(userInput)) {
    return false;
  }
  return /\bverify\b[\s\S]{0,80}\b(ui|homepage|browser|render|renders|rendering)\b/i.test(
    userInput
  );
}

/**
 * Builds planner output for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of planner output consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `estimateActionCostUsd` (import `estimateActionCostUsd`) from `../core/actionCostPolicy`.
 * - Uses `ActionType` (import `ActionType`) from `../core/types`.
 * - Uses `PlannerModelOutput` (import `PlannerModelOutput`) from `./types`.
 *
 * @param userPrompt - Message/text content processed by this function.
 * @returns Computed `PlannerModelOutput` result.
 */
function buildPlannerOutput(userPrompt: string): PlannerModelOutput {
  const input = parseJsonObject(userPrompt);
  const userInput = resolveActiveMockUserInput(input, userPrompt);
  const text = userInput.toLowerCase();
  const actions: PlannerModelOutput["actions"] = [];

  /**
   * Appends one synthetic planner action with deterministic mock cost metadata.
   *
   * **Why it exists:**
   * The mock planner emits multiple rule-triggered actions. This helper keeps action construction
   * consistent so tests and local dry runs get stable payload and pricing fields.
   *
   * **What it talks to:**
   * - Appends to local `actions`.
   * - Calls `estimateActionCostUsd(...)` for cost estimates.
   *
   * @param type - Action type to emit in mock planner output.
   * @param description - Human-readable intent description for the action.
   * @param params - Action parameter payload.
   */
  const pushAction = (
    type: ActionType,
    description: string,
    params: Record<string, unknown> = {}
  ): void => {
    actions.push({
      type,
      description,
      params,
      estimatedCostUsd: estimateActionCostUsd({ type, params })
    });
  };

  if (text.includes("delete ") || text.includes("remove ")) {
    const pathMatch = userInput.match(/(?:delete|remove)\s+([^\s]+)/i);
    pushAction("delete_file", "Delete a target file path requested by user.", {
      path: pathMatch?.[1] ?? "runtime/sandbox/placeholder.txt"
    });
  }

  if (text.includes("write file") || text.includes("save this")) {
    const pathMatch =
      userInput.match(/(?:write\s+file|save\s+(?:this\s+)?file)\s+([^\s"'`]+)/i) ??
      userInput.match(/(?:to|at)\s+([^\s"'`]+)/i);
    const quotedContentMatch = userInput.match(
      /(?:with\s+content|content\s*[:=])\s*(['"`])([\s\S]*?)\1/i
    );
    const inlineContentMatch = userInput.match(/(?:with\s+content|content\s*[:=])\s*(.+)$/i);
    const derivedContent =
      quotedContentMatch?.[2]?.trim() ??
      inlineContentMatch?.[1]?.trim() ??
      "Generated by mock planner.";
    pushAction("write_file", "Write generated content to a file.", {
      path: pathMatch?.[1] ?? "runtime/sandbox/generated_note.txt",
      content: derivedContent.length > 0 ? derivedContent : "Generated by mock planner."
    });
  }

  if (
    text.includes("list directory") ||
    text.includes("list files") ||
    text.includes("inspect folder") ||
    text.includes("explore workspace")
  ) {
    const pathMatch = userInput.match(/(?:in|under)\s+([^\s]+)/i);
    pushAction("list_directory", "List files in a target directory.", {
      path: pathMatch?.[1] ?? "runtime/sandbox/"
    });
  }

  if (text.includes("create skill") || text.includes("generate skill")) {
    const skillNameMatch = userInput.match(/skill\s+([a-zA-Z0-9_-]+)/i);
    const generatedCode = text.includes("eval(")
      ? "export const generatedSkill = () => eval('2 + 2');"
      : "export function generatedSkill(input: string): string { return input.trim(); }";
    pushAction("create_skill", "Create a sandboxed auto-skill file.", {
      name: skillNameMatch?.[1] ?? "mock_generated_skill",
      code: generatedCode
    });
  }

  if (text.includes("use skill") || text.includes("run skill") || text.includes("invoke skill")) {
    const skillNameMatch =
      userInput.match(/(?:use|run|invoke)\s+skill\s+([a-zA-Z0-9_-]+)/i) ??
      userInput.match(/skill\s+([a-zA-Z0-9_-]+)/i);
    const inputMatch = userInput.match(/input\s*[:=]\s*(.+)$/i);
    pushAction("run_skill", "Run a previously created skill.", {
      name: skillNameMatch?.[1] ?? "mock_generated_skill",
      input: inputMatch?.[1]?.trim() ?? userInput
    });
  }

  if (text.includes("http") || text.includes("api") || text.includes("webhook")) {
    pushAction("network_write", "Call an external API endpoint.", {
      endpoint: "https://example.invalid/endpoint"
    });
  }

  if (text.includes("run command") || text.includes("shell")) {
    pushAction("shell_command", "Run a shell command required by task.", {
      command: "echo simulated"
    });
  }

  if (text.includes("start process") || text.includes("start dev server")) {
    pushAction("start_process", "Start a managed long-running process.", {
      command: "npm start"
    });
  }

  if (text.includes("check process")) {
    pushAction("check_process", "Check a managed process lease.", {
      leaseId: "proc_mock_lease"
    });
  }

  if (text.includes("stop process") || text.includes("kill process")) {
    pushAction("stop_process", "Stop a managed process lease.", {
      leaseId: "proc_mock_lease"
    });
  }

  if (text.includes("probe port") || text.includes("check port")) {
    pushAction("probe_port", "Probe a local TCP port for readiness.", {
      host: "127.0.0.1",
      port: 3000
    });
  }

  if (text.includes("probe http") || text.includes("check url") || text.includes("check endpoint")) {
    pushAction("probe_http", "Probe a local HTTP endpoint for readiness.", {
      url: "http://127.0.0.1:3000/",
      expectedStatus: 200
    });
  }

  if (
    text.includes("verify browser") ||
    text.includes("verify ui") ||
    text.includes("verify homepage")
  ) {
    pushAction("verify_browser", "Verify a loopback page through browser automation.", {
      url: "http://127.0.0.1:3000/",
      expectedText: text.includes("robinhood") ? "Robinhood" : "App"
    });
  }

  if (includesAny(text, HIGH_RISK_SELF_EDIT_HINTS)) {
    const touchesImmutable =
      text.includes("constitution") || text.includes("dna") || text.includes("kill switch");
    pushAction("self_modify", "Propose a governor/policy update.", {
      target: touchesImmutable ? "constitution.core" : "governor.policy",
      patch: "Adjust threshold for escalation trigger.",
      touchesImmutable
    });
  }

  if (actions.length === 0 && isMockExecutionStyleBuildRequest(userInput)) {
    pushAction("shell_command", "Run a finite scaffold/build step for the requested app.", {
      command: "npm create vite@latest finance-dashboard -- --template react"
    });

    if (isMockLiveVerificationBuildRequest(userInput)) {
      pushAction("start_process", "Start a managed development server for live verification.", {
        command: "npm start"
      });
      pushAction("probe_port", "Probe the local dev-server port for readiness.", {
        host: "127.0.0.1",
        port: 3000
      });
      if (isMockBrowserVerificationBuildRequest(userInput)) {
        pushAction("verify_browser", "Verify the live app in a loopback browser session.", {
          url: "http://127.0.0.1:3000/",
          expectedText: text.includes("robinhood") ? "Robinhood" : "App"
        });
      }
    }
  }

  if (actions.length === 0) {
    pushAction("respond", "Produce a direct response to the user.");
  }

  return {
    plannerNotes: "Mock planner completed structured action proposal.",
    actions
  };
}

/**
 * Builds governor output for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of governor output consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `GovernorModelOutput` (import `GovernorModelOutput`) from `./types`.
 *
 * @param userPrompt - Message/text content processed by this function.
 * @returns Computed `GovernorModelOutput` result.
 */
function buildGovernorOutput(userPrompt: string): GovernorModelOutput {
  const input = parseJsonObject(userPrompt);
  const governorId = asString(input.governorId).toLowerCase();
  const actionTypeRaw = asString(input.actionType).toLowerCase();
  const actionType = isActionType(actionTypeRaw) ? actionTypeRaw : "respond";
  const actionDescription = asString(input.actionDescription).toLowerCase();
  const rationale = asString(input.rationale).toLowerCase();
  const combined = `${actionDescription} ${rationale}`;

  if (["malware", "phishing", "dox", "harmful", "exploit"].some((term) => combined.includes(term))) {
    return {
      approve: false,
      reason: "Mock policy model detected harmful intent signals.",
      confidence: 0.95
    };
  }

  if (governorId === "security" && actionType === "delete_file") {
    const path = asString(input.path).toLowerCase().replace(/\\/g, "/");
    if (path && !path.startsWith("runtime/sandbox/")) {
      return {
        approve: false,
        reason: "Mock security model flags delete path outside sandbox.",
        confidence: 0.92
      };
    }
  }

  if (governorId === "compliance" && actionType === "network_write") {
    return {
      approve: false,
      reason: "Mock compliance model blocks network write by default policy.",
      confidence: 0.9
    };
  }

  return {
    approve: true,
    reason: "Mock policy model found no additional risk signals.",
    confidence: 0.82
  };
}

/**
 * Builds reflection output for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of reflection output consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ReflectionModelOutput` (import `ReflectionModelOutput`) from `./types`.
 *
 * @param userPrompt - Message/text content processed by this function.
 * @returns Computed `ReflectionModelOutput` result.
 */
function buildReflectionOutput(userPrompt: string): ReflectionModelOutput {
  return {
    lessons: ["Mock lesson: always verify input constraints before acting."]
  };
}

/**
 * Produces a deterministic success-reflection lesson for tasks where all actions were approved.
 */
function buildSuccessReflectionOutput(userPrompt: string): SuccessReflectionModelOutput {
  return {
    lesson: "Mock success lesson: the approach of validating constraints early proved effective.",
    nearMiss: null
  };
}

/**
 * Builds autonomous next step output for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of autonomous next step output consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `AutonomousNextStepModelOutput` (import `AutonomousNextStepModelOutput`) from `./types`.
 *
 * @param userPrompt - Message/text content processed by this function.
 * @returns Computed `AutonomousNextStepModelOutput` result.
 */
function buildAutonomousNextStepOutput(userPrompt: string): AutonomousNextStepModelOutput {
  const input = parseJsonObject(userPrompt);
  const overarchingGoal = asString(input.overarchingGoal).toLowerCase();

  // If the goal contains "stop" or "met", we pretend it's met
  if (overarchingGoal.includes("stop") || overarchingGoal.includes("done")) {
    return {
      isGoalMet: true,
      reasoning: "Mock model decided the overarching goal is met.",
      nextUserInput: ""
    };
  }

  // Otherwise, we provide a generic next step once and then stop
  return {
    isGoalMet: false,
    reasoning: "Mock model decided to take one more step.",
    nextUserInput: "finish the task and stop"
  };
}

/**
 * Builds proactive goal output for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of proactive goal output consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ProactiveGoalModelOutput` (import `ProactiveGoalModelOutput`) from `./types`.
 *
 * @param _userPrompt - Message/text content processed by this function.
 * @returns Computed `ProactiveGoalModelOutput` result.
 */
function buildProactiveGoalOutput(_userPrompt: string): ProactiveGoalModelOutput {
  return {
    proactiveGoal: "Mock proactive goal generated.",
    reasoning: "Mock model generated a new proactive goal to run continuously."
  };
}

/**
 * Builds response synthesis output for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of response synthesis output consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ResponseSynthesisModelOutput` (import `ResponseSynthesisModelOutput`) from `./types`.
 *
 * @param userPrompt - Message/text content processed by this function.
 * @returns Computed `ResponseSynthesisModelOutput` result.
 */
function buildResponseSynthesisOutput(userPrompt: string): ResponseSynthesisModelOutput {
  const input = parseJsonObject(userPrompt);
  const userInput = resolveActiveMockUserInput(input, userPrompt).trim();
  const normalizedInput = userInput.toLowerCase();

  if (!userInput) {
    return {
      message: "I am ready to help. Tell me what you want to work on."
    };
  }

  if (/^(hello|hi|hey)\b/.test(normalizedInput)) {
    return {
      message: "Hello! I am online and ready to help."
    };
  }

  const sayMatch = userInput.match(/^say\s+(.+)$/i);
  if (sayMatch) {
    return {
      message: sayMatch[1].trim()
    };
  }

  const sentenceMatch = userInput.match(
    /^(?:tell me|give me|write)(?:\s+(?:a|one))?\s+sentence about\s+(.+)$/i
  );
  if (sentenceMatch) {
    const topic = sentenceMatch[1].trim().replace(/[.!?]+$/, "");
    return {
      message: `${topic.charAt(0).toUpperCase()}${topic.slice(1)} is vast and full of discoveries that shape how we understand reality.`
    };
  }

  return {
    message: "I can help with that. Share a little more detail and I will answer precisely."
  };
}

/**
 * Builds intent interpretation output for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of intent interpretation output consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `IntentInterpretationModelOutput` (import `IntentInterpretationModelOutput`) from `./types`.
 *
 * @param userPrompt - Message/text content processed by this function.
 * @returns Computed `IntentInterpretationModelOutput` result.
 */
function buildIntentInterpretationOutput(
  userPrompt: string
): IntentInterpretationModelOutput {
  const input = parseJsonObject(userPrompt);
  const text = asString(input.text).trim().toLowerCase();
  const combinedContext = [
    text,
    asString(input.contextHint).trim().toLowerCase()
  ]
    .filter((item) => item.length > 0)
    .join(" ");

  const hasPulseKeyword =
    /\bpulse\b/.test(combinedContext) ||
    /\bcheck[- ]?in\b/.test(combinedContext) ||
    /\bnotifications?\b/.test(combinedContext) ||
    /\breminders?\b/.test(combinedContext) ||
    /\bnudges?\b/.test(combinedContext);

  if (/\bstatus\b/.test(combinedContext) && hasPulseKeyword) {
    return {
      intentType: "pulse_control",
      mode: "status",
      confidence: 0.94,
      rationale: "Message asks for pulse/check-in status."
    };
  }

  if (/\bprivate\b/.test(combinedContext) && hasPulseKeyword) {
    return {
      intentType: "pulse_control",
      mode: "private",
      confidence: 0.93,
      rationale: "Message asks for private pulse/check-in mode."
    };
  }

  if (/\bpublic\b/.test(combinedContext) && hasPulseKeyword) {
    return {
      intentType: "pulse_control",
      mode: "public",
      confidence: 0.93,
      rationale: "Message asks for public pulse/check-in mode."
    };
  }

  if (/(?:\bturn\s+off\b|\bstop\b|\bdisable\b|\bpause\b)/.test(combinedContext) && hasPulseKeyword) {
    return {
      intentType: "pulse_control",
      mode: "off",
      confidence: 0.95,
      rationale: "Message asks to stop pulse/check-in notifications."
    };
  }

  if (/(?:\bturn\s+on\b|\benable\b|\bresume\b)/.test(combinedContext) && hasPulseKeyword) {
    return {
      intentType: "pulse_control",
      mode: "on",
      confidence: 0.95,
      rationale: "Message asks to enable pulse/check-in notifications."
    };
  }

  return {
    intentType: "none",
    mode: null,
    confidence: 0.2,
    rationale: "No pulse-control intent detected."
  };
}

export class MockModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private usage: ModelUsageSnapshot = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedSpendUsd: 0
  };

  /**
   * Derives mock tokens from available runtime inputs.
   *
   * **Why it exists:**
   * Keeps `estimate mock tokens` behavior centralized so collaborating call sites stay consistent.
   *
   * **What it talks to:**
   * - Uses `StructuredCompletionRequest` (import `StructuredCompletionRequest`) from `./types`.
   *
   * @param request - Structured input object for this operation.
   * @returns Computed numeric value.
   */
  private estimateMockTokens(request: StructuredCompletionRequest): number {
    const contentLength = request.systemPrompt.length + request.userPrompt.length;
    return Math.max(1, Math.ceil(contentLength / 4));
  }

  /**
   * Tracks usage for audit, retry, or telemetry decisions.
   *
   * **Why it exists:**
   * Centralizes lifecycle tracking for usage so audit and retry flows share one source of truth.
   *
   * **What it talks to:**
   * - Uses `StructuredCompletionRequest` (import `StructuredCompletionRequest`) from `./types`.
   *
   * @param request - Structured input object for this operation.
   */
  private trackUsage(request: StructuredCompletionRequest): void {
    const promptTokens = this.estimateMockTokens(request);
    const completionTokens = 32;
    this.usage.calls += 1;
    this.usage.promptTokens += promptTokens;
    this.usage.completionTokens += completionTokens;
    this.usage.totalTokens += promptTokens + completionTokens;
    // Mock backend does not represent billable provider usage.
    this.usage.estimatedSpendUsd += 0;
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

  /**
   * Completes json through the configured model/provider path.
   *
   * **Why it exists:**
   * Keeps provider completion behavior for json behind a single typed boundary.
   *
   * **What it talks to:**
   * - Uses `normalizeStructuredModelOutput` (import `normalizeStructuredModelOutput`) from `./schemaValidation`.
   * - Uses `validateStructuredModelOutput` (import `validateStructuredModelOutput`) from `./schemaValidation`.
   * - Uses `StructuredCompletionRequest` (import `StructuredCompletionRequest`) from `./types`.
   *
   * @param request - Structured input object for this operation.
   * @returns Promise resolving to T.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    this.trackUsage(request);

    let output: unknown;
    if (request.schemaName === "planner_v1") {
      output = buildPlannerOutput(request.userPrompt);
    } else if (request.schemaName === "governor_v1") {
      output = buildGovernorOutput(request.userPrompt);
    } else if (request.schemaName === "reflection_v1") {
      output = buildReflectionOutput(request.userPrompt);
    } else if (request.schemaName === "reflection_success_v1") {
      output = buildSuccessReflectionOutput(request.userPrompt);
    } else if (request.schemaName === "autonomous_next_step_v1") {
      output = buildAutonomousNextStepOutput(request.userPrompt);
    } else if (request.schemaName === "proactive_goal_v1") {
      output = buildProactiveGoalOutput(request.userPrompt);
    } else if (request.schemaName === "response_v1") {
      output = buildResponseSynthesisOutput(request.userPrompt);
    } else if (request.schemaName === "intent_interpretation_v1") {
      output = buildIntentInterpretationOutput(request.userPrompt);
    } else {
      throw new Error(`MockModelClient does not support schema: ${request.schemaName}`);
    }

    const normalized = normalizeStructuredModelOutput(request.schemaName, output);
    validateStructuredModelOutput(request.schemaName, normalized);
    return normalized as T;
  }
}
