/**
 * @fileoverview Guards same-plan live-run actions from proving or opening a loopback target whose start just failed.
 */

import {
  type ActionRunResult,
  type PlannedAction
} from "../types";
import {
  inferManagedProcessLoopbackTarget,
  isLoopbackBrowserVerificationHost
} from "../../organs/liveRun/contracts";
import { buildBlockedActionResult } from "./taskRunnerSummary";

interface LoopbackTarget {
  host: string;
  port: number;
  url: string | null;
}

export interface FailedManagedProcessStartTarget extends LoopbackTarget {
  sourceActionId: string;
  failureKind: string | null;
}

export interface FailedWorkspaceExecutionDependency {
  workspaceRoot: string;
  sourceActionId: string;
  failureCode: ActionRunResult["executionFailureCode"] | null;
  stage: "install" | "build" | "workspace_proof" | "build_proof";
}

interface DependentLiveRunTargetBlock {
  actionResult: ActionRunResult;
  traceDetails: Record<string, string | number | boolean | null>;
}

/**
 * Normalizes a potential loopback host into the canonical localhost marker.
 *
 * @param host - Candidate host from planner params or execution metadata.
 * @returns `localhost` when the host is loopback-only, otherwise `null`.
 */
function normalizeLoopbackHost(host: unknown): string | null {
  if (typeof host !== "string") {
    return null;
  }
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  ) {
    return "localhost";
  }
  return null;
}

/**
 * Normalizes a potential loopback port into the valid TCP port range.
 *
 * @param port - Candidate port from planner params or execution metadata.
 * @returns Integer port when valid, otherwise `null`.
 */
function normalizeLoopbackPort(port: unknown): number | null {
  if (typeof port !== "number" || !Number.isInteger(port)) {
    return null;
  }
  if (port < 1 || port > 65_535) {
    return null;
  }
  return port;
}

/**
 * Parses a candidate URL and returns loopback target details when it stays on localhost.
 *
 * @param urlValue - Candidate URL from planner params or execution metadata.
 * @returns Loopback target details when the URL is loopback-only, otherwise `null`.
 */
function resolveLoopbackTargetFromUrl(urlValue: unknown): LoopbackTarget | null {
  if (typeof urlValue !== "string" || urlValue.trim().length === 0) {
    return null;
  }
  try {
    const parsedUrl = new URL(urlValue);
    if (!isLoopbackBrowserVerificationHost(parsedUrl.hostname)) {
      return null;
    }
    const port =
      parsedUrl.port.trim().length > 0
        ? Number.parseInt(parsedUrl.port, 10)
        : parsedUrl.protocol === "https:"
          ? 443
          : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return null;
    }
    return {
      host: "localhost",
      port,
      url: parsedUrl.toString()
    };
  } catch {
    return null;
  }
}

/**
 * Resolves whether one planned action depends on a loopback target that can be blocked later.
 *
 * @param action - Planned live-run action under evaluation.
 * @returns Loopback target details when the action points at a concrete loopback target.
 */
function resolveDependentLoopbackTarget(action: PlannedAction): LoopbackTarget | null {
  switch (action.type) {
    case "probe_port": {
      const host = normalizeLoopbackHost(action.params.host);
      const port = normalizeLoopbackPort(action.params.port);
      if (!host || port === null) {
        return null;
      }
      return {
        host,
        port,
        url: `http://${host}:${port}`
      };
    }
    case "probe_http":
    case "verify_browser":
    case "open_browser":
      return resolveLoopbackTargetFromUrl(action.params.url);
    default:
      return null;
  }
}

/** Reads the best available workspace root hint from a planned or executed action. */
function readWorkspaceRoot(action: PlannedAction | ActionRunResult["action"]): string | null {
  const { cwd, workdir, rootPath } = action.params as Record<string, unknown>;
  return typeof cwd === "string" && cwd.trim().length > 0
    ? cwd.trim()
    : typeof workdir === "string" && workdir.trim().length > 0
      ? workdir.trim()
      : typeof rootPath === "string" && rootPath.trim().length > 0
        ? rootPath.trim()
        : null;
}

