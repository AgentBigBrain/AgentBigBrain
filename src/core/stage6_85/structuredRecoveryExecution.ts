/**
 * @fileoverview Structured recovery execution builders for bounded Stage 6.85 repair steps.
 */

import type { RecoveryFailureClass, RecoveryRung } from "../autonomy/contracts";
import type { LoopbackTargetHint } from "../autonomy/liveRunRecovery";
import type { ApprovedManagedProcessStartContext } from "../autonomy/loopCleanupPolicy";
import {
  buildManagedProcessConcreteRestartRecoveryInput,
  buildManagedProcessCheckRecoveryInput,
  buildManagedProcessPortConflictRecoveryInput,
  buildManagedProcessStillRunningRetryInput,
  buildManagedProcessStoppedRecoveryInput,
  findManagedProcessStartPortConflictFailure,
  goalExplicitlyRequiresLoopbackPort
} from "../autonomy/liveRunRecovery";
import {
  findApprovedManagedProcessCheckResult,
  findApprovedManagedProcessStartContext,
  findApprovedManagedProcessStartLeaseId
} from "../autonomy/loopCleanupPolicy";
import type { TaskRunResult } from "../types";
import type { StructuredRecoveryPolicyDecision } from "./recovery";

export interface StructuredRecoveryExecutionPlan {
  recoveryClass: RecoveryFailureClass;
  optionId: string;
  allowedRung: RecoveryRung;
  fingerprint: string;
  reasoning: string;
  progressMessage: string;
  nextUserInput: string;
}

export interface StructuredRecoveryExecutionStop {
  recoveryClass: RecoveryFailureClass;
  reason: string;
}

interface ShellRecoveryRepairContext {
  command: string;
  cwd: string | null;
  output: string;
}

const STRUCTURED_RECOVERY_OPTION_MARKER_PATTERN =
  /^\[STRUCTURED_RECOVERY_OPTION:([a-z0-9_]+)\]\s*$/im;
const STRUCTURED_RECOVERY_DEPENDENCY_NAME_PATTERN =
  /\b(?:cannot find package|cannot find module)\s+['"]([^'"]+)['"]|\bno module named\s+['"]?([A-Za-z0-9._-]+)['"]?/i;
const STRUCTURED_RECOVERY_VERSION_HINT_PATTERNS: readonly RegExp[] = [
  /\brequires a peer of\s+([@A-Za-z0-9._/-]+@?[^\s,;)]*)/i,
  /\bcould not resolve dependency:\s+peer\s+([@A-Za-z0-9._/-]+@?[^\s,;)]*)/i,
  /\bconflicting peer dependency:\s+([@A-Za-z0-9._/-]+@?[^\s,;)]*)/i,
  /\bunsupported engine\b[\s\S]{0,120}\bfor\s+([@A-Za-z0-9._/-]+@?[^\s,;)]*)/i
] as const;
const SAFE_PACKAGE_SPECIFIER_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9][a-z0-9._-]*)?$/i;

/**
 * Reads one trimmed string param from an action result when present.
 *
 * @param action - Executed action descriptor.
 * @param key - Param key to read.
 * @returns Trimmed string value, or `null`.
 */
