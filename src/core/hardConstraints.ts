/**
 * @fileoverview Enforces non-negotiable deterministic safety constraints before governance voting.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { BrainConfig } from "./config";
import { estimateActionCostUsd } from "./actionCostPolicy";
import {
  getNumberParam,
  getStringParam
} from "./hardConstraintParamUtils";
import {
  containsImpersonationSignal,
  containsPersonalDataSignal,
  hasExplicitHumanApproval,
  isCommunicationAction
} from "./hardConstraintCommunicationPolicy";
import {
  isPathWithinPrefix,
  isProtectedPath,
  resolveSandboxPath as resolveSandboxPathFromPolicy
} from "./hardConstraintPathPolicy";
import {
  containsDangerousCommand,
  extractShellPathTargets
} from "./hardConstraintShellPolicy";
import { ConstraintViolation, GovernanceProposal } from "./types";

const SKILL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_SKILL_CODE_LENGTH = 20_000;
const SKILL_CALLABLE_EXPORT_PATTERNS: readonly RegExp[] = [
  /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(/,
  /\bexport\s+const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
  /\bexport\s+const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(?:async\s*)?function\s*\(/
];
const SKILL_UNSAFE_CODE_PATTERNS: readonly RegExp[] = [
  /\beval\s*\(/i,
  /\bnew\s+Function\s*\(/i,
  /\bFunction\s*\(\s*["'`]/i,
  /\bchild_process\b/i,
  /\bprocess\.env\b/i,
  /\bprocess\.exit\s*\(/i,
  /\bimport\s*\(\s*["'`](?:node:)?(?:fs|child_process|worker_threads|vm|net|tls|http|https)\b/i,
  /\brequire\s*\(\s*["'`](?:node:)?(?:fs|child_process|worker_threads|vm|net|tls|http|https)\b/i
];
const STAGE_6_86_MEMORY_STORES = new Set(["entity_graph", "conversation_stack", "pulse_state"]);
const STAGE_6_86_MEMORY_OPERATIONS = new Set(["upsert", "merge", "supersede", "resolve", "evict"]);
const STAGE_6_86_PULSE_KINDS = new Set([
  "bridge_question",
  "open_loop_resume",
  "topic_resume",
  "stale_fact_revalidation"
]);

export interface ConstraintEvaluationContext {
  cumulativeEstimatedCostUsd: number;
}

/**
 * Validates dynamic skill names against the deterministic allowlist regex.
 *
 * **Why it exists:**
 * Skill creation must reject malformed/unbounded names before any code payload checks run.
 *
 * **What it talks to:**
 * - Reads `SKILL_NAME_PATTERN`.
 *
 * @param skillName - Proposed skill name from `create_skill` action params.
 * @returns `true` when the name matches allowed characters and length constraints.
 */
function isValidSkillName(skillName: string): boolean {
  return SKILL_NAME_PATTERN.test(skillName);
}

/**
 * Removes comments and whitespace from skill source for executable-content checks.
 *
 * **Why it exists:**
 * `create_skill` validation should reject empty/non-executable payloads even when code is padded
 * with comments or whitespace.
 *
 * **What it talks to:**
 * - Local regex stripping only.
 *
 * @param code - Raw skill source code.
 * @returns Source text with comments and all whitespace removed.
 */
function stripCodeCommentsAndWhitespace(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, "")
    .trim();
}

/**
 * Checks whether skill source exports at least one callable entrypoint.
 *
 * **Why it exists:**
 * `create_skill` should fail closed if code does not expose an executable export.
 *
 * **What it talks to:**
 * - Reads `SKILL_CALLABLE_EXPORT_PATTERNS`.
 *
 * @param code - Skill source code candidate.
 * @returns `true` when one supported export signature is present.
 */
function hasCallableSkillExport(code: string): boolean {
  return SKILL_CALLABLE_EXPORT_PATTERNS.some((pattern) => pattern.test(code));
}

