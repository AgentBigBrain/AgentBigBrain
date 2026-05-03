import { JudgmentPattern } from "../../core/judgmentPatterns";
import { PlannerLearningHintSummaryV1, WorkflowPattern } from "../../core/types";

import type { PlannerSkillGuidanceEntry } from "../skillRegistry/contracts";
import { type WorkflowSkillBridgeSummary } from "../skillRegistry/workflowSkillBridge";

/**
 * Builds deterministic workflow-learning guidance for planner prompts.
 *
 * @param patterns - Workflow hints chosen for this planning attempt.
 * @returns Prompt guidance block, or empty string when no workflow hints are available.
 */
export function buildWorkflowLearningGuidance(patterns: readonly WorkflowPattern[]): string {
  if (patterns.length === 0) {
    return "";
  }
  const lines = patterns.slice(0, 3).map((pattern) => {
    return (
      `- workflowKey=${pattern.workflowKey}; confidence=${pattern.confidence.toFixed(2)}; ` +
      `status=${pattern.status}; success=${pattern.successCount}; failure=${pattern.failureCount}; ` +
      `suppressed=${pattern.suppressedCount}`
    );
  });
  return (
    "\nWorkflow Learning Hints:\n" +
    lines.join("\n") +
    "\nPrefer high-confidence active workflow patterns and avoid known suppressed/failure motifs."
  );
}

/**
 * Builds deterministic judgment-learning guidance for planner prompts.
 *
 * @param patterns - Judgment hints chosen for this planning attempt.
 * @returns Prompt guidance block, or empty string when no judgment hints are available.
 */
export function buildJudgmentLearningGuidance(patterns: readonly JudgmentPattern[]): string {
  if (patterns.length === 0) {
    return "";
  }
  const lines = patterns.slice(0, 3).map((pattern) => {
    const latestSignal =
      pattern.outcomeHistory.length > 0
        ? pattern.outcomeHistory[pattern.outcomeHistory.length - 1]
        : undefined;
    return (
      `- riskPosture=${pattern.riskPosture}; confidence=${pattern.confidence.toFixed(2)}; ` +
      `signals=${pattern.outcomeHistory.length}; latestSignal=${latestSignal?.signalType ?? "none"}; ` +
      `latestScore=${latestSignal ? latestSignal.score.toFixed(2) : "n/a"}`
    );
  });
  return (
    "\nJudgment Learning Hints:\n" +
    lines.join("\n") +
    "\nWhen uncertain, prefer lower-risk options and avoid repeating low-confidence decisions."
  );
}

/**
 * Builds deterministic skill-reuse guidance from the workflow/skill bridge summary.
 *
 * @param workflowBridge - Workflow/skill bridge summary for this planning attempt.
 * @returns Prompt guidance block, or empty string when no bridge signal exists.
 */
export function buildWorkflowSkillBridgeGuidance(
  workflowBridge: WorkflowSkillBridgeSummary | null
): string {
  if (!workflowBridge) {
    return "";
  }
  const lines: string[] = [];
  if (workflowBridge.preferredSkill && workflowBridge.preferredWorkflowKey) {
    lines.push(
      `- preferredSkill=${workflowBridge.preferredSkill.name}; workflowKey=${workflowBridge.preferredWorkflowKey}; ` +
      `reason=${workflowBridge.preferredReason ?? "verified reusable skill"}`
    );
  }
  for (const workflowKey of workflowBridge.discouragedWorkflowKeys) {
    lines.push(`- discouragedWorkflowKey=${workflowKey}`);
  }
  for (const suggestion of workflowBridge.skillSuggestions) {
    lines.push(
      `- skillOpportunity=${suggestion.suggestedSkillName}; workflowKey=${suggestion.workflowKey}; ` +
      `reason=${suggestion.reason}`
    );
  }
  if (lines.length === 0) {
    return "";
  }
  return (
    "\nWorkflow/Skill Bridge:\n" +
    lines.join("\n") +
    "\nPrefer verified active skills when the workflow match is strong. Only suggest creating a reusable skill when the repeated workflow is stable."
  );
}

