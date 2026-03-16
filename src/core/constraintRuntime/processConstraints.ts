import path from "node:path";

import { BrainConfig } from "../config";
import { getNumberParam, getStringParam } from "../hardConstraintParamUtils";
import { isPathWithinPrefix, isProtectedPath } from "../hardConstraintPathPolicy";
import { containsDangerousCommand, extractShellPathTargets } from "../hardConstraintShellPolicy";
import { ConstraintViolation } from "../types";

/**
 * Chooses the action-specific violation code for a shared shell/process constraint branch.
 *
 * @param actionType - Shell-like action type being evaluated.
 * @param shellCode - Violation code used for `shell_command`.
 * @param processCode - Violation code used for `start_process`.
 * @returns The action-specific violation code.
 */
function resolveShellLikeConstraintCode(
  actionType: "shell_command" | "start_process",
  shellCode:
    | "SHELL_DISABLED_BY_POLICY"
    | "SHELL_MISSING_COMMAND"
    | "SHELL_COMMAND_TOO_LONG"
    | "SHELL_PROFILE_MISMATCH"
    | "SHELL_CWD_OUTSIDE_SANDBOX"
    | "SHELL_DANGEROUS_COMMAND"
    | "SHELL_TARGETS_PROTECTED_PATH",
  processCode:
    | "PROCESS_DISABLED_BY_POLICY"
    | "PROCESS_MISSING_COMMAND"
    | "PROCESS_COMMAND_TOO_LONG"
    | "PROCESS_PROFILE_MISMATCH"
    | "PROCESS_CWD_OUTSIDE_SANDBOX"
    | "PROCESS_DANGEROUS_COMMAND"
    | "PROCESS_TARGETS_PROTECTED_PATH"
): ConstraintViolation["code"] {
  return actionType === "shell_command" ? shellCode : processCode;
}

/**
 * Validates shell-command and start-process actions against policy, cwd, command, and protected-path rules.
 *
 * @param actionType - Shell-like action being evaluated.
 * @param params - Planned action params.
 * @param config - Active brain config with shell-runtime policy.
 * @returns Constraint violations for invalid shell-like requests.
 */