function readActionParamString(
  action: TaskRunResult["actionResults"][number]["action"],
  key: string
): string | null {
  const params = action.params as Record<string, unknown>;
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Collapses structured recovery text into a normalized single-line form.
 *
 * @param value - Raw text to normalize.
 * @returns Normalized text.
 */
function normalizeStructuredRecoveryText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Verifies one dependency or version hint is safe to echo into a shell repair command.
 *
 * @param value - Raw dependency or package-specifier candidate.
 * @returns Safe normalized specifier, or `null` when the value is not shell-safe.
 */
function sanitizeStructuredRecoveryPackageSpecifier(value: string): string | null {
  const normalized = normalizeStructuredRecoveryText(value);
  if (!normalized || !SAFE_PACKAGE_SPECIFIER_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

/**
 * Finds the failed shell action context that produced one structured recovery class.
 *
 * @param result - Task result to inspect.
 * @param recoveryClass - Recovery class to match.
 * @returns Shell repair context, or `null`.
 */
function findRecoveryActionContext(
  result: TaskRunResult,
  recoveryClass: RecoveryFailureClass
): ShellRecoveryRepairContext | null {
  for (const entry of result.actionResults) {
    if (entry.approved || entry.action.type !== "shell_command") {
      continue;
    }
    const nativeRecoveryClass =
      typeof entry.executionMetadata?.recoveryFailureClass === "string"
        ? entry.executionMetadata.recoveryFailureClass
        : null;
    if (nativeRecoveryClass !== recoveryClass) {
      continue;
    }
    const command = readActionParamString(entry.action, "command");
    if (!command) {
      continue;
    }
    return {
      command,
      cwd:
        readActionParamString(entry.action, "cwd") ??
        readActionParamString(entry.action, "workdir"),
      output:
        typeof entry.output === "string"
          ? entry.output
          : typeof entry.executionMetadata?.recoveryFailureDetail === "string"
            ? entry.executionMetadata.recoveryFailureDetail
            : ""
    };
  }
  return null;
}

/**
 * Extracts one dependency or module name from deterministic failure output.
 *
 * @param output - Normalized failure output.
 * @returns Dependency name, or `null`.
 */
function extractStructuredRecoveryDependencyName(output: string): string | null {
  const match = output.match(STRUCTURED_RECOVERY_DEPENDENCY_NAME_PATTERN);
  const dependencyName = match?.[1] ?? match?.[2] ?? null;
  return dependencyName ? dependencyName.trim() : null;
}

/**
 * Extracts one deterministic version or peer-dependency hint from failure output.
 *
 * @param output - Normalized failure output.
 * @returns Version hint, or `null`.
 */
function extractStructuredRecoveryVersionHint(output: string): string | null {
  for (const pattern of STRUCTURED_RECOVERY_VERSION_HINT_PATTERNS) {
    const match = output.match(pattern);
    const hint = match?.[1]?.trim();
    if (hint) {
      return hint;
    }
  }
  return null;
}

/**
 * Infers the workspace package manager from the failed command text.
 *
 * @param command - Original failed command.
 * @returns Package manager hint, or `null`.
 */
function inferRepairPackageManager(command: string): "npm" | "pnpm" | "yarn" | "bun" | null {
  const normalized = normalizeStructuredRecoveryText(command).toLowerCase();
  if (/\bpnpm\b/.test(normalized)) {
    return "pnpm";
  }
  if (/\byarn\b/.test(normalized)) {
    return "yarn";
  }
  if (/\bbun\b/.test(normalized)) {
    return "bun";
  }
  if (/\bnpm\b/.test(normalized)) {
    return "npm";
  }
  return null;
}

/**
 * Builds one narrow package-manager-specific install command for a dependency repair.
 *
 * @param packageManager - Package manager already inferred for the workspace.
 * @param dependencyName - Missing dependency to install.
 * @returns Narrow repair command, or `null`.
 */
function buildNodeRepairCommand(
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | null,
  dependencyName: string
): string | null {
  const safeDependency = sanitizeStructuredRecoveryPackageSpecifier(dependencyName);
  if (!safeDependency) {
    return null;
  }
  switch (packageManager) {
    case "pnpm":
      return `pnpm add ${safeDependency}`;
    case "yarn":
      return `yarn add ${safeDependency}`;
    case "bun":
      return `bun add ${safeDependency}`;
    case "npm":
      return `npm install ${safeDependency}`;
    default:
      return null;
  }
}

/**
 * Builds one bounded dependency or version-alignment repair instruction for the loop.
 *
 * @param repairContext - Failed shell action context.
 * @param optionId - Structured repair option identifier.
 * @param fingerprint - Recovery attempt fingerprint for this repair.
 * @returns Executable repair plan or a fail-closed stop object.
 */
function buildStructuredDependencyRepairInput(
  repairContext: ShellRecoveryRepairContext,
  optionId: "repair_missing_dependency" | "align_dependency_version",
  fingerprint: string
): StructuredRecoveryExecutionPlan | StructuredRecoveryExecutionStop {
  const normalizedOutput = normalizeStructuredRecoveryText(repairContext.output);
  const packageManager = inferRepairPackageManager(repairContext.command);
  if (optionId === "repair_missing_dependency") {
    const dependencyName = extractStructuredRecoveryDependencyName(normalizedOutput);
    if (!dependencyName) {
      return {
        recoveryClass: "DEPENDENCY_MISSING",
        reason:
          "The runtime identified a missing dependency, but it could not deterministically name the missing package or module from the current failure output."
      };
    }
    const safeDependency = sanitizeStructuredRecoveryPackageSpecifier(dependencyName);
    if (!safeDependency) {
      return {
        recoveryClass: "DEPENDENCY_MISSING",
        reason:
          "The runtime identified a missing dependency, but the parsed package or module name was not shell-safe enough for deterministic auto-repair."
      };
    }
    return {
      recoveryClass: "DEPENDENCY_MISSING",
      optionId,
      allowedRung: "bounded_repair_iteration",
      fingerprint,
      reasoning:
        `Detected a missing dependency (${safeDependency}) and scheduled one bounded repair before retrying the original step.`,
      progressMessage:
        "I found a missing dependency. I'm doing one bounded repair and then retrying the original step.",
      nextUserInput: [
        `[STRUCTURED_RECOVERY_OPTION:${optionId}]`,
        `[STRUCTURED_RECOVERY_FINGERPRINT:${fingerprint}]`,
        "This is one bounded deterministic dependency-repair iteration. Keep it narrow.",
        repairContext.cwd ? `Preferred repair cwd: ${repairContext.cwd}` : "",
        `Original failed command: ${repairContext.command}`,
        `Detected missing dependency: ${safeDependency}`,
        packageManager
          ? `Recommended narrow repair command: ${buildNodeRepairCommand(packageManager, safeDependency)}`
          : "Repair only the detected dependency above with the workspace's existing package manager or interpreter.",
        `After the repair, rerun exactly this failed command once: ${repairContext.command}`,
        "Do not broaden this into general upgrades, scaffold resets, or unrelated cleanup. If the bounded repair cannot be completed safely from the current workspace state, stop and explain the exact blocker."
      ]
        .filter((line) => line.length > 0)
        .join("\n")
    };
  }

  const versionHint = extractStructuredRecoveryVersionHint(normalizedOutput);
  if (!versionHint) {
    return {
      recoveryClass: "VERSION_INCOMPATIBLE",
      reason:
        "The runtime identified a version incompatibility, but it could not deterministically extract the conflicting dependency hint from the current failure output."
    };
  }
  const safeVersionHint = sanitizeStructuredRecoveryPackageSpecifier(versionHint);
  if (!safeVersionHint) {
    return {
      recoveryClass: "VERSION_INCOMPATIBLE",
      reason:
        "The runtime identified a version incompatibility, but the parsed dependency hint was not shell-safe enough for deterministic auto-repair."
    };
  }
  return {
    recoveryClass: "VERSION_INCOMPATIBLE",
    optionId,
    allowedRung: "bounded_repair_iteration",
    fingerprint,
    reasoning:
      `Detected a version incompatibility (${safeVersionHint}) and scheduled one bounded alignment pass before retrying the original step.`,
    progressMessage:
      "I found a dependency version mismatch. I'm doing one bounded alignment pass before retrying the original step.",
    nextUserInput: [
      `[STRUCTURED_RECOVERY_OPTION:${optionId}]`,
      `[STRUCTURED_RECOVERY_FINGERPRINT:${fingerprint}]`,
      "This is one bounded deterministic dependency-version repair iteration. Keep it narrow.",
      repairContext.cwd ? `Preferred repair cwd: ${repairContext.cwd}` : "",
      `Original failed command: ${repairContext.command}`,
      `Detected incompatibility hint: ${safeVersionHint}`,
      "Align only the dependency or version relationship named above. Do not run broad upgrade, audit-fix, or full reinstall commands.",
      `After the alignment, rerun exactly this failed command once: ${repairContext.command}`,
      "If the incompatible version cannot be aligned safely from the current workspace state, stop and explain the exact blocker."
    ]
      .filter((line) => line.length > 0)
      .join("\n")
  };
}

/**
 * Detects whether one planner-facing request is already a structured recovery instruction.
 *
 * @param input - Current planner-facing request.
 * @returns `true` when the structured recovery marker is present.
 */
export function isStructuredRecoveryInstruction(input: string): boolean {
  return STRUCTURED_RECOVERY_OPTION_MARKER_PATTERN.test(input);
}

/**
 * Builds one executable structured recovery plan from the latest bounded policy decision.
 *
 * @param input - Goal, task result, tracked process state, and structured recovery decision.
 * @returns Executable recovery plan, fail-closed stop object, or `null` when no plan applies.
 */
export function buildStructuredRecoveryExecutionPlan(input: {
  overarchingGoal: string;
  missionRequiresBrowserProof: boolean;
  result: TaskRunResult;
  decision: StructuredRecoveryPolicyDecision;
  trackedManagedProcessLeaseId: string | null;
  trackedManagedProcessStartContext: ApprovedManagedProcessStartContext | null;
  trackedLoopbackTarget: LoopbackTargetHint | null;
}): StructuredRecoveryExecutionPlan | StructuredRecoveryExecutionStop | null {
  if (
    input.decision.outcome !== "attempt_repair" ||
    !input.decision.optionId ||
    !input.decision.allowedRung ||
    !input.decision.fingerprint ||
    !input.decision.recoveryClass
  ) {
    return null;
  }

  switch (input.decision.optionId) {
    case "retry_with_alternate_port": {
      const failure = findManagedProcessStartPortConflictFailure(input.result);
      if (!failure) {
        return {
          recoveryClass: "PROCESS_PORT_IN_USE",
          reason:
            "The runtime identified a loopback port conflict, but the start-process metadata needed for a safe alternate-port retry was missing."
        };
      }
      if (
        goalExplicitlyRequiresLoopbackPort(
          input.overarchingGoal,
          failure.requestedPort
        )
      ) {
        return {
          recoveryClass: "PROCESS_PORT_IN_USE",
          reason:
            `The requested loopback port ${failure.requestedPort} was explicitly required by the goal, so the runtime cannot switch to a different port automatically.`
        };
      }
      if (failure.suggestedPort === null) {
        return {
          recoveryClass: "PROCESS_PORT_IN_USE",
          reason:
            "The runtime identified a loopback port conflict, but it did not prove a safe alternate port for a bounded retry."
        };
      }
      return {
        recoveryClass: "PROCESS_PORT_IN_USE",
        optionId: input.decision.optionId,
        allowedRung: input.decision.allowedRung,
        fingerprint: input.decision.fingerprint,
        reasoning:
          `Detected a recoverable localhost port conflict on ${failure.requestedPort}; retrying once on alternate port ${failure.suggestedPort}.`,
        progressMessage:
          "The requested localhost port was occupied. I'm retrying once on a free loopback port.",
        nextUserInput: buildManagedProcessPortConflictRecoveryInput(
          failure,
          input.missionRequiresBrowserProof
        )
      };
    }
    case "retry_readiness_proof": {
      const checkedManagedProcess = findApprovedManagedProcessCheckResult(input.result);
      const activeLeaseId =
        findApprovedManagedProcessStartLeaseId(input.result) ??
        checkedManagedProcess?.leaseId ??
        input.trackedManagedProcessLeaseId;
      if (!activeLeaseId) {
        return {
          recoveryClass: "PROCESS_NOT_READY",
          reason:
            "The runtime identified a readiness failure, but there is no tracked managed-process lease to continue from safely."
        };
      }
      const nextUserInput =
        checkedManagedProcess?.lifecycleStatus === "PROCESS_STILL_RUNNING"
          ? buildManagedProcessStillRunningRetryInput(
              activeLeaseId,
              input.missionRequiresBrowserProof,
              input.trackedLoopbackTarget
            )
          : buildManagedProcessCheckRecoveryInput(
              activeLeaseId,
              input.trackedLoopbackTarget,
              input.missionRequiresBrowserProof
            );
      return {
        recoveryClass: "PROCESS_NOT_READY",
        optionId: input.decision.optionId,
        allowedRung: input.decision.allowedRung,
        fingerprint: input.decision.fingerprint,
        reasoning:
          "The local target started, but readiness proof is still missing. Scheduling one bounded continuation against the tracked target.",
        progressMessage:
          "The local target started but isn't ready yet. I'm checking the tracked target and retrying readiness once.",
        nextUserInput
      };
    }
    case "restart_target_then_reverify": {
      const checkedManagedProcess = findApprovedManagedProcessCheckResult(input.result);
      const activeLeaseId =
        checkedManagedProcess?.leaseId ?? input.trackedManagedProcessLeaseId;
      const approvedStartContext =
        findApprovedManagedProcessStartContext(input.result) ??
        input.trackedManagedProcessStartContext;
      if (!activeLeaseId) {
        return {
          recoveryClass: "TARGET_NOT_RUNNING",
          reason:
            "The runtime identified a stopped local target, but there is no tracked managed-process lease to restart safely."
        };
      }
      return {
        recoveryClass: "TARGET_NOT_RUNNING",
        optionId: input.decision.optionId,
        allowedRung: input.decision.allowedRung,
        fingerprint: input.decision.fingerprint,
        reasoning:
          "The tracked local target stopped before proof completed. Scheduling one bounded restart-and-reverify pass.",
        progressMessage:
          "The tracked local target stopped before proof completed. I'm doing one restart-and-reverify pass.",
        nextUserInput:
          approvedStartContext &&
          approvedStartContext.leaseId === activeLeaseId &&
          approvedStartContext.command
            ? buildManagedProcessConcreteRestartRecoveryInput(
                {
                  leaseId: activeLeaseId,
                  command: approvedStartContext.command,
                  cwd: approvedStartContext.cwd
                },
                input.trackedLoopbackTarget,
                input.missionRequiresBrowserProof
              )
            : buildManagedProcessStoppedRecoveryInput(
                activeLeaseId,
                input.trackedLoopbackTarget,
                input.missionRequiresBrowserProof
              )
      };
    }
    case "repair_missing_dependency":
    case "align_dependency_version": {
      const repairContext = findRecoveryActionContext(
        input.result,
        input.decision.recoveryClass
      );
      if (!repairContext) {
        return null;
      }
      return buildStructuredDependencyRepairInput(
        repairContext,
        input.decision.optionId,
        input.decision.fingerprint
      );
    }
    default:
      return {
        recoveryClass: input.decision.recoveryClass,
        reason:
          `No structured repair builder exists yet for recovery option ${input.decision.optionId}.`
      };
  }
}