/**
 * Detects disallowed runtime capabilities in skill source code.
 *
 * **Why it exists:**
 * Dynamic skills must not gain unsafe host capabilities (eval, child processes, env exfiltration,
 * unsafe imports, etc.).
 *
 * **What it talks to:**
 * - Reads `SKILL_UNSAFE_CODE_PATTERNS`.
 *
 * @param code - Skill source code candidate.
 * @returns `true` when any unsafe code pattern is present.
 */
function containsUnsafeSkillCode(code: string): boolean {
  return SKILL_UNSAFE_CODE_PATTERNS.some((pattern) => pattern.test(code));
}

/**
 * Resolves runtime skill artifact candidates for one skill name.
 *
 * **Why it exists:**
 * `run_skill` should fail deterministically when the requested skill artifact is absent, instead of
 * leaving that outcome to later model-governed variance.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param skillName - Skill identifier requested by the action payload.
 * @returns Stable primary and compatibility artifact paths under `runtime/skills`.
 */
function resolveRuntimeSkillArtifactPaths(skillName: string): {
  primaryPath: string;
  compatibilityPath: string;
} {
  const skillsRoot = path.resolve(process.cwd(), "runtime/skills");
  return {
    primaryPath: path.resolve(skillsRoot, `${skillName}.js`),
    compatibilityPath: path.resolve(skillsRoot, `${skillName}.ts`)
  };
}

/**
 * Evaluates existing runtime skill artifact and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Missing skill files are a deterministic local-state fact, so the runtime should block them before
 * governance instead of letting provider variance produce inconsistent chat outcomes.
 *
 * **What it talks to:**
 * - Uses `existsSync` (import `existsSync`) from `node:fs`.
 * - Uses `resolveRuntimeSkillArtifactPaths` from this module.
 *
 * @param skillName - Skill identifier requested by the action payload.
 * @returns `true` when either the primary or compatibility artifact exists.
 */
function hasRuntimeSkillArtifact(skillName: string): boolean {
  const paths = resolveRuntimeSkillArtifactPaths(skillName);
  return existsSync(paths.primaryPath) || existsSync(paths.compatibilityPath);
}

/**
 * Detects whether a self-modification proposal targets immutable governance controls.
 *
 * **Why it exists:**
 * Some control-plane files and keywords are never allowed to be changed by runtime proposals.
 * This guard enforces that boundary even if planner metadata does not explicitly flag immutability.
 *
 * **What it talks to:**
 * - Uses `BrainConfig` (import `BrainConfig`) from `./config`.
 * - Uses `GovernanceProposal` (import `GovernanceProposal`) from `./types`.
 *
 * @param proposal - Candidate governance proposal under evaluation.
 * @param config - Active brain configuration containing immutable keyword policy.
 * @returns `true` when the proposal touches immutable targets/keywords.
 */
export function detectImmutableTouch(proposal: GovernanceProposal, config: BrainConfig): boolean {
  if (proposal.touchesImmutable) {
    return true;
  }

  const target = getStringParam(proposal.action.params, "target");
  if (!target) {
    return false;
  }

  const normalizedTarget = target.toLowerCase();
  return config.dna.immutableKeywords.some((keyword) => normalizedTarget.includes(keyword));
}

/**
 * Resolves shell-like constraint code families for finite shell vs managed-process actions.
 *
 * **Why it exists:**
 * Keeps shared shell/process policy checks reusable without collapsing distinct typed codes that
 * higher layers use for truth-safe messaging and diagnostics.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param actionType - Shell-like action family under evaluation.
 * @param shellCode - Constraint code for `shell_command`.
 * @param processCode - Constraint code for `start_process`.
 * @returns Stable typed code for the active action family.
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
 * Evaluates shared shell/process safety constraints for command-driven actions.
 *
 * **Why it exists:**
 * Prevents managed-process startup from becoming a policy bypass by reusing the same deterministic
 * command, cwd, shell-profile, and protected-path checks that finite shell execution already obeys.
 *
 * **What it talks to:**
 * - Uses `BrainConfig` (import `BrainConfig`) from `./config`.
 * - Uses `containsDangerousCommand` (import `containsDangerousCommand`) from `./hardConstraintShellPolicy`.
 * - Uses `extractShellPathTargets` (import `extractShellPathTargets`) from `./hardConstraintShellPolicy`.
 * - Uses local helpers within this module.
 *
 * @param actionType - Shell-like action family under evaluation.
 * @param params - Action params object containing command/cwd metadata.
 * @param config - Runtime policy/config values that define deterministic constraints.
 * @returns Deterministic constraint violations for this shell-like action family.
 */
