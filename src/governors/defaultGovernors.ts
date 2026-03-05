/**
 * @fileoverview Implements the default governor council with deterministic and model-advisory policy checks.
 */

import { Governor } from "./types";
import {
  GovernanceProposal,
  GovernorId,
  GovernorRejectCategory,
  GovernorVote
} from "../core/types";
import { estimateActionCostUsd } from "../core/actionCostPolicy";
import { GovernorModelOutput } from "../models/types";
import {
  classifySafetyAbuseText,
  classifySafetyDestructiveCommandText,
  createSafetyLexiconRuleContext
} from "./safetyLexicon";

const SAFETY_LEXICON_RULE_CONTEXT = createSafetyLexiconRuleContext();

/**
 * Builds an approval outcome for input with typed metadata.
 *
 * **Why it exists:**
 * Standardizes input vote/result construction so downstream governance handling stays uniform.
 *
 * **What it talks to:**
 * - Uses `GovernorId` (import `GovernorId`) from `../core/types`.
 * - Uses `GovernorVote` (import `GovernorVote`) from `../core/types`.
 *
 * @param governorId - Stable identifier used to reference an entity or record.
 * @param reason - Value for reason.
 * @param confidence - Stable identifier used to reference an entity or record.
 * @returns Computed `GovernorVote` result.
 */
function approve(governorId: GovernorId, reason: string, confidence = 0.85): GovernorVote {
  return { governorId, approve: true, reason, confidence };
}

/**
 * Builds a rejection outcome for with category with typed metadata.
 *
 * **Why it exists:**
 * Standardizes with category vote/result construction so downstream governance handling stays uniform.
 *
 * **What it talks to:**
 * - Uses `GovernorId` (import `GovernorId`) from `../core/types`.
 * - Uses `GovernorRejectCategory` (import `GovernorRejectCategory`) from `../core/types`.
 * - Uses `GovernorVote` (import `GovernorVote`) from `../core/types`.
 *
 * @param governorId - Stable identifier used to reference an entity or record.
 * @param reason - Value for reason.
 * @param rejectCategory - Value for reject category.
 * @param confidence - Stable identifier used to reference an entity or record.
 * @returns Computed `GovernorVote` result.
 */
function rejectWithCategory(
  governorId: GovernorId,
  reason: string,
  rejectCategory: GovernorRejectCategory,
  confidence = 0.9
): GovernorVote {
  return {
    governorId,
    approve: false,
    reason,
    confidence,
    rejectCategory
  };
}

/**
 * Normalizes input into a stable shape for `defaultGovernors` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for input so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @returns Resulting string value.
 */
function normalize(input: string): string {
  return input.toLowerCase();
}

/**
 * Reads param string needed for this execution step.
 *
 * **Why it exists:**
 * Separates param string read-path handling from orchestration and mutation code.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param params - Structured input object for this operation.
 * @param key - Lookup key or map field identifier.
 * @returns Computed `string | undefined` result.
 */
function getParamString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Normalizes confidence into a stable shape for `defaultGovernors` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for confidence so call sites stay aligned.
 *
 * **What it talks to:**
 * - Local finite-number guard and clamp logic.
 *
 * @param value - Primary input consumed by this function.
 * @returns Numeric result used by downstream logic.
 */
function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.8;
  }

  return Math.max(0, Math.min(1, value));
}

/**
 * Reads model advisory rejection needed for this execution step.
 *
 * **Why it exists:**
 * Separates model advisory rejection read-path handling from orchestration and mutation code.
 *
 * **What it talks to:**
 * - Uses `GovernanceProposal` (import `GovernanceProposal`) from `../core/types`.
 * - Uses `GovernorId` (import `GovernorId`) from `../core/types`.
 * - Uses `GovernorVote` (import `GovernorVote`) from `../core/types`.
 * - Uses `GovernorModelOutput` (import `GovernorModelOutput`) from `../models/types`.
 * - Uses `Governor` (import `Governor`) from `./types`.
 *
 * @param governorId - Stable identifier used to reference an entity or record.
 * @param proposal - Value for proposal.
 * @param context - Message/text content processed by this function.
 * @returns Promise resolving to GovernorVote | null.
 */