/** Classifies which framework-workspace prerequisite a failed action belonged to. */
function resolveWorkspaceDependencyStage(
  action: PlannedAction | ActionRunResult["action"]
): FailedWorkspaceExecutionDependency["stage"] | null {
  if (action.type !== "shell_command") {
    return null;
  }
  const command =
    typeof action.params.command === "string" ? action.params.command : "";
  if (/\bnpm install\b/i.test(command)) {
    return "install";
  }
  if (/\bnpm run build\b/i.test(command)) {
    return "build";
  }
  if (/workspace not ready/i.test(command)) {
    return "workspace_proof";
  }
  if (/landing page build proof missing/i.test(command)) {
    return "build_proof";
  }
  return null;
}

/** Resolves which failed workspace dependency should block a later dependent live-run action. */
function resolveWorkspaceRootForDependentAction(
  action: PlannedAction,
  failedDependencies: readonly FailedWorkspaceExecutionDependency[]
): string | null {
  const explicitWorkspaceRoot = readWorkspaceRoot(action);
  if (explicitWorkspaceRoot) {
    return explicitWorkspaceRoot;
  }
  if (failedDependencies.length !== 1) {
    return null;
  }
  if (!resolveDependentLoopbackTarget(action)) {
    return null;
  }
  return failedDependencies[0]?.workspaceRoot ?? null;
}

/**
 * Extracts the failed loopback target from a blocked `start_process` result when available.
 *
 * @param actionResult - Completed action result from the current task run.
 * @returns Failed target metadata when this result represents a loopback start failure.
 */
function resolveFailedManagedProcessStartTarget(
  actionResult: ActionRunResult
): FailedManagedProcessStartTarget | null {
  if (actionResult.action.type !== "start_process") {
    return null;
  }
  if (actionResult.approved || actionResult.executionFailureCode !== "PROCESS_START_FAILED") {
    return null;
  }

  const metadata = actionResult.executionMetadata ?? {};
  const metadataHost = normalizeLoopbackHost(metadata.processRequestedHost);
  const metadataPort = normalizeLoopbackPort(metadata.processRequestedPort);
  const metadataUrl = resolveLoopbackTargetFromUrl(metadata.processRequestedUrl);
  if (metadataHost && metadataPort !== null) {
    return {
      host: metadataHost,
      port: metadataPort,
      url: metadataUrl?.url ?? `http://${metadataHost}:${metadataPort}`,
      sourceActionId: actionResult.action.id,
      failureKind:
        typeof metadata.processStartupFailureKind === "string"
          ? metadata.processStartupFailureKind
          : null
    };
  }

  const inferredTarget = inferManagedProcessLoopbackTarget(
    typeof actionResult.action.params.command === "string"
      ? actionResult.action.params.command
      : ""
  );
  if (!inferredTarget) {
    return null;
  }
  return {
    host: "localhost",
    port: inferredTarget.port,
    url: inferredTarget.url,
    sourceActionId: actionResult.action.id,
    failureKind: null
  };
}

/**
 * Records the newest failed managed-process start target while deduplicating by host and port.
 *
 * @param failedTargets - Previously remembered failed start targets.
 * @param actionResult - New action result to fold into the remembered failure list.
 * @returns Updated failed-target list with any new loopback start failure at the front.
 */
export function rememberFailedManagedProcessStartTarget(
  failedTargets: readonly FailedManagedProcessStartTarget[],
  actionResult: ActionRunResult
): FailedManagedProcessStartTarget[] {
  const resolved = resolveFailedManagedProcessStartTarget(actionResult);
  if (!resolved) {
    return [...failedTargets];
  }
  const deduped = failedTargets.filter(
    (candidate) => !(candidate.host === resolved.host && candidate.port === resolved.port)
  );
  return [resolved, ...deduped];
}

/** Records failed framework-workspace prerequisites so later dependent actions can fail closed. */
export function rememberFailedWorkspaceExecutionDependency(
  failedDependencies: readonly FailedWorkspaceExecutionDependency[],
  actionResult: ActionRunResult
): FailedWorkspaceExecutionDependency[] {
  if (actionResult.approved) {
    return [...failedDependencies];
  }
  const workspaceRoot = readWorkspaceRoot(actionResult.action);
  const stage = resolveWorkspaceDependencyStage(actionResult.action);
  if (!workspaceRoot || !stage) {
    return [...failedDependencies];
  }
  const resolved: FailedWorkspaceExecutionDependency = {
    workspaceRoot,
    sourceActionId: actionResult.action.id,
    failureCode: actionResult.executionFailureCode ?? "ACTION_EXECUTION_FAILED",
    stage
  };
  const deduped = failedDependencies.filter(
    (candidate) => candidate.workspaceRoot !== workspaceRoot
  );
  return [resolved, ...deduped];
}

