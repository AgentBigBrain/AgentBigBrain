/**
 * @fileoverview Owns loopback-target inference and deterministic live-run recovery prompts for autonomy.
 */
import type { TaskRunResult } from "../types";
import { buildManagedProcessBrowserOpenRetryInput } from "./liveRunRecoveryPromptSupport";
export interface ManagedProcessStartPortConflictFailure {
  command: string;
  cwd: string | null;
  requestedPort: number;
  requestedUrl: string;
  suggestedPort: number | null;
  suggestedUrl: string | null;
}

export interface LoopbackTargetHint {
  url: string | null;
  host: string | null;
  port: number | null;
}

export interface ManagedProcessRestartContext {
  leaseId: string;
  command: string;
  cwd: string | null;
}

type ActionResultEntry = TaskRunResult["actionResults"][number];

/**
 * Normalizes text for deterministic case-insensitive recovery checks.
 *
 * **Why it exists:**
 * Live-run recovery compares command and hostname text from several actions, so the comparisons
 * need one stable normalization path.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param input - Source text to normalize.
 * @returns Lower-cased normalized text.
 */
function normalizeRecoveryText(input: string): string {
  return input.trim().toLowerCase();
}

/** Escapes a string for inclusion inside quoted structured-recovery instructions. */
function escapeRecoveryQuotedString(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Reads one string action param when present.
 *
 * **Why it exists:**
 * Loopback-target recovery reads command, url, host, and cwd params from several action types, so
 * this helper keeps those casts in one deterministic place.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param action - Planned action executed in task runner.
 * @param key - Param key to read.
 * @returns Trimmed string param value, or `null`.
 */
function readActionStringParam(
  action: ActionResultEntry["action"],
  key: string
): string | null {
  const params = action.params as Record<string, unknown>;
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Reads one numeric action param when present.
 *
 * **Why it exists:**
 * Loopback-target recovery needs stable host or port metadata without scattering numeric casts
 * across several action-type branches.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param action - Planned action executed in task runner.
 * @param key - Param key to read.
 * @returns Integer param value, or `null`.
 */
function readActionIntegerParam(
  action: ActionResultEntry["action"],
  key: string
): number | null {
  const params = action.params as Record<string, unknown>;
  const value = params[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * Reads an action command string when the action carries one.
 *
 * **Why it exists:**
 * Managed-process port-conflict recovery needs the original shell command so it can rewrite only
 * the loopback port instead of inventing a fresh command.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param action - Planned action executed in task runner.
 * @returns Command text, or an empty string when no command is present.
 */
function readActionCommandText(action: ActionResultEntry["action"]): string {
  const params = action.params as Record<string, unknown>;
  return typeof params.command === "string" ? params.command : "";
}

/**
 * Evaluates whether one hostname is loopback-local.
 *
 * **Why it exists:**
 * Recovery prompts should only carry forward loopback-local targets that already passed hard
 * constraints, never arbitrary hostnames parsed from free-form planner text.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param hostname - Raw hostname candidate.
 * @returns `true` when the hostname is localhost, 127.0.0.1, or ::1.
 */
function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeRecoveryText(hostname).replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * Normalizes one loopback URL into a stable retry-target shape.
 *
 * **Why it exists:**
 * Managed-process recovery needs one canonical url or host or port tuple so later retries stay on
 * the same loopback target instead of drifting to planner defaults.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param rawUrl - URL candidate from action params or execution metadata.
 * @returns Canonical loopback target, or `null` when the URL is invalid or non-loopback.
 */
function normalizeLoopbackTargetUrl(rawUrl: string | null): LoopbackTargetHint | null {
  if (!rawUrl) {
    return null;
  }
  try {
    const parsedUrl = new URL(rawUrl);
    if (!isLoopbackHostname(parsedUrl.hostname)) {
      return null;
    }
    const port = parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : null;
    const canonicalPort = Number.isInteger(port) ? port : null;
    const pathname = parsedUrl.pathname && parsedUrl.pathname !== "/" ? parsedUrl.pathname : "";
    const search = parsedUrl.search ?? "";
    return {
      url: `${parsedUrl.protocol}//${parsedUrl.hostname}${canonicalPort ? `:${canonicalPort}` : ""}${pathname}${search}`,
      host: parsedUrl.hostname,
      port: canonicalPort
    };
  } catch {
    return null;
  }
}

/**
 * Resolves a canonical loopback target from action execution metadata when present.
 *
 * @param entry - Action result entry from task execution.
 * @returns Canonical loopback target, or `null`.
 */
function extractLoopbackTargetHintFromMetadata(
  entry: ActionResultEntry
): LoopbackTargetHint | null {
  const metadataTarget =
    normalizeLoopbackTargetUrl(
      typeof entry.executionMetadata?.processRequestedUrl === "string"
        ? entry.executionMetadata.processRequestedUrl
        : null
    ) ??
    normalizeLoopbackTargetUrl(
      typeof entry.executionMetadata?.probeUrl === "string"
        ? entry.executionMetadata.probeUrl
        : typeof entry.executionMetadata?.browserVerifyUrl === "string"
          ? entry.executionMetadata.browserVerifyUrl
          : null
    );
  if (metadataTarget) {
    return metadataTarget;
  }

  const metadataHost =
    typeof entry.executionMetadata?.processRequestedHost === "string"
      ? entry.executionMetadata.processRequestedHost
      : null;
  const metadataPort =
    typeof entry.executionMetadata?.processRequestedPort === "number" &&
    Number.isInteger(entry.executionMetadata.processRequestedPort)
      ? entry.executionMetadata.processRequestedPort
      : null;
  if (metadataHost && metadataPort !== null && isLoopbackHostname(metadataHost)) {
    return {
      url: `http://${metadataHost === "::1" ? "[::1]" : metadataHost}:${metadataPort}`,
      host: metadataHost,
      port: metadataPort
    };
  }
  return null;
}

/**
 * Parses one probable loopback port from a managed-process command.
 *
 * **Why it exists:**
 * Start-process recovery may need to recover the target port even before any probe action runs, so
 * this helper extracts bounded local-server port conventions from trusted command params.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param command - Shell or process command text.
 * @returns Parsed loopback target, or `null` when no supported local port pattern is found.
 */
function inferLoopbackTargetFromCommand(command: string): LoopbackTargetHint | null {
  const normalized = normalizeRecoveryText(command);
  const explicitHostMatch =
    normalized.match(/(?:^|\s)(?:--bind|--host)\s+(127\.0\.0\.1|localhost|::1)\b/) ??
    normalized.match(/\b(127\.0\.0\.1|localhost|::1):\d{2,5}\b/);
  const host = explicitHostMatch?.[1] ?? "localhost";
  const patterns = [
    /\bhttp\.server\s+(\d{2,5})\b/,
    /\b--port\s+(\d{2,5})\b/,
    /\b-p\s+(\d{2,5})\b/,
    /\b(?:localhost|127\.0\.0\.1|::1):(\d{2,5})\b/
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) {
      continue;
    }
    const port = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isInteger(port)) {
      continue;
    }
    return {
      url: `http://${host === "::1" ? "[::1]" : host}:${port}`,
      host,
      port
    };
  }
  return null;
}

/**
 * Extracts a canonical loopback target from one action result when present.
 *
 * **Why it exists:**
 * Managed-process recovery should keep using the real loopback target chosen by the plan or
 * executor instead of forcing later subtasks to rediscover that target from natural language.
 *
 * **What it talks to:**
 * - Uses local action-param helpers within this module.
 * - Uses local loopback-target parsers within this module.
 *
 * @param entry - Action result entry from task execution.
 * @returns Canonical loopback target, or `null` when no target can be derived.
 */
function extractLoopbackTargetHint(entry: ActionResultEntry): LoopbackTargetHint | null {
  const metadataTarget = extractLoopbackTargetHintFromMetadata(entry);
  if (metadataTarget) {
    return metadataTarget;
  }
  if (entry.action.type === "probe_http" || entry.action.type === "verify_browser") {
    return (
      normalizeLoopbackTargetUrl(readActionStringParam(entry.action, "url")) ??
      normalizeLoopbackTargetUrl(
        typeof entry.executionMetadata?.probeUrl === "string"
          ? entry.executionMetadata.probeUrl
          : typeof entry.executionMetadata?.browserVerifyUrl === "string"
            ? entry.executionMetadata.browserVerifyUrl
            : null
      )
    );
  }
  if (entry.action.type === "probe_port") {
    const host = readActionStringParam(entry.action, "host");
    const port = readActionIntegerParam(entry.action, "port");
    if (host && port !== null && isLoopbackHostname(host)) {
      return {
        url: `http://${host}:${port}`,
        host,
        port
      };
    }
    return null;
  }
  if (entry.action.type === "start_process") {
    const command = readActionStringParam(entry.action, "command");
    return command ? inferLoopbackTargetFromCommand(command) : null;
  }
  return null;
}

/**
 * Finds a managed-process start failure caused by an already-occupied loopback port.
 *
 * **Why it exists:**
 * Recovery for polluted localhost ports should use typed executor metadata instead of scraping
 * human-readable failure strings, so this helper centralizes that start-failure extraction.
 *
 * **What it talks to:**
 * - Uses local action-param helpers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Structured port-conflict failure details, or `null` when absent.
 */
export function findManagedProcessStartPortConflictFailure(
  result: TaskRunResult
): ManagedProcessStartPortConflictFailure | null {
  for (const entry of result.actionResults) {
    if (entry.approved || entry.action.type !== "start_process") {
      continue;
    }
    if (entry.executionFailureCode !== "PROCESS_START_FAILED") {
      continue;
    }
    const failureKind = entry.executionMetadata?.processStartupFailureKind;
    const requestedPort = entry.executionMetadata?.processRequestedPort;
    const requestedUrl = entry.executionMetadata?.processRequestedUrl;
    if (
      failureKind !== "PORT_IN_USE" ||
      typeof requestedPort !== "number" ||
      !Number.isInteger(requestedPort) ||
      typeof requestedUrl !== "string" ||
      requestedUrl.trim().length === 0
    ) {
      continue;
    }
    const suggestedPort = entry.executionMetadata?.processSuggestedPort;
    const suggestedUrl = entry.executionMetadata?.processSuggestedUrl;
    return {
      command: readActionCommandText(entry.action),
      cwd:
        readActionStringParam(entry.action, "cwd") ??
        readActionStringParam(entry.action, "workdir") ??
        (typeof entry.executionMetadata?.processCwd === "string"
          ? entry.executionMetadata.processCwd
          : null),
      requestedPort,
      requestedUrl: requestedUrl.trim(),
      suggestedPort:
        typeof suggestedPort === "number" && Number.isInteger(suggestedPort)
          ? suggestedPort
          : null,
      suggestedUrl:
        typeof suggestedUrl === "string" && suggestedUrl.trim().length > 0
          ? suggestedUrl.trim()
          : null
    };
  }
  return null;
}

/**
 * Evaluates whether the original mission explicitly requires one concrete loopback port.
 *
 * **Why it exists:**
 * Port-conflict recovery is only allowed to move to a different loopback port when the user did
 * not explicitly pin the workflow to the conflicting port in the overarching goal.
 *
 * **What it talks to:**
 * - Uses local normalization helpers within this module.
 *
 * @param goal - Mission-level goal text.
 * @param port - Loopback port under consideration.
 * @returns `true` when the goal text explicitly pins this port.
 */
export function goalExplicitlyRequiresLoopbackPort(goal: string, port: number): boolean {
  const normalized = normalizeRecoveryText(goal);
  return (
    new RegExp(`(?:localhost|127\\.0\\.0\\.1|::1)\\s*:\\s*${port}\\b`, "i").test(normalized) ||
    new RegExp(`\\bport\\s+${port}\\b`, "i").test(normalized)
  );
}

/**
 * Rewrites one loopback server command to use a different concrete port.
 *
 * **Why it exists:**
 * Deterministic recovery should preserve the original server command shape whenever possible, only
 * swapping the conflicting loopback port so the restart instruction stays truthful and precise.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param command - Original managed-process command text.
 * @param fromPort - Conflicting port that must be replaced.
 * @param toPort - Alternate free loopback port to inject.
 * @returns Rewritten command text.
 */
function rewriteManagedProcessLoopbackPort(
  command: string,
  fromPort: number,
  toPort: number
): string {
  return command
    .replace(new RegExp(`(\\bhttp\\.server\\s+)${fromPort}\\b`, "i"), `$1${toPort}`)
    .replace(new RegExp(`(\\b--port\\s+)${fromPort}\\b`, "i"), `$1${toPort}`)
    .replace(new RegExp(`(\\b-p\\s+)${fromPort}\\b`, "i"), `$1${toPort}`)
    .replace(new RegExp(`(localhost:)${fromPort}\\b`, "i"), `$1${toPort}`)
    .replace(new RegExp(`(127\\.0\\.0\\.1:)${fromPort}\\b`, "i"), `$1${toPort}`);
}

/**
 * Builds a deterministic restart instruction after one loopback-port conflict.
 *
 * **Why it exists:**
 * When the planned localhost port is already occupied, the fastest truthful recovery is to restart
 * the same local server on a concrete free loopback port instead of making the model rediscover a
 * new port from scratch.
 *
 * **What it talks to:**
 * - Uses local command-rewrite helpers within this module.
 *
 * @param failure - Typed managed-process port-conflict failure details.
 * @param requireBrowserProof - When `true`, keeps the restart scoped to readiness before browser proof.
 * @returns Explicit restart subtask instruction.
 */
export function buildManagedProcessPortConflictRecoveryInput(
  failure: ManagedProcessStartPortConflictFailure,
  requireBrowserProof = false
): string {
  const suggestedPort = failure.suggestedPort;
  const suggestedUrl =
    failure.suggestedUrl ??
    (suggestedPort !== null ? `http://localhost:${suggestedPort}` : failure.requestedUrl);
  const rewrittenCommand =
    suggestedPort !== null
      ? rewriteManagedProcessLoopbackPort(
          failure.command,
          failure.requestedPort,
          suggestedPort
        )
      : failure.command;
  const cwdClause = failure.cwd ? ` cwd="${failure.cwd}"` : "";
  return (
    `start_process cmd="${rewrittenCommand}"${cwdClause}. ` +
    `The requested localhost port ${failure.requestedPort} was already occupied, so restart ` +
    `${suggestedPort !== null ? `the local server on free loopback port ${suggestedPort}` : "the local server on a different free loopback port"} instead. ` +
    `After start succeeds, prove readiness with probe_http url="${suggestedUrl}" before any page-level proof. ` +
    `${requireBrowserProof ? "Only continue to verify_browser after readiness passes." : "Do not claim success until readiness passes."}`
  );
}

/**
 * Detects whether a task result contains a failed localhost readiness probe.
 *
 * **Why it exists:**
 * Managed-process recovery should react specifically to typed readiness failures, not every blocked
 * live-run action, so this helper keeps the signal narrow and deterministic.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @returns `true` when a probe action failed with `PROCESS_NOT_READY`.
 */
export function hasReadinessNotReadyFailure(result: TaskRunResult): boolean {
  return result.actionResults.some((entry) =>
    !entry.approved &&
    (entry.action.type === "probe_port" || entry.action.type === "probe_http") &&
    (
      entry.executionFailureCode === "PROCESS_NOT_READY" ||
      entry.blockedBy.some((blockCode) => blockCode === "PROCESS_NOT_READY")
    )
  );
}

/**
 * Updates the tracked loopback target after one autonomous-loop iteration.
 *
 * **Why it exists:**
 * Readiness retries need to stay pinned to the original localhost url or port even if later
 * planner subtasks drift to a generic default. This helper preserves the first trusted target
 * until a new approved managed-process start replaces it.
 *
 * **What it talks to:**
 * - Uses local loopback-target extraction helpers within this module.
 *
 * @param previousTarget - Target tracked before this iteration, if any.
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Loopback target that should remain tracked for later recovery, or `null`.
 */
export function resolveTrackedLoopbackTarget(
  previousTarget: LoopbackTargetHint | null,
  result: TaskRunResult
): LoopbackTargetHint | null {
  let trackedTarget = previousTarget;
  for (const entry of result.actionResults) {
    const candidate = extractLoopbackTargetHint(entry);
    if (!candidate) {
      continue;
    }
    if (entry.action.type === "start_process" && entry.approved) {
      trackedTarget = candidate;
      continue;
    }
    if (!trackedTarget) {
      trackedTarget = candidate;
    }
  }
  return trackedTarget;
}

/**
 * Formats one loopback target for deterministic recovery prompts.
 *
 * **Why it exists:**
 * Human-readable recovery instructions should carry the exact localhost target without rebuilding it
 * ad hoc at each call site.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param target - Tracked loopback target, if any.
 * @returns Readable target label or `null`.
 */
export function describeLoopbackTarget(target: LoopbackTargetHint | null): string | null {
  if (!target) {
    return null;
  }
  if (target.url) {
    return target.url;
  }
  if (target.host && target.port !== null) {
    return `${target.host}:${target.port}`;
  }
  return null;
}

/** Builds the first bounded readiness-recovery instruction after a managed process starts but localhost is not ready yet. */
export function buildManagedProcessCheckRecoveryInput(
  leaseId: string,
  target: LoopbackTargetHint | null,
  requireHttpReachability = false
): string {
  const targetLabel = describeLoopbackTarget(target);
  const retryInstruction = requireHttpReachability
    ? target?.url
      ? `retry probe_http url="${target.url}" once`
      : "retry probe_http once"
    : target?.url && target.host && target.port !== null
      ? `retry probe_http url="${target.url}" or probe_port host="${target.host}" port=${target.port} once`
      : "retry probe_port or probe_http once";
  return (
    `check_process leaseId="${leaseId}". ` +
    `Managed process lease ${leaseId} started, but localhost was not ready yet${targetLabel ? ` at ${targetLabel}` : ""}. ` +
    `If the lease is still running, ${retryInstruction}. ` +
    "If you need to restart, use start_process with only supported params (`command`, `cwd`/`workdir`, `requestedShellKind`, optional `timeoutMs`). " +
    'Set `requestedShellKind` to `zsh` instead of wrapping the command in `zsh -lc` or `bash -lc`. ' +
    "Only continue to page-level proof after readiness passes. " +
    "If the lease already stopped, explain that plainly and restart once if needed."
  );
}

/** Builds the bounded readiness retry once `check_process` proves the managed process is still running. */
export function buildManagedProcessStillRunningRetryInput(
  leaseId: string,
  requireHttpReachability = false,
  target: LoopbackTargetHint | null = null
): string {
  if (requireHttpReachability) {
    if (target?.url) {
      return (
        `probe_http url="${target.url}". ` +
        `Managed process lease ${leaseId} is still running, but actual localhost HTTP readiness is still not proven at ${target.url}. ` +
        "Do not invent `profile` keys on restart actions; use supported start_process params only. " +
        "If you still do not get an HTTP response, stop and explain plainly that the running process never became HTTP-ready before any page-level proof."
      );
    }
    return (
      "probe_http on the expected loopback URL. " +
      `Managed process lease ${leaseId} is still running, but actual localhost HTTP readiness is still not proven. ` +
      "Do not invent `profile` keys on restart actions; use supported start_process params only. " +
      "Use probe_port only if the URL is still unknown, and return to probe_http before any page-level proof."
    );
  }
  if (target?.url && target.host && target.port !== null) {
    return (
      `probe_http url="${target.url}" or probe_port host="${target.host}" port=${target.port}. ` +
      `Managed process lease ${leaseId} is still running, but localhost readiness is still not proven at ${target.url}. ` +
      "Wait for readiness proof before doing any page-level proof."
    );
  }
  return (
    "probe_port or probe_http on the expected loopback target. " +
    `Managed process lease ${leaseId} is still running, but localhost readiness is still not proven. ` +
    "Wait for readiness proof before doing any page-level proof."
  );
}

/** Builds the bounded restart instruction after `check_process` proves the managed process already stopped. */
export function buildManagedProcessStoppedRecoveryInput(
  leaseId: string,
  target: LoopbackTargetHint | null = null,
  requireHttpReachability = false
): string {
  const targetLabel = describeLoopbackTarget(target);
  const proofInstruction = requireHttpReachability
    ? target?.url
      ? `prove HTTP readiness at ${target.url} before any page-level proof`
      : "prove HTTP readiness before any page-level proof"
    : target?.url
      ? `prove localhost readiness at ${target.url} before any page-level proof`
      : "prove localhost readiness before any page-level proof";
  return (
    `Managed process lease ${leaseId} stopped before localhost readiness was proven${targetLabel ? ` for ${targetLabel}` : ""}. ` +
    `Explain the stop result plainly, restart the local server once if needed, and ${proofInstruction}. ` +
    "When restarting, use start_process with supported params only (`command`, `cwd`/`workdir`, `requestedShellKind`, optional `timeoutMs`) " +
    "and prefer a raw server command instead of `zsh -lc` wrappers."
  );
}

/** Builds a concrete restart-and-reverify instruction pinned to the last approved `start_process`. */
export function buildManagedProcessConcreteRestartRecoveryInput(
  context: ManagedProcessRestartContext,
  target: LoopbackTargetHint | null = null,
  requireHttpReachability = false
): string {
  const targetLabel = describeLoopbackTarget(target);
  const proofInstruction = requireHttpReachability
    ? target?.url
      ? `prove HTTP readiness at ${target.url} before any page-level proof`
      : "prove HTTP readiness before any page-level proof"
    : target?.url
      ? `prove localhost readiness at ${target.url} before any page-level proof`
      : "prove localhost readiness before any page-level proof";
  const cwdClause = context.cwd ? ` cwd="${escapeRecoveryQuotedString(context.cwd)}"` : "";
  return (
    `start_process cmd="${escapeRecoveryQuotedString(context.command)}"${cwdClause}. ` +
    `Managed process lease ${context.leaseId} stopped before localhost readiness was proven${targetLabel ? ` for ${targetLabel}` : ""}. ` +
    `Restart the same local server once and ${proofInstruction}. ` +
    "Only use start_process, check_process, probe_http, probe_port, verify_browser, open_browser, or respond in this recovery pass. " +
    "Do not use shell_command, write_file, scaffold, install, or other file-mutation actions."
  );
}