function evaluateShellLikeActionConstraints(
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
    if (
      !config.shellRuntime.profile.cwdPolicy.allowRelative &&
      !path.isAbsolute(shellCwd)
    ) {
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
 * Evaluates probe host and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Readiness probes must stay loopback-local so they cannot become a general network egress path.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param host - Probe host candidate supplied by planner params or URL parsing.
 * @returns `true` when the host is a supported loopback/local probe host.
 */
function isLocalProbeHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalizedHost === "localhost" ||
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "::1"
  );
}

/**
 * Evaluates readiness-probe timeout bounds and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Reuses one timeout policy for local readiness probes so planner payloads cannot request unbounded
 * or malformed probe waits.
 *
 * **What it talks to:**
 * - Uses `BrainConfig` (import `BrainConfig`) from `./config`.
 *
 * @param timeoutMs - Optional timeout candidate from planner params.
 * @param config - Runtime policy/config values that define deterministic constraints.
 * @returns `true` when timeout is absent or within configured integer bounds.
 */
function isValidProbeTimeoutMs(timeoutMs: number | undefined, config: BrainConfig): boolean {
  if (timeoutMs === undefined) {
    return true;
  }
  return (
    Number.isInteger(timeoutMs) &&
    timeoutMs >= config.shellRuntime.timeoutBoundsMs.min &&
    timeoutMs <= config.shellRuntime.timeoutBoundsMs.max
  );
}

/**
 * Evaluates local readiness-probe params and returns deterministic constraint violations.
 *
 * **Why it exists:**
 * Keeps local-only probe validation centralized so executor readiness checks cannot drift into
 * general host/network probing and malformed payloads fail closed before governance.
 *
 * **What it talks to:**
 * - Uses `BrainConfig` (import `BrainConfig`) from `./config`.
 * - Uses `getNumberParam` (import `getNumberParam`) from `./hardConstraintParamUtils`.
 * - Uses `getStringParam` (import `getStringParam`) from `./hardConstraintParamUtils`.
 * - Uses local helpers within this module.
 *
 * @param actionType - Probe action family under evaluation.
 * @param params - Action params object containing host/url/timeout metadata.
 * @param config - Runtime policy/config values that define deterministic constraints.
 * @returns Deterministic constraint violations for the active probe action.
 */
function evaluateProbeActionConstraints(
  actionType: "probe_port" | "probe_http",
  params: Record<string, unknown>,
  config: BrainConfig
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const timeoutMs = getNumberParam(params, "timeoutMs");
  if (
    Object.prototype.hasOwnProperty.call(params, "timeoutMs") &&
    !isValidProbeTimeoutMs(timeoutMs, config)
  ) {
    violations.push({
      code: "PROBE_TIMEOUT_INVALID",
      message:
        "Readiness probe timeoutMs must be an integer " +
        `within ${config.shellRuntime.timeoutBoundsMs.min}..` +
        `${config.shellRuntime.timeoutBoundsMs.max}.`
    });
  }

  if (actionType === "probe_port") {
    const host = getStringParam(params, "host");
    const port = getNumberParam(params, "port");
    if (port === undefined) {
      violations.push({
        code: "PROBE_MISSING_PORT",
        message: "Port probe requires params.port."
      });
    } else if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      violations.push({
        code: "PROBE_PORT_INVALID",
        message: "Port probe params.port must be an integer within 1..65535."
      });
    }

    if (host && !isLocalProbeHost(host)) {
      violations.push({
        code: "PROBE_HOST_NOT_LOCAL",
        message: "Port probe host must be localhost, 127.0.0.1, or ::1."
      });
    }
    return violations;
  }

  const urlValue = getStringParam(params, "url");
  if (!urlValue) {
    violations.push({
      code: "PROBE_MISSING_URL",
      message: "HTTP probe requires params.url."
    });
    return violations;
  }

  try {
    const parsedUrl = new URL(urlValue);
    if (
      parsedUrl.protocol !== "http:" &&
      parsedUrl.protocol !== "https:"
    ) {
      violations.push({
        code: "PROBE_URL_INVALID",
        message: "HTTP probe url must use http or https."
      });
    }
    if (!isLocalProbeHost(parsedUrl.hostname)) {
      violations.push({
        code: "PROBE_URL_NOT_LOCAL",
        message: "HTTP probe url must target localhost, 127.0.0.1, or ::1."
      });
    }
  } catch {
    violations.push({
      code: "PROBE_URL_INVALID",
      message: "HTTP probe url must be a valid absolute URL."
    });
  }

  return violations;
}