/**
 * Blocks proof or browser actions that still depend on a loopback target whose start already failed.
 *
 * @param action - Planned action about to run.
 * @param mode - Task-runner execution mode used for the blocked action result.
 * @param failedTargets - Failed loopback targets remembered from earlier action results.
 * @returns Block payload when the action depends on a failed target, otherwise `null`.
 */
export function evaluateDependentLiveRunTargetBlock(
  action: PlannedAction,
  mode: ActionRunResult["mode"],
  failedTargets: readonly FailedManagedProcessStartTarget[]
): DependentLiveRunTargetBlock | null {
  const target = resolveDependentLoopbackTarget(action);
  if (!target) {
    return null;
  }

  const failedTarget = failedTargets.find(
    (candidate) => candidate.host === target.host && candidate.port === target.port
  );
  if (!failedTarget) {
    return null;
  }

  const targetLabel = failedTarget.url ?? `http://${failedTarget.host}:${failedTarget.port}`;
  const failureDetail = failedTarget.failureKind
    ? ` (${failedTarget.failureKind})`
    : "";
  const output =
    `${action.type} skipped: an earlier start_process for ${targetLabel} failed${failureDetail}. ` +
    "This plan attempt cannot truthfully verify or open that same local target until a later step starts the app successfully.";

  return {
    actionResult: buildBlockedActionResult({
      action,
      mode,
      output,
      executionStatus: "blocked",
      executionFailureCode: "PROCESS_START_FAILED",
      executionMetadata: {
        processLifecycleStatus: "PROCESS_START_FAILED",
        processStartupFailureKind: failedTarget.failureKind,
        processRequestedHost: failedTarget.host,
        processRequestedPort: failedTarget.port,
        processRequestedUrl: failedTarget.url,
        liveRunDependencyBlocked: true,
        liveRunDependencySourceActionId: failedTarget.sourceActionId
      },
      blockedBy: ["PROCESS_START_FAILED"],
      violations: [
        {
          code: "PROCESS_START_FAILED",
          message: output
        }
      ]
    }),
    traceDetails: {
      blockCode: "PROCESS_START_FAILED",
      blockCategory: "runtime",
      liveRunDependencyBlocked: true,
      blockedLoopbackHost: failedTarget.host,
      blockedLoopbackPort: failedTarget.port,
      blockedLoopbackUrl: failedTarget.url,
      blockedSourceActionId: failedTarget.sourceActionId
    }
  };
}

/** Blocks later actions that still depend on a failed framework-workspace prerequisite. */
export function evaluateDependentWorkspaceExecutionBlock(
  action: PlannedAction,
  mode: ActionRunResult["mode"],
  failedDependencies: readonly FailedWorkspaceExecutionDependency[]
): DependentLiveRunTargetBlock | null {
  const workspaceRoot = resolveWorkspaceRootForDependentAction(action, failedDependencies);
  if (!workspaceRoot) {
    return null;
  }
  const failedDependency = failedDependencies.find(
    (candidate) => candidate.workspaceRoot === workspaceRoot
  );
  if (!failedDependency) {
    return null;
  }

  const failureCode = failedDependency.failureCode ?? "ACTION_EXECUTION_FAILED";
  const output =
    `${action.type} skipped: an earlier framework workspace prerequisite failed in ${workspaceRoot} ` +
    `(stage ${failedDependency.stage}). This plan attempt cannot truthfully continue the same ` +
    "local build or preview chain until that prerequisite succeeds.";

  return {
    actionResult: buildBlockedActionResult({
      action,
      mode,
      output,
      executionStatus: "blocked",
      executionFailureCode: failureCode,
      executionMetadata: {
        liveRunDependencyBlocked: true,
        liveRunDependencySourceActionId: failedDependency.sourceActionId,
        liveRunDependencyWorkspaceRoot: failedDependency.workspaceRoot,
        liveRunDependencyStage: failedDependency.stage
      },
      blockedBy: [failureCode],
      violations: [
        {
          code: failureCode,
          message: output
        }
      ]
    }),
    traceDetails: {
      blockCode: failureCode,
      blockCategory: "runtime",
      liveRunDependencyBlocked: true,
      blockedWorkspaceRoot: failedDependency.workspaceRoot,
      blockedDependencyStage: failedDependency.stage,
      blockedSourceActionId: failedDependency.sourceActionId
    }
  };
}
