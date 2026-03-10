/**
 * @fileoverview Enforces non-negotiable deterministic safety constraints before governance voting.
 */

import { estimateActionCostUsd } from "./actionCostPolicy";
import { evaluateBrowserVerifyActionConstraints } from "./constraintRuntime/browserConstraints";
import { evaluateMemoryMutationConstraints, evaluatePulseEmitConstraints } from "./constraintRuntime/continuityConstraints";
import { ConstraintEvaluationContext } from "./constraintRuntime/contracts";
import { detectImmutableTouch as detectImmutableTouchFromRuntime } from "./constraintRuntime/decisionHelpers";
import { evaluatePathActionConstraints } from "./constraintRuntime/pathConstraints";
import {
  evaluateManagedProcessLeaseConstraints,
  evaluateShellCommandTimeoutConstraints,
  evaluateShellLikeActionConstraints
} from "./constraintRuntime/processConstraints";
import { evaluateProbeActionConstraints } from "./constraintRuntime/loopbackConstraints";
import { evaluateCreateSkillConstraints, evaluateRunSkillConstraints } from "./constraintRuntime/skillConstraints";
import { BrainConfig } from "./config";
import {
  containsImpersonationSignal,
  containsPersonalDataSignal,
  hasExplicitHumanApproval,
  isCommunicationAction
} from "./hardConstraintCommunicationPolicy";
import { resolveSandboxPath as resolveSandboxPathFromPolicy } from "./hardConstraintPathPolicy";
import { ConstraintViolation, GovernanceProposal } from "./types";

export type { ConstraintEvaluationContext } from "./constraintRuntime/contracts";

/**
 * Detects whether a self-modification proposal targets immutable governance controls.
 *
 * **Why it exists:**
 * Some control-plane files and keywords are never allowed to be changed by runtime proposals.
 * This stable entrypoint preserves the older import surface while detailed ownership lives in the
 * extracted constraint runtime subsystem.
 *
 * **What it talks to:**
 * - Delegates to `detectImmutableTouch` in `./constraintRuntime/decisionHelpers`.
 *
 * @param proposal - Candidate governance proposal under evaluation.
 * @param config - Active brain configuration containing immutable keyword policy.
 * @returns `true` when the proposal touches immutable targets/keywords.
 */
export function detectImmutableTouch(proposal: GovernanceProposal, config: BrainConfig): boolean {
  return detectImmutableTouchFromRuntime(proposal, config);
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
 * - Uses `estimateActionCostUsd` from `./actionCostPolicy`.
 * - Uses extracted action-family evaluators in `./constraintRuntime/`.
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

  if (deterministicEstimatedCostUsd > config.limits.maxEstimatedCostUsd) {
    violations.push({
      code: "COST_LIMIT_EXCEEDED",
      message:
        `Deterministic action cost ${deterministicEstimatedCostUsd.toFixed(2)} ` +
        `exceeds max ${config.limits.maxEstimatedCostUsd.toFixed(2)}.`
    });
  }

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

  if (action.type === "self_modify" && detectImmutableTouchFromRuntime(proposal, config)) {
    violations.push({
      code: "IMMUTABLE_VIOLATION",
      message: "Proposed self-modification targets immutable constraints."
    });
  }

  if (
    action.type === "delete_file" ||
    action.type === "read_file" ||
    action.type === "write_file" ||
    action.type === "list_directory"
  ) {
    violations.push(...evaluatePathActionConstraints(action.type, action.params, config));
  }

  if (action.type === "create_skill") {
    violations.push(...evaluateCreateSkillConstraints(action.params, config));
  }

  if (action.type === "run_skill") {
    violations.push(...evaluateRunSkillConstraints(action.params));
  }

  if (action.type === "memory_mutation") {
    violations.push(...evaluateMemoryMutationConstraints(action.params));
  }

  if (action.type === "pulse_emit") {
    violations.push(...evaluatePulseEmitConstraints(action.params));
  }

  if (action.type === "shell_command" || action.type === "start_process") {
    violations.push(...evaluateShellLikeActionConstraints(action.type, action.params, config));
  }

  if (action.type === "shell_command") {
    violations.push(...evaluateShellCommandTimeoutConstraints(action.params, config));
  }

  if (action.type === "check_process" || action.type === "stop_process") {
    violations.push(...evaluateManagedProcessLeaseConstraints(action.type, action.params));
  }

  if (action.type === "probe_port" || action.type === "probe_http") {
    violations.push(...evaluateProbeActionConstraints(action.type, action.params, config));
  }

  if (action.type === "verify_browser") {
    violations.push(...evaluateBrowserVerifyActionConstraints(action.params, config));
  }

  if (action.type === "network_write" && !config.permissions.allowNetworkWriteAction) {
    violations.push({
      code: "NETWORK_WRITE_DISABLED",
      message: "Network write actions are disabled by DNA constraints."
    });
  }

  if (isCommunicationAction(proposal) && containsImpersonationSignal(proposal)) {
    violations.push({
      code: "IDENTITY_IMPERSONATION_DENIED",
      message:
        "Communication action cannot impersonate a human identity; agent identity must remain explicit."
    });
  }

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
 * Resolves a sandbox-relative path using the canonical path policy helper.
 *
 * **Why it exists:**
 * This stable export preserves older imports while canonical path-resolution logic lives in
 * `hardConstraintPathPolicy`.
 *
 * **What it talks to:**
 * - Delegates to `resolveSandboxPath` in `./hardConstraintPathPolicy`.
 *
 * @param basePath - Base sandbox path prefix.
 * @param relativePath - User or planner supplied relative path.
 * @returns Resolved absolute path inside the sandbox root.
 */
export function resolveSandboxPath(basePath: string, relativePath: string): string {
  return resolveSandboxPathFromPolicy(basePath, relativePath);
}