export function evaluateShellLikeActionConstraints(
  actionType: "shell_command" | "start_process",
  params: Record<string, unknown>,
  config: BrainConfig
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];

  if (!config.permissions.allowShellCommandAction) {
    violations.push({
      code: resolveShellLikeConstraintCode(
        actionType,
        "SHELL_DISABLED_BY_POLICY",
        "PROCESS_DISABLED_BY_POLICY"
      ),
      message:
        actionType === "shell_command"
          ? "Shell command actions are disabled in current runtime profile."
          : "Managed process actions are disabled in current runtime profile."
    });
  }

  const command = getStringParam(params, "command");
  if (!command) {
    violations.push({
      code: resolveShellLikeConstraintCode(
        actionType,
        "SHELL_MISSING_COMMAND",
        "PROCESS_MISSING_COMMAND"
      ),
      message:
        actionType === "shell_command"
          ? "Shell command action requires a command string."
          : "Managed process start requires a command string."
    });
    return violations;
  }

  if (command.length > config.shellRuntime.profile.commandMaxChars) {
    violations.push({
      code: resolveShellLikeConstraintCode(
        actionType,
        "SHELL_COMMAND_TOO_LONG",
        "PROCESS_COMMAND_TOO_LONG"
      ),
      message:
        actionType === "shell_command"
          ? `Shell command length ${command.length} exceeds max ${config.shellRuntime.profile.commandMaxChars}.`
          : `Managed process command length ${command.length} exceeds max ${config.shellRuntime.profile.commandMaxChars}.`
    });
  } else if (containsDangerousCommand(command)) {
    violations.push({
      code: resolveShellLikeConstraintCode(
        actionType,
        "SHELL_DANGEROUS_COMMAND",
        "PROCESS_DANGEROUS_COMMAND"
      ),
      message: "Command matches denied destructive patterns."
    });
  }

  const requestedShellKind = getStringParam(params, "requestedShellKind");
  if (requestedShellKind && requestedShellKind !== config.shellRuntime.profile.shellKind) {
    violations.push({
      code: resolveShellLikeConstraintCode(
        actionType,
        "SHELL_PROFILE_MISMATCH",
        "PROCESS_PROFILE_MISMATCH"
      ),
      message:
        `Requested shell '${requestedShellKind}' does not match resolved runtime shell ` +
        `'${config.shellRuntime.profile.shellKind}'.`
    });
  }

  const shellCwd = getStringParam(params, "cwd") ?? getStringParam(params, "workdir");
  if (shellCwd) {
    if (!config.shellRuntime.profile.cwdPolicy.allowRelative && !path.isAbsolute(shellCwd)) {
      violations.push({
        code: resolveShellLikeConstraintCode(
          actionType,
          "SHELL_CWD_OUTSIDE_SANDBOX",
          "PROCESS_CWD_OUTSIDE_SANDBOX"
        ),
        message:
          actionType === "shell_command"
            ? "Shell command cwd must be absolute when relative cwd is disabled."
            : "Managed process cwd must be absolute when relative cwd is disabled."
      });
    }

    if (
      config.shellRuntime.profile.cwdPolicy.denyOutsideSandbox &&
      !isPathWithinPrefix(shellCwd, config.dna.sandboxPathPrefix)
    ) {
      violations.push({
        code: resolveShellLikeConstraintCode(
          actionType,
          "SHELL_CWD_OUTSIDE_SANDBOX",
          "PROCESS_CWD_OUTSIDE_SANDBOX"
        ),
        message:
          actionType === "shell_command"
            ? `Shell command cwd must stay inside sandbox (${config.dna.sandboxPathPrefix}).`
            : `Managed process cwd must stay inside sandbox (${config.dna.sandboxPathPrefix}).`
      });
    }
  }

  const protectedTarget = extractShellPathTargets(params).find((targetPath) =>
    isProtectedPath(targetPath, config)
  );
  if (protectedTarget) {
    violations.push({
      code: resolveShellLikeConstraintCode(
        actionType,
        "SHELL_TARGETS_PROTECTED_PATH",
        "PROCESS_TARGETS_PROTECTED_PATH"
      ),
      message:
        actionType === "shell_command"
          ? `Shell command targets protected path: ${protectedTarget}`
          : `Managed process command targets protected path: ${protectedTarget}`
    });
  }

  return violations;
}

/**
 * Validates shell-command timeout parameters against configured timeout bounds.
 *
 * @param params - Planned shell-command params.
 * @param config - Active brain config with timeout bounds.
 * @returns Constraint violations when timeoutMs is outside the allowed range.
 */
export function evaluateShellCommandTimeoutConstraints(
  params: Record<string, unknown>,
  config: BrainConfig
): ConstraintViolation[] {
  if (!Object.prototype.hasOwnProperty.call(params, "timeoutMs")) {
    return [];
  }

  const timeoutMs = getNumberParam(params, "timeoutMs");
  if (
    timeoutMs !== undefined &&
    Number.isInteger(timeoutMs) &&
    timeoutMs >= config.shellRuntime.timeoutBoundsMs.min &&
    timeoutMs <= config.shellRuntime.timeoutBoundsMs.max
  ) {
    return [];
  }

  return [
    {
      code: "SHELL_TIMEOUT_INVALID",
      message:
        "Shell command timeoutMs must be an integer " +
        `within ${config.shellRuntime.timeoutBoundsMs.min}..` +
        `${config.shellRuntime.timeoutBoundsMs.max}.`
    }
  ];
}

/**
 * Ensures process-check and process-stop actions include the exact identity needed for safe control.
 *
 * @param actionType - Managed-process action being evaluated.
 * @param params - Planned action params.
 * @returns Constraint violations when the required lease id or recovered pid is missing.
 */
export function evaluateManagedProcessLeaseConstraints(
  actionType: "check_process" | "stop_process",
  params: Record<string, unknown>
): ConstraintViolation[] {
  const leaseId = getStringParam(params, "leaseId");
  if (leaseId) {
    return [];
  }

  if (actionType === "stop_process") {
    const pid = getNumberParam(params, "pid");
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
      return [];
    }
  }

  return [
    {
      code: "PROCESS_MISSING_LEASE_ID",
      message:
        actionType === "check_process"
          ? "Process check requires a leaseId."
          : "Process stop requires a leaseId or recovered pid."
    }
  ];
}
