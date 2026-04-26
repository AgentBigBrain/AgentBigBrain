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

const MOCK_NATURAL_CLOSE_BROWSER_FOLLOW_UP_PATTERN =
  /\b(?:close|shut|dismiss|hide)\b[\s\S]{0,50}\b(?:browser|tab|window|preview|page|landing page|homepage)\b/i;
const LOOPBACK_URL_PATTERN =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[^\s"'`;),]*)?/i;
const PORT_PATTERN = /\b(?:port\s+|localhost:|127\.0\.0\.1:)(\d{1,5})\b/i;

/**
 * Extracts the first explicit loopback HTTP URL from active prompt text.
 *
 * **Why it exists:**
 * The mock planner should exercise explicit routing and validation contracts without inventing a
 * preview URL that the model did not receive.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param primaryText - Active user request text.
 * @param fallbackText - Full prompt/context text searched only when the active request has no URL.
 * @returns Explicit loopback URL, or `null` when absent.
 */
function extractExplicitLoopbackUrl(primaryText: string, fallbackText: string): string | null {
  return primaryText.match(LOOPBACK_URL_PATTERN)?.[0] ?? fallbackText.match(LOOPBACK_URL_PATTERN)?.[0] ?? null;
}

/**
 * Extracts an explicit local port from active prompt text.
 *
 * **Why it exists:**
 * Keeps mock probe-port actions grounded in user or context data instead of defaulting to a magic
 * development port.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param primaryText - Active user request text.
 * @param fallbackText - Full prompt/context text searched only when the active request has no port.
 * @returns Explicit TCP port, or `null` when absent or out of range.
 */
function extractExplicitLocalPort(primaryText: string, fallbackText: string): number | null {
  const urlText = extractExplicitLoopbackUrl(primaryText, fallbackText);
  if (urlText) {
    try {
      const parsedUrl = new URL(urlText);
      const parsedPort = Number(parsedUrl.port);
      if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65_535) {
        return parsedPort;
      }
    } catch {
      return null;
    }
  }

  const portText = primaryText.match(PORT_PATTERN)?.[1] ?? fallbackText.match(PORT_PATTERN)?.[1];
  const parsedPort = portText ? Number(portText) : Number.NaN;
  return Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65_535
    ? parsedPort
    : null;
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
  const promptText = userPrompt.toLowerCase();
  const explicitLoopbackUrl = extractExplicitLoopbackUrl(userInput, userPrompt);
  const explicitLocalPort = extractExplicitLocalPort(userInput, userPrompt);
  const linkedSessionMatch = userPrompt.match(/sessionId=([^\s;]+)/i);
  const linkedPreviewLeaseMatch = userPrompt.match(/linked preview process:\s*leaseId=([^\s;]+)/i);
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
      /(?:with\s+content\s*[:=]?|content\s*[:=])\s*(['"`])([\s\S]*?)\1/i
    );
    const inlineContentMatch = userInput.match(
      /(?:with\s+content\s*[:=]?|content\s*[:=])\s*(.+)$/i
    );
    const derivedContent =
      quotedContentMatch?.[2]?.trim() ??
      inlineContentMatch?.[1]?.trim() ??
      "";
    if (derivedContent.length > 0) {
      pushAction("write_file", "Write explicit content to a file.", {
        path: pathMatch?.[1] ?? "runtime/sandbox/generated_note.txt",
        content: derivedContent
      });
    }
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

  if (/\b(?:create|generate)\b[\s\S]{0,40}\bskill\b/i.test(userInput)) {
    const skillNameMatch = userInput.match(/skill\s+([a-zA-Z0-9_-]+)/i);
    const quotedInstructionsMatch = userInput.match(
      /(?:with\s+(?:markdown\s+)?(?:instructions|guidance)\s*[:=]?|(?:instructions|guidance)\s*[:=])\s*(['"`])([\s\S]*?)\1/i
    );
    const inlineInstructionsMatch = userInput.match(
      /(?:with\s+(?:markdown\s+)?(?:instructions|guidance)\s*[:=]?|(?:instructions|guidance)\s*[:=])\s*(.+)$/i
    );
    const explicitInstructions =
      quotedInstructionsMatch?.[2]?.trim() ??
      inlineInstructionsMatch?.[1]?.trim() ??
      "";
    const quotedCodeMatch = userInput.match(
      /(?:with\s+code\s*[:=]?|code\s*[:=])\s*(['"`])([\s\S]*?)\1/i
    );
    const inlineCodeMatch = userInput.match(
      /(?:with\s+code\s*[:=]?|code\s*[:=])\s*(.+)$/i
    );
    const explicitCode =
      quotedCodeMatch?.[2]?.trim() ??
      inlineCodeMatch?.[1]?.trim() ??
      "";
    if (explicitInstructions.length > 0) {
      pushAction("create_skill", "Create a governed Markdown instruction skill.", {
        name: skillNameMatch?.[1] ?? "mock_guidance_skill",
        kind: "markdown_instruction",
        instructions: explicitInstructions
      });
      return {
        plannerNotes: "Mock planner completed structured action proposal.",
        actions
      };
    }
    if (explicitCode.length > 0) {
      pushAction("create_skill", "Create a sandboxed executable skill file.", {
        name: skillNameMatch?.[1] ?? "mock_generated_skill",
        kind: "executable_module",
        code: explicitCode
      });
    }
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

  if (
    text.includes("api") ||
    text.includes("webhook") ||
    (text.includes("http") && !explicitLoopbackUrl && /\bhttps?:\/\//i.test(userInput))
  ) {
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
    if (explicitLocalPort !== null) {
      pushAction("probe_port", "Probe an explicit local TCP port for readiness.", {
        host: "127.0.0.1",
        port: explicitLocalPort
      });
    }
  }

  if (text.includes("probe http") || text.includes("check url") || text.includes("check endpoint")) {
    if (explicitLoopbackUrl) {
      pushAction("probe_http", "Probe an explicit local HTTP endpoint for readiness.", {
        url: explicitLoopbackUrl,
        expectedStatus: 200
      });
    }
  }

  if (
    text.includes("verify browser") ||
    text.includes("verify ui") ||
    text.includes("verify homepage")
  ) {
    if (explicitLoopbackUrl) {
      pushAction("verify_browser", "Verify an explicit loopback page through browser automation.", {
        url: explicitLoopbackUrl,
        expectedText: text.includes("portfolio") ? "Portfolio" : "App"
      });
    }
  }

  if (text.includes("open browser") || text.includes("leave it open")) {
    if (explicitLoopbackUrl) {
      pushAction("open_browser", "Open the explicit verified page in a visible browser window.", {
        url: explicitLoopbackUrl
      });
    }
  }

  if (text.includes("close browser") || text.includes("close the browser")) {
    if (linkedSessionMatch?.[1]) {
      pushAction("close_browser", "Close the tracked browser window for the local page.", {
        sessionId: linkedSessionMatch[1]
      });
    } else if (explicitLoopbackUrl) {
      pushAction("close_browser", "Close the tracked browser window for the local page.", {
        url: explicitLoopbackUrl
      });
    }
  }

  if (
    actions.length === 0 &&
    MOCK_NATURAL_CLOSE_BROWSER_FOLLOW_UP_PATTERN.test(userInput) &&
    promptText.includes("tracked browser sessions:")
  ) {
    if (linkedSessionMatch?.[1]) {
      pushAction("close_browser", "Close the tracked browser window for the local page.", {
        sessionId: linkedSessionMatch[1]
      });
    } else if (explicitLoopbackUrl) {
      pushAction("close_browser", "Close the tracked browser window for the local page.", {
        url: explicitLoopbackUrl
      });
    }
    if (linkedPreviewLeaseMatch?.[1]) {
      pushAction("stop_process", "Stop the linked local preview process after closing the browser.", {
        leaseId: linkedPreviewLeaseMatch[1]
      });
    }
  }
  if (
    actions.some((action) => action.type === "close_browser") &&
    linkedPreviewLeaseMatch?.[1] &&
    !actions.some((action) => action.type === "stop_process")
  ) {
    pushAction("stop_process", "Stop the linked local preview process after closing the browser.", {
      leaseId: linkedPreviewLeaseMatch[1]
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

  if (actions.length === 0) {
    pushAction("respond", "Produce a direct response to the user.");
  }

  return {
    plannerNotes: "Mock planner completed structured action proposal.",
    actions
  };
}