async function getModelAdvisoryRejection(
  governorId: GovernorId,
  proposal: GovernanceProposal,
  context: Parameters<Governor["evaluate"]>[1]
): Promise<GovernorVote | null> {
  try {
    // Advisory model check can add conservative vetoes; deterministic checks still run after.
    const output = await context.modelClient.completeJson<GovernorModelOutput>({
      model: context.model,
      schemaName: "governor_v1",
      temperature: 0,
      systemPrompt:
        "You are a strict policy evaluator. Return JSON with approve:boolean, reason:string, confidence:number.",
      userPrompt: JSON.stringify({
        governorId,
        goal: context.task.goal,
        actionType: proposal.action.type,
        actionDescription: proposal.action.description,
        rationale: proposal.rationale,
        path: getParamString(proposal.action.params, "path") ?? "",
        target: getParamString(proposal.action.params, "target") ?? ""
      })
    });

    if (output.approve === false) {
      return rejectWithCategory(
        governorId,
        `Model advisory block: ${output.reason}`,
        "MODEL_ADVISORY_BLOCK",
        normalizeConfidence(output.confidence)
      );
    }
  } catch {
    // Model outages should not break governance. Deterministic policy remains authoritative.
  }

  return null;
}

const ethicsGovernor: Governor = {
  id: "ethics",
  /**
   * Evaluates input and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps the input policy check explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses `classifySafetyAbuseText` (import `classifySafetyAbuseText`) from `./safetyLexicon`.
   *
   * @param proposal - Value for proposal.
   * @param context - Message/text content processed by this function.
   * @returns Computed `unknown` result.
   */
  async evaluate(proposal, context) {
    const modelAdvisory = await getModelAdvisoryRejection("ethics", proposal, context);
    if (modelAdvisory) {
      return modelAdvisory;
    }

    const combinedText = normalize(`${proposal.action.description} ${proposal.rationale}`);
    const abuseClassification = classifySafetyAbuseText(
      combinedText,
      SAFETY_LEXICON_RULE_CONTEXT
    );
    if (abuseClassification.category === "ABUSE_SIGNAL") {
      return rejectWithCategory(
        "ethics",
        "Proposal language indicates harmful or abusive intent.",
        "ABUSE_MALWARE_OR_FRAUD"
      );
    }
    return approve("ethics", "No clear ethical abuse signals found.");
  }
};

const logicGovernor: Governor = {
  id: "logic",
  /**
   * Evaluates input and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps the input policy check explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param proposal - Value for proposal.
   * @param context - Message/text content processed by this function.
   * @returns Computed `unknown` result.
   */
  async evaluate(proposal, context) {
    const modelAdvisory = await getModelAdvisoryRejection("logic", proposal, context);
    if (modelAdvisory) {
      return modelAdvisory;
    }

    if (proposal.rationale.trim().length < 20) {
      return rejectWithCategory(
        "logic",
        "Rationale is too short to justify the action.",
        "RATIONALE_QUALITY"
      );
    }
    if (proposal.action.description.trim().length < 10) {
      return rejectWithCategory(
        "logic",
        "Action description is too vague.",
        "RATIONALE_QUALITY"
      );
    }
    return approve("logic", "Rationale and action description are coherent.");
  }
};

const resourceGovernor: Governor = {
  id: "resource",
  /**
   * Evaluates input and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps the input policy check explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses `estimateActionCostUsd` (import `estimateActionCostUsd`) from `../core/actionCostPolicy`.
   *
   * @param proposal - Value for proposal.
   * @param context - Message/text content processed by this function.
   * @returns Computed `unknown` result.
   */
  async evaluate(proposal, context) {
    const modelAdvisory = await getModelAdvisoryRejection("resource", proposal, context);
    if (modelAdvisory) {
      return modelAdvisory;
    }

    const deterministicCostUsd = estimateActionCostUsd({
      type: proposal.action.type,
      params: proposal.action.params
    });
    if (deterministicCostUsd > context.config.limits.maxEstimatedCostUsd) {
      return rejectWithCategory(
        "resource",
        `Deterministic cost ${deterministicCostUsd.toFixed(2)} exceeds configured limit.`,
        "RESOURCE_BUDGET"
      );
    }
    return approve("resource", "Estimated resource usage is within limit.");
  }
};