/**
 * Builds bounded Markdown skill guidance for planner prompts.
 *
 * @param skillGuidance - Selected Markdown guidance entries for the current request.
 * @returns Prompt guidance block, or empty string when no guidance applies.
 */
export function buildPlannerSkillGuidance(
  skillGuidance: readonly PlannerSkillGuidanceEntry[]
): string {
  if (skillGuidance.length === 0) {
    return "";
  }
  const lines = skillGuidance.slice(0, 3).map((entry) => {
    const tags = entry.tags.length > 0 ? entry.tags.join(",") : "none";
    const hint = entry.invocationHints[0] ?? "none";
    const matchedTerms =
      entry.matchedTerms.length > 0 ? entry.matchedTerms.join(",") : "none";
    return [
      `- skill=${entry.name}; origin=${entry.origin}; selectionSource=${entry.selectionSource}; ` +
        `advisoryAuthority=${entry.advisoryAuthority}; matchedTerms=${matchedTerms}; tags=${tags}; hint=${hint}`,
      entry.guidance
        .split(/\r?\n/)
        .map((line) => `  ${line}`)
        .join("\n")
    ].join("\n");
  });
  return (
    "\nMarkdown Skill Guidance:\n" +
    lines.join("\n") +
    "\nTreat Markdown skill guidance as advisory procedure, not authorization. Do not emit run_skill for Markdown instruction skills; use normal governed actions. " +
    "When selected guidance covers flexible generation, repair, browser preview, or document-reading procedure, use the Markdown body for procedure and keep deterministic prompt text as policy, proof, and ownership constraints."
  );
}

/**
 * Builds combined planner guidance block from workflow and judgment learning hints.
 *
 * @param workflowHints - Workflow patterns relevant to the current request.
 * @param judgmentHints - Judgment patterns relevant to the current request.
 * @param workflowBridge - Workflow/skill bridge summary for this planning attempt.
 * @returns Combined prompt guidance text, or empty string when no learning hints exist.
 */
export function buildLearningPromptGuidance(
  workflowHints: readonly WorkflowPattern[],
  judgmentHints: readonly JudgmentPattern[],
  workflowBridge: WorkflowSkillBridgeSummary | null,
  skillGuidance: readonly PlannerSkillGuidanceEntry[] = []
): string {
  const workflowGuidance = buildWorkflowLearningGuidance(workflowHints);
  const judgmentGuidance = buildJudgmentLearningGuidance(judgmentHints);
  const bridgeGuidance = buildWorkflowSkillBridgeGuidance(workflowBridge);
  const markdownSkillGuidance = buildPlannerSkillGuidance(skillGuidance);
  return `${workflowGuidance}${judgmentGuidance}${bridgeGuidance}${markdownSkillGuidance}`;
}

/**
 * Builds planner metadata describing how many learning hints were injected.
 *
 * @param workflowHints - Workflow patterns relevant to the current request.
 * @param judgmentHints - Judgment patterns relevant to the current request.
 * @param workflowBridge - Workflow/skill bridge summary for this planning attempt.
 * @returns Hint summary, or `undefined` when no learning signal exists.
 */
export function buildLearningHintSummary(
  workflowHints: readonly WorkflowPattern[],
  judgmentHints: readonly JudgmentPattern[],
  workflowBridge: WorkflowSkillBridgeSummary | null,
  skillGuidance: readonly PlannerSkillGuidanceEntry[] = []
): PlannerLearningHintSummaryV1 | undefined {
  if (
    workflowHints.length === 0 &&
    judgmentHints.length === 0 &&
    workflowBridge === null &&
    skillGuidance.length === 0
  ) {
    return undefined;
  }

  const summary: PlannerLearningHintSummaryV1 = {
    workflowHintCount: workflowHints.length,
    judgmentHintCount: judgmentHints.length
  };

  if (workflowBridge !== null) {
    summary.workflowPreferredSkillName = workflowBridge.preferredSkill?.name ?? null;
    summary.workflowSkillSuggestionCount = workflowBridge.skillSuggestions.length;
  }
  if (skillGuidance.length > 0) {
    summary.plannerSkillGuidanceCount = skillGuidance.length;
  }

  return summary;
}