/**
 * Evaluates browser-verification params and returns deterministic constraint violations.
 *
 * **Why it exists:**
 * Browser verification should stay loopback-local and bounded just like readiness probes, but it
 * needs distinct typed codes so runtime/UI proof failures are explainable without free-text parsing.
 *
 * **What it talks to:**
 * - Uses `BrainConfig` (import `BrainConfig`) from `./config`.
 * - Uses `getNumberParam` (import `getNumberParam`) from `./hardConstraintParamUtils`.
 * - Uses `getStringParam` (import `getStringParam`) from `./hardConstraintParamUtils`.
 * - Uses local helpers within this module.
 *
 * @param params - Action params object containing browser verification metadata.
 * @param config - Runtime policy/config values that define deterministic constraints.
 * @returns Deterministic constraint violations for browser verification.
 */
function evaluateBrowserVerifyActionConstraints(
  params: Record<string, unknown>,
  config: BrainConfig
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const timeoutMs = getNumberParam(params, "timeoutMs");
  if (
    Object.prototype.hasOwnProperty.call(params, "timeoutMs") &&
    !isValidProbeTimeoutMs(timeoutMs, config)
  ) {
    violations.push({
      code: "BROWSER_VERIFY_TIMEOUT_INVALID",
      message:
        "Browser verification timeoutMs must be an integer " +
        `within ${config.shellRuntime.timeoutBoundsMs.min}..` +
        `${config.shellRuntime.timeoutBoundsMs.max}.`
    });
  }

  const urlValue = getStringParam(params, "url");
  if (!urlValue) {
    violations.push({
      code: "BROWSER_VERIFY_MISSING_URL",
      message: "Browser verification requires params.url."
    });
    return violations;
  }

  try {
    const parsedUrl = new URL(urlValue);
    if (
      parsedUrl.protocol !== "http:" &&
      parsedUrl.protocol !== "https:"
    ) {
      violations.push({
        code: "BROWSER_VERIFY_URL_INVALID",
        message: "Browser verification url must use http or https."
      });
    }
    if (!isLocalProbeHost(parsedUrl.hostname)) {
      violations.push({
        code: "BROWSER_VERIFY_URL_NOT_LOCAL",
        message: "Browser verification url must target localhost, 127.0.0.1, or ::1."
      });
    }
  } catch {
    violations.push({
      code: "BROWSER_VERIFY_URL_INVALID",
      message: "Browser verification url must be a valid absolute URL."
    });
  }

  return violations;
}

/**
 * Evaluates deterministic hard constraints before governance voting and execution.
 *
 * **Why it exists:**
 * This is the fail-closed safety boundary for proposals. It blocks unsafe actions early by
 * applying non-LLM policy checks for cost, sandbox boundaries, protected paths, communication
 * impersonation/personal-data rules, and action-specific schema requirements.
 *
 * **What it talks to:**
 * - Uses `estimateActionCostUsd` (import `estimateActionCostUsd`) from `./actionCostPolicy`.
 * - Uses `BrainConfig` (import `BrainConfig`) from `./config`.
 * - Uses `ConstraintViolation` (import `ConstraintViolation`) from `./types`.
 * - Uses `GovernanceProposal` (import `GovernanceProposal`) from `./types`.
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param proposal - Governance proposal containing the candidate action + params.
 * @param config - Runtime policy/config values that define deterministic constraints.
 * @param context - Per-run evaluation context (for cumulative-cost tracking).
 * @returns Typed list of constraint violations (empty means pass).
 */