const securityGovernor: Governor = {
  id: "security",
  /**
   * Evaluates input and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps the input policy check explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses `classifySafetyDestructiveCommandText` (import `classifySafetyDestructiveCommandText`) from `./safetyLexicon`.
   *
   * @param proposal - Value for proposal.
   * @param context - Message/text content processed by this function.
   * @returns Computed `unknown` result.
   */
  async evaluate(proposal, context) {
    const modelAdvisory = await getModelAdvisoryRejection("security", proposal, context);
    if (modelAdvisory) {
      return modelAdvisory;
    }

    const action = proposal.action;
    if (action.type === "delete_file") {
      const targetPath = normalize(getParamString(action.params, "path") ?? "");
      const sandboxPrefix = normalize(context.config.dna.sandboxPathPrefix);
      if (!targetPath.startsWith(sandboxPrefix)) {
        return rejectWithCategory(
          "security",
          "Delete operation targets a path outside the sandbox.",
          "SECURITY_BOUNDARY"
        );
      }
    }

    if (action.type === "shell_command") {
      const command = normalize(getParamString(action.params, "command") ?? "");
      const destructiveClassification = classifySafetyDestructiveCommandText(
        command,
        SAFETY_LEXICON_RULE_CONTEXT
      );
      if (destructiveClassification.category === "DESTRUCTIVE_COMMAND_SIGNAL") {
        return rejectWithCategory(
          "security",
          "Shell command includes blocked destructive patterns.",
          "SECURITY_BOUNDARY"
        );
      }
    }

    if (action.type === "self_modify" && proposal.touchesImmutable) {
      return rejectWithCategory(
        "security",
        "Self-modification touches immutable system rules.",
        "IDENTITY_INTEGRITY"
      );
    }

    return approve("security", "No direct security violations detected.");
  }
};

const continuityGovernor: Governor = {
  id: "continuity",
  /**
   * Evaluates input and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps the input policy check explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param proposal - Value for proposal.
   * @param context - Message/text content processed by this function.
   * @returns Computed `unknown` result.
   */
  async evaluate(proposal, context) {
    const modelAdvisory = await getModelAdvisoryRejection("continuity", proposal, context);
    if (modelAdvisory) {
      return modelAdvisory;
    }

    if (proposal.touchesImmutable) {
      return rejectWithCategory(
        "continuity",
        "Proposal attempts to modify immutable identity constraints.",
        "IDENTITY_INTEGRITY"
      );
    }

    const target = normalize(getParamString(proposal.action.params, "target") ?? "");
    const touchesImmutableKeyword = context.config.dna.immutableKeywords.some((keyword) =>
      target.includes(normalize(keyword))
    );
    if (touchesImmutableKeyword) {
      return rejectWithCategory(
        "continuity",
        "Target contains immutable keyword.",
        "IDENTITY_INTEGRITY"
      );
    }

    return approve("continuity", "Identity continuity remains intact.");
  }
};

const utilityGovernor: Governor = {
  id: "utility",
  /**
   * Evaluates input and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps the input policy check explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param proposal - Value for proposal.
   * @param context - Message/text content processed by this function.
   * @returns Computed `unknown` result.
   */
  async evaluate(proposal, context) {
    const modelAdvisory = await getModelAdvisoryRejection("utility", proposal, context);
    if (modelAdvisory) {
      return modelAdvisory;
    }

    if (!context.task.goal.trim()) {
      return rejectWithCategory(
        "utility",
        "Task has no goal, utility cannot be established.",
        "UTILITY_ALIGNMENT"
      );
    }

    if (proposal.action.type === "self_modify" && !normalize(context.task.goal).includes("improve")) {
      return rejectWithCategory(
        "utility",
        "Self-modification is not clearly tied to the user goal for this request.",
        "UTILITY_ALIGNMENT"
      );
    }

    return approve("utility", "Action appears useful relative to task goal.");
  }
};

const complianceGovernor: Governor = {
  id: "compliance",
  /**
   * Evaluates input and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps the input policy check explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param proposal - Value for proposal.
   * @param context - Message/text content processed by this function.
   * @returns Computed `unknown` result.
   */
  async evaluate(proposal, context) {
    const modelAdvisory = await getModelAdvisoryRejection("compliance", proposal, context);
    if (modelAdvisory) {
      return modelAdvisory;
    }

    if (
      proposal.action.type === "network_write" &&
      !context.config.permissions.allowNetworkWriteAction
    ) {
      return rejectWithCategory(
        "compliance",
        "Network write is not enabled by policy.",
        "COMPLIANCE_POLICY"
      );
    }

    if (proposal.action.type === "write_file") {
      const targetPath = normalize(getParamString(proposal.action.params, "path") ?? "");
      const protectedPrefix = context.config.dna.protectedPathPrefixes.map((prefix) =>
        normalize(prefix)
      );
      if (protectedPrefix.some((prefix) => targetPath.startsWith(prefix))) {
        return rejectWithCategory(
          "compliance",
          "Write targets a policy-protected path.",
          "COMPLIANCE_POLICY"
        );
      }
    }

    return approve("compliance", "No compliance policy violation found.");
  }
};

/**
 * Builds default governors for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of default governors consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `Governor` (import `Governor`) from `./types`.
 * @returns Ordered collection produced by this step.
 */
export function createDefaultGovernors(): Governor[] {
  return [
    ethicsGovernor,
    logicGovernor,
    resourceGovernor,
    securityGovernor,
    continuityGovernor,
    utilityGovernor,
    complianceGovernor
  ];
}
