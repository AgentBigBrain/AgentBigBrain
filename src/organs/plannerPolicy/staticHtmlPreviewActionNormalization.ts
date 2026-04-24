/**
 * @fileoverview Deterministic normalization for static HTML preview-server planner actions.
 */

import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import type { PlannedAction } from "../../core/types";
import { inferManagedProcessLoopbackTarget } from "../liveRun/contracts";
import type { PlannerExecutionEnvironmentContext } from "./executionStyleContracts";
import { getPathModuleForPathValue } from "./frameworkPathSupport";
import { isStaticHtmlExecutionStyleRequest } from "./liveVerificationPolicy";

const POWER_SHELL_HTTP_LISTENER_PATTERN =
  /\bhttplistener\b/i;
const POWER_SHELL_HTTP_LISTENER_CONTEXT_PATTERN =
  /\bgetcontext\b/i;
const POWER_SHELL_HTTP_LISTENER_FILE_SERVE_PATTERN =
  /\breadallbytes\b/i;
const NEW_ITEM_DIRECTORY_PATH_PATTERN =
  /\bnew-item\b[\s\S]*?-itemtype\s+directory\b[\s\S]*?-path\s+["']([^"']+)["']/i;
const MKDIR_DIRECTORY_PATH_PATTERN =
  /(?:^|[\s;(])(?:mkdir|md)\s+["']([^"']+)["']/i;
const STATIC_HTML_REDUNDANT_SHELL_COMMAND_FORBIDDEN_PATTERN =
  /\b(?:python|node|npm|npx|pnpm|yarn|serve|http\.server|start-process|set-content|add-content|out-file|copy-item|move-item|remove-item|git)\b/i;

/**
 * Reads one planned action workspace root when present.
 *
 * @param action - Planner action under normalization.
 * @returns Exact cwd or workdir when present, otherwise `null`.
 */
function readActionWorkspaceRoot(action: PlannedAction): string | null {
  const cwd =
    typeof action.params.cwd === "string" ? action.params.cwd.trim() : "";
  if (cwd.length > 0) {
    return cwd;
  }
  const workdir =
    typeof action.params.workdir === "string" ? action.params.workdir.trim() : "";
  return workdir.length > 0 ? workdir : null;
}

/**
 * Extracts every exact `index.html` root already planned in this static-site action list.
 *
 * @param actions - Planner actions under normalization.
 * @returns Exact workspace roots that already contain an `index.html` write.
 */
function extractStaticHtmlEntryRoots(actions: readonly PlannedAction[]): readonly string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    if (action.type !== "write_file") {
      continue;
    }
    const rawPath =
      typeof action.params.path === "string" ? action.params.path.trim() : "";
    if (rawPath.length === 0) {
      continue;
    }
    const pathModule = getPathModuleForPathValue(rawPath);
    if (pathModule.basename(rawPath).toLowerCase() !== "index.html") {
      continue;
    }
    const root = pathModule.dirname(rawPath);
    if (seen.has(root)) {
      continue;
    }
    seen.add(root);
    roots.push(root);
  }
  return roots;
}

/**
 * Evaluates whether the start-process command is the oversized inline PowerShell listener shape
 * that caused governor timeouts in the live static-site scenario.
 *
 * @param command - Planned `start_process` command text.
 * @returns `true` when the command should be rewritten into a bounded local server command.
 */
function isOversizedInlineStaticPreviewServer(command: string): boolean {
  return (
    command.trim().toLowerCase().startsWith("powershell -noprofile -command") &&
    POWER_SHELL_HTTP_LISTENER_PATTERN.test(command) &&
    POWER_SHELL_HTTP_LISTENER_CONTEXT_PATTERN.test(command) &&
    POWER_SHELL_HTTP_LISTENER_FILE_SERVE_PATTERN.test(command)
  );
}

/**
 * Normalizes one loopback host into the exact local server bind value.
 *
 * @param host - Loopback host parsed from the original command.
 * @returns Exact bind host for the bounded Python preview server.
 */
function normalizeStaticPreviewBindHost(host: string): string {
  return host === "::1" ? "::1" : host;
}

/**
 * Reads the exact directory path created by one bounded shell command when the command is only
 * creating a folder.
 *
 * @param command - Planned shell command text.
 * @returns Exact created directory path when the command is a bounded create-directory helper.
 */
