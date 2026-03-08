/**
 * @fileoverview Deterministic mock planner-response builders and lexical routing policy.
 */

import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import type { ActionType } from "../../core/types";
import type { PlannerModelOutput } from "../types";
import { includesAny, resolveActiveMockUserInput, parseJsonObject } from "./contracts";

const HIGH_RISK_SELF_EDIT_HINTS = [
  "change governor",
  "rewrite governor",
  "update constitution",
  "modify dna",
  "disable safety",
  "override"
] as const;

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
 * Keeps mock planner action construction behind a canonical subsystem instead of mixing it into the
 * stable `mockModelClient.ts` entrypoint.
 *
 * **What it talks to:**
 * - Uses `estimateActionCostUsd` (import `estimateActionCostUsd`) from `../../core/actionCostPolicy`.
 * - Uses `ActionType` (import `ActionType`) from `../../core/types`.
 * - Uses `PlannerModelOutput` (import `PlannerModelOutput`) from `../types`.
 * - Uses shared prompt helpers from `./contracts`.
 *
 * @param userPrompt - Message/text content processed by this function.
 * @returns Computed `PlannerModelOutput` result.
 */
export function buildPlannerOutput(userPrompt: string): PlannerModelOutput {
  const input = parseJsonObject(userPrompt);
  const userInput = resolveActiveMockUserInput(input, userPrompt);
  const text = userInput.toLowerCase();
  const actions: PlannerModelOutput["actions"] = [];

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