export function evaluateHardConstraints(
  proposal: GovernanceProposal,
  config: BrainConfig,
  context: ConstraintEvaluationContext = { cumulativeEstimatedCostUsd: 0 }
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const { action } = proposal;
  const deterministicEstimatedCostUsd = estimateActionCostUsd({
    type: action.type,
    params: action.params
  });

  // Cost limit is enforced from deterministic runtime policy, never model-reported values.
  if (deterministicEstimatedCostUsd > config.limits.maxEstimatedCostUsd) {
    violations.push({
      code: "COST_LIMIT_EXCEEDED",
      message:
        `Deterministic action cost ${deterministicEstimatedCostUsd.toFixed(2)} ` +
        `exceeds max ${config.limits.maxEstimatedCostUsd.toFixed(2)}.`
    });
  }

  // Cumulative task budget prevents unbounded cost growth across many actions.
  const projectedCumulativeCostUsd =
    context.cumulativeEstimatedCostUsd + deterministicEstimatedCostUsd;
  if (projectedCumulativeCostUsd > config.limits.maxCumulativeEstimatedCostUsd) {
    violations.push({
      code: "CUMULATIVE_COST_LIMIT_EXCEEDED",
      message:
        `Projected cumulative action cost ${projectedCumulativeCostUsd.toFixed(2)} ` +
        `exceeds task max ${config.limits.maxCumulativeEstimatedCostUsd.toFixed(2)}.`
    });
  }

  // Immutable targets cannot be modified through self-edit workflows.
  if (action.type === "self_modify" && detectImmutableTouch(proposal, config)) {
    violations.push({
      code: "IMMUTABLE_VIOLATION",
      message: "Proposed self-modification targets immutable constraints."
    });
  }

  if (action.type === "delete_file") {
    // Delete operations are sandbox-scoped to avoid broad filesystem damage.
    const targetPath = getStringParam(action.params, "path");
    if (!targetPath) {
      violations.push({
        code: "DELETE_MISSING_PATH",
        message: "Delete action requires a path."
      });
    } else if (isProtectedPath(targetPath, config)) {
      violations.push({
        code: "DELETE_PROTECTED_PATH",
        message: `Delete denied for protected path: ${targetPath}`
      });
    } else if (config.permissions.enforceSandboxDelete) {
      if (!isPathWithinPrefix(targetPath, config.dna.sandboxPathPrefix)) {
        violations.push({
          code: "DELETE_OUTSIDE_SANDBOX",
          message: `Delete path must stay inside sandbox (${config.dna.sandboxPathPrefix}).`
        });
      }
    }
  }

  if (action.type === "read_file") {
    // Protected files remain unreadable by runtime actions unless owner changes config.
    const targetPath = getStringParam(action.params, "path");
    if (!targetPath) {
      violations.push({
        code: "READ_MISSING_PATH",
        message: "Read action requires a path."
      });
    } else if (isProtectedPath(targetPath, config)) {
      violations.push({
        code: "READ_PROTECTED_PATH",
        message: `Read denied for protected path: ${targetPath}`
      });
    }
  }

  if (action.type === "write_file") {
    // Certain paths are policy-protected and cannot be modified by runtime actions.
    const targetPath = getStringParam(action.params, "path");
    if (!targetPath) {
      violations.push({
        code: "WRITE_MISSING_PATH",
        message: "Write action requires a path."
      });
    } else if (config.permissions.enforceProtectedPathWrites) {
      if (isProtectedPath(targetPath, config)) {
        violations.push({
          code: "WRITE_PROTECTED_PATH",
          message: `Write denied to protected path: ${targetPath}`
        });
      }
    }
  }

  if (action.type === "list_directory") {
    // Directory listing remains sandbox-scoped and always blocks protected paths.
    const targetPath = getStringParam(action.params, "path");
    if (!targetPath) {
      violations.push({
        code: "LIST_MISSING_PATH",
        message: "List directory action requires a path."
      });
    } else if (isProtectedPath(targetPath, config)) {
      violations.push({
        code: "LIST_PROTECTED_PATH",
        message: `List denied for protected path: ${targetPath}`
      });
    } else if (config.permissions.enforceSandboxListDirectory) {
      if (!isPathWithinPrefix(targetPath, config.dna.sandboxPathPrefix)) {
        violations.push({
          code: "LIST_OUTSIDE_SANDBOX",
          message: `List path must stay inside sandbox (${config.dna.sandboxPathPrefix}).`
        });
      }
    }
  }

  if (action.type === "create_skill") {
    // Skill generation is constrained to well-formed, bounded payloads before governance review.
    if (!config.permissions.allowCreateSkillAction) {
      violations.push({
        code: "CREATE_SKILL_DISABLED",
        message: "Create skill actions are disabled by policy."
      });
    }

    const skillName = getStringParam(action.params, "name");
    if (!skillName) {
      violations.push({
        code: "CREATE_SKILL_MISSING_NAME",
        message: "Create skill action requires a skill name."
      });
    } else if (!isValidSkillName(skillName)) {
      violations.push({
        code: "CREATE_SKILL_INVALID_NAME",
        message: "Skill name must match [a-zA-Z0-9_-] and be <= 64 chars."
      });
    }

    const code = getStringParam(action.params, "code");
    if (!code) {
      violations.push({
        code: "CREATE_SKILL_MISSING_CODE",
        message: "Create skill action requires code content."
      });
    } else if (code.length > MAX_SKILL_CODE_LENGTH) {
      violations.push({
        code: "CREATE_SKILL_CODE_TOO_LARGE",
        message: `Skill code length ${code.length} exceeds max ${MAX_SKILL_CODE_LENGTH}.`
      });
    } else if (!stripCodeCommentsAndWhitespace(code) || !hasCallableSkillExport(code)) {
      violations.push({
        code: "CREATE_SKILL_NON_EXECUTABLE",
        message: "Skill code must include an exported callable function."
      });
    } else if (containsUnsafeSkillCode(code)) {
      violations.push({
        code: "CREATE_SKILL_UNSAFE_CODE",
        message: "Skill code contains disallowed runtime-capability patterns."
      });
    }
  }

  if (action.type === "run_skill") {
    // Running skills is constrained to validated skill identifiers.
    const skillName = getStringParam(action.params, "name");
    if (!skillName) {
      violations.push({
        code: "RUN_SKILL_MISSING_NAME",
        message: "Run skill action requires a skill name."
      });
    } else if (!isValidSkillName(skillName)) {
      violations.push({
        code: "RUN_SKILL_INVALID_NAME",
        message: "Run skill name must match [a-zA-Z0-9_-] and be <= 64 chars."
      });
    } else if (!hasRuntimeSkillArtifact(skillName)) {
      violations.push({
        code: "RUN_SKILL_ARTIFACT_MISSING",
        message: `Run skill failed: no skill artifact found for ${skillName}.`
      });
    }
  }

  if (action.type === "memory_mutation") {
    const store = getStringParam(action.params, "store");
    const operation = getStringParam(action.params, "operation");
    const payload = (action.params as Record<string, unknown>).payload;

    if (!store || !STAGE_6_86_MEMORY_STORES.has(store)) {
      violations.push({
        code: "MEMORY_MUTATION_INVALID_STORE",
        message: "Memory mutation requires a supported store (entity_graph|conversation_stack|pulse_state)."
      });
    }

    if (!operation || !STAGE_6_86_MEMORY_OPERATIONS.has(operation)) {
      violations.push({
        code: "MEMORY_MUTATION_INVALID_OPERATION",
        message: "Memory mutation requires a supported operation (upsert|merge|supersede|resolve|evict)."
      });
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      violations.push({
        code: "MEMORY_MUTATION_MISSING_PAYLOAD",
        message: "Memory mutation requires an object payload."
      });
    }
  }

  if (action.type === "pulse_emit") {
    const kind = getStringParam(action.params, "kind");
    if (!kind || !STAGE_6_86_PULSE_KINDS.has(kind)) {
      violations.push({
        code: "PULSE_EMIT_INVALID_KIND",
        message:
          "Pulse emit requires a supported kind (bridge_question|open_loop_resume|topic_resume|stale_fact_revalidation)."
      });
    }
  }

  if (action.type === "shell_command" || action.type === "start_process") {
    violations.push(
      ...evaluateShellLikeActionConstraints(action.type, action.params, config)
    );
  }

  if (action.type === "shell_command") {
    if (Object.prototype.hasOwnProperty.call(action.params, "timeoutMs")) {
      const timeoutMs = getNumberParam(action.params, "timeoutMs");
      if (
        timeoutMs === undefined ||
        !Number.isInteger(timeoutMs) ||
        timeoutMs < config.shellRuntime.timeoutBoundsMs.min ||
        timeoutMs > config.shellRuntime.timeoutBoundsMs.max
      ) {
        violations.push({
          code: "SHELL_TIMEOUT_INVALID",
          message:
            "Shell command timeoutMs must be an integer " +
            `within ${config.shellRuntime.timeoutBoundsMs.min}..` +
            `${config.shellRuntime.timeoutBoundsMs.max}.`
        });
      }
    }
  }

  if (action.type === "check_process" || action.type === "stop_process") {
    const leaseId = getStringParam(action.params, "leaseId");
    if (!leaseId) {
      violations.push({
        code: "PROCESS_MISSING_LEASE_ID",
        message:
          action.type === "check_process"
            ? "Process check requires a leaseId."
            : "Process stop requires a leaseId."
      });
    }
  }

  if (action.type === "probe_port" || action.type === "probe_http") {
    violations.push(
      ...evaluateProbeActionConstraints(action.type, action.params, config)
    );
  }

  if (action.type === "verify_browser") {
    violations.push(
      ...evaluateBrowserVerifyActionConstraints(action.params, config)
    );
  }

  if (action.type === "network_write" && !config.permissions.allowNetworkWriteAction) {
    // Network egress is denied by default until explicitly enabled in policy.
    violations.push({
      code: "NETWORK_WRITE_DISABLED",
      message: "Network write actions are disabled by DNA constraints."
    });
  }

  // Communication actions must never misrepresent identity.
  if (isCommunicationAction(proposal) && containsImpersonationSignal(proposal)) {
    violations.push({
      code: "IDENTITY_IMPERSONATION_DENIED",
      message:
        "Communication action cannot impersonate a human identity; agent identity must remain explicit."
    });
  }

  // Sharing another human's personal data requires explicit human approval metadata.
  if (
    isCommunicationAction(proposal) &&
    containsPersonalDataSignal(proposal) &&
    !hasExplicitHumanApproval(proposal)
  ) {
    violations.push({
      code: "PERSONAL_DATA_APPROVAL_REQUIRED",
      message:
        "Communication action indicating personal data sharing requires explicit human approval (explicitHumanApproval + approvalId)."
    });
  }

  return violations;
}

/**
 * Resolves a relative path against the configured sandbox base path.
 *
 * **Why it exists:**
 * Backward-compatible export for existing callers/tests while path policy helpers now live in
 * `hardConstraintPathPolicy`.
 *
 * **What it talks to:**
 * - Delegates to `resolveSandboxPath` in `./hardConstraintPathPolicy`.
 *
 * @param basePath - Absolute sandbox root.
 * @param relativePath - Relative path requested by action payload.
 * @returns Joined sandbox candidate path.
 */
export function resolveSandboxPath(basePath: string, relativePath: string): string {
  return resolveSandboxPathFromPolicy(basePath, relativePath);
}