function readStaticHtmlEnsureDirectoryTarget(command: string): string | null {
  const newItemMatch = command.match(NEW_ITEM_DIRECTORY_PATH_PATTERN);
  if (newItemMatch?.[1]) {
    return newItemMatch[1].trim();
  }
  const mkdirMatch = command.match(MKDIR_DIRECTORY_PATH_PATTERN);
  if (mkdirMatch?.[1]) {
    return mkdirMatch[1].trim();
  }
  return null;
}

/**
 * Evaluates whether one shell command is only ensuring the same static HTML workspace folder that
 * the later `write_file` already proves and creates.
 *
 * @param action - Planned action under review.
 * @param staticHtmlRoots - Exact static HTML workspace roots already proven by `index.html` writes.
 * @returns `true` when the shell step is redundant and safe to strip before governance.
 */
function isRedundantStaticHtmlEnsureDirectoryAction(
  action: PlannedAction,
  staticHtmlRoots: readonly string[]
): boolean {
  if (action.type !== "shell_command") {
    return false;
  }
  const command =
    typeof action.params.command === "string" ? action.params.command.trim() : "";
  if (command.length === 0) {
    return false;
  }
  if (STATIC_HTML_REDUNDANT_SHELL_COMMAND_FORBIDDEN_PATTERN.test(command)) {
    return false;
  }
  const targetPath = readStaticHtmlEnsureDirectoryTarget(command);
  if (!targetPath || !staticHtmlRoots.includes(targetPath)) {
    return false;
  }
  const workspaceRoot =
    readActionWorkspaceRoot(action) ??
    (staticHtmlRoots.length === 1 ? staticHtmlRoots[0] ?? null : null);
  return workspaceRoot === targetPath;
}

/**
 * Rewrites oversized inline static preview servers into a short bounded command before governance.
 *
 * @param actions - Planner actions under normalization.
 * @param currentUserRequest - Active user request.
 * @param executionEnvironment - Planner execution environment context.
 * @returns Actions with bounded static preview start commands when applicable.
 */
export function normalizeStaticHtmlPreviewActions(
  actions: PlannedAction[],
  currentUserRequest: string,
  executionEnvironment: PlannerExecutionEnvironmentContext | null
): PlannedAction[] {
  if (
    !executionEnvironment ||
    !isStaticHtmlExecutionStyleRequest(currentUserRequest)
  ) {
    return actions;
  }

  const staticHtmlRoots = extractStaticHtmlEntryRoots(actions);
  if (staticHtmlRoots.length === 0) {
    return actions;
  }

  return actions.reduce<PlannedAction[]>((normalized, action) => {
    if (isRedundantStaticHtmlEnsureDirectoryAction(action, staticHtmlRoots)) {
      return normalized;
    }
    if (action.type !== "start_process") {
      normalized.push(action);
      return normalized;
    }
    const command =
      typeof action.params.command === "string" ? action.params.command.trim() : "";
    if (!isOversizedInlineStaticPreviewServer(command)) {
      normalized.push(action);
      return normalized;
    }

    const loopbackTarget = inferManagedProcessLoopbackTarget(command);
    if (!loopbackTarget) {
      normalized.push(action);
      return normalized;
    }

    const workspaceRoot =
      readActionWorkspaceRoot(action) ??
      (staticHtmlRoots.length === 1 ? staticHtmlRoots[0] ?? null : null);
    if (!workspaceRoot || !staticHtmlRoots.includes(workspaceRoot)) {
      normalized.push(action);
      return normalized;
    }

    const rewrittenCommand =
      `python -m http.server ${loopbackTarget.port} --bind ` +
      `${normalizeStaticPreviewBindHost(loopbackTarget.host)}`;
    const params = {
      ...action.params,
      command: rewrittenCommand,
      cwd: workspaceRoot,
      workdir: workspaceRoot
    };

    normalized.push({
      ...action,
      description:
        "Start the exact static HTML workspace on loopback with a bounded local preview server.",
      params,
      estimatedCostUsd: estimateActionCostUsd({
        type: "start_process",
        params
      })
    });
    return normalized;
  }, []);
}
