/**
 * @fileoverview Enforces non-negotiable deterministic safety constraints before governance voting.
 */

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

  if (action.type === "shell_command") {
    // Shell deny-list guards against obvious destructive command patterns.
    if (!config.permissions.allowShellCommandAction) {
      violations.push({
        code: "SHELL_DISABLED_BY_POLICY",
        message: "Shell command actions are disabled in current runtime profile."
      });
    }

    const command = getStringParam(action.params, "command");
    if (!command) {
      violations.push({
        code: "SHELL_MISSING_COMMAND",
        message: "Shell command action requires a command string."
      });
    } else if (command.length > config.shellRuntime.profile.commandMaxChars) {
      violations.push({
        code: "SHELL_COMMAND_TOO_LONG",
        message:
          `Shell command length ${command.length} exceeds max ` +
          `${config.shellRuntime.profile.commandMaxChars}.`
      });
    } else if (containsDangerousCommand(command)) {
      violations.push({
        code: "SHELL_DANGEROUS_COMMAND",
        message: "Command matches denied destructive patterns."
      });
    }

    const requestedShellKind = getStringParam(action.params, "requestedShellKind");
    if (requestedShellKind && requestedShellKind !== config.shellRuntime.profile.shellKind) {
      violations.push({
        code: "SHELL_PROFILE_MISMATCH",
        message:
          `Requested shell '${requestedShellKind}' does not match resolved runtime shell ` +
          `'${config.shellRuntime.profile.shellKind}'.`
      });
    }

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

    const shellCwd =
      getStringParam(action.params, "cwd") ?? getStringParam(action.params, "workdir");
    if (shellCwd) {
      if (
        !config.shellRuntime.profile.cwdPolicy.allowRelative &&
        !path.isAbsolute(shellCwd)
      ) {
        violations.push({
          code: "SHELL_CWD_OUTSIDE_SANDBOX",
          message: "Shell command cwd must be absolute when relative cwd is disabled."
        });
      }

      if (
        config.shellRuntime.profile.cwdPolicy.denyOutsideSandbox &&
        !isPathWithinPrefix(shellCwd, config.dna.sandboxPathPrefix)
      ) {
        violations.push({
          code: "SHELL_CWD_OUTSIDE_SANDBOX",
          message:
            `Shell command cwd must stay inside sandbox (${config.dna.sandboxPathPrefix}).`
        });
      }
    }

    // Path-targeting shell variants cannot touch owner-protected paths.
    const protectedTarget = extractShellPathTargets(action.params).find((targetPath) =>
      isProtectedPath(targetPath, config)
    );
    if (protectedTarget) {
      violations.push({
        code: "SHELL_TARGETS_PROTECTED_PATH",
        message: `Shell command targets protected path: ${protectedTarget}`
      });
    }
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
