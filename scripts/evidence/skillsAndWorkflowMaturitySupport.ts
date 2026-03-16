/**
 * @fileoverview Shared harness helpers for skills/workflow evidence and live-smoke scripts.
 */

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadPlannerLearningContext } from "../../src/core/orchestration/orchestratorPlanning";
import { type ActionRunResult, type PlannedAction, type TaskRunResult, type WorkflowObservation } from "../../src/core/types";
import {
  deriveWorkflowObservationFromTaskRun,
  WorkflowLearningStore
} from "../../src/core/workflowLearningStore";
import { summarizeWorkflowPatterns } from "../../src/core/workflowLearningRuntime/workflowInspection";
import { ConversationManager } from "../../src/interfaces/conversationManager";
import type { ConversationInboundMessage, ExecuteConversationTask } from "../../src/interfaces/conversationRuntime/managerContracts";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";
import { executeCreateSkillAction, executeRunSkillAction } from "../../src/organs/executionRuntime/skillRuntime";
import { SkillRegistryStore } from "../../src/organs/skillRegistry/skillRegistryStore";
import { renderSkillInventory } from "../../src/organs/skillRegistry/skillInspection";
import type { WorkflowSkillBridgeSummary } from "../../src/organs/skillRegistry/workflowSkillBridge";

export const SKILLS_AND_WORKFLOW_MATURITY_ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/skills_and_workflow_maturity_report.json"
);

export const SKILLS_AND_WORKFLOW_MATURITY_LIVE_SMOKE_ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/skills_and_workflow_maturity_live_smoke_report.json"
);

export const SKILLS_AND_WORKFLOW_MATURITY_EVIDENCE_COMMAND =
  "tsx scripts/evidence/skillsAndWorkflowMaturityEvidence.ts";

export const SKILLS_AND_WORKFLOW_MATURITY_LIVE_SMOKE_COMMAND =
  "tsx scripts/evidence/skillsAndWorkflowMaturityLiveSmoke.ts";

export interface SkillsWorkflowHarnessContext {
  tempDir: string;
  skillRegistryStore: SkillRegistryStore;
  workflowLearningStore: WorkflowLearningStore;
  sessionStore: InterfaceSessionStore;
  conversationManager: ConversationManager;
}

export interface SkillLifecycleEvidence {
  createAction: PlannedAction;
  runAction: PlannedAction;
  createOutcome: Awaited<ReturnType<typeof executeCreateSkillAction>>;
  runOutcome: Awaited<ReturnType<typeof executeRunSkillAction>>;
  inventoryText: string;
}

export interface WorkflowEvidence {
  relevantPatterns: readonly import("../../src/core/types").WorkflowPattern[];
  bridgeSummary: WorkflowSkillBridgeSummary | null;
  inspectionSummary: readonly import("../../src/core/workflowLearningRuntime/contracts").WorkflowInspectionEntry[];
}

/**
 * Normalizes natural skill-discovery wording back to the canonical slash inventory header.
 *
 * @param reply - User-facing skill discovery reply text.
 * @returns Canonicalized inventory text for semantic comparison.
 */
function canonicalizeSkillDiscoveryReply(reply: string): string {
  return reply.replace(/^Reusable skills I can lean on:/u, "Available skills:");
}

/**
 * Ensures the runtime evidence directory exists before an artifact write.
 */
export async function ensureSkillsWorkflowEvidenceDirectory(): Promise<void> {
  await mkdir(path.dirname(SKILLS_AND_WORKFLOW_MATURITY_ARTIFACT_PATH), { recursive: true });
  await mkdir(path.dirname(SKILLS_AND_WORKFLOW_MATURITY_LIVE_SMOKE_ARTIFACT_PATH), {
    recursive: true
  });
}

/**
 * Removes one temporary directory with short retries so Windows async file handles can settle.
 *
 * @param tempDir - Temporary directory created by the skills/workflow harness.
 */
async function removeTempDirWithRetry(tempDir: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await rm(tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!["ENOTEMPTY", "EPERM", "EBUSY", "ENOENT"].includes(code)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 75));
    }
  }

  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (!["ENOTEMPTY", "EPERM", "EBUSY", "ENOENT"].includes(code)) {
      throw error;
    }
  }
}

/**
 * Executes one callback inside an isolated temporary workspace so skill/runtime artifacts do not
 * pollute the repo checkout.
 *
 * @param fn - Callback that receives the initialized temp-runtime collaborators.
 * @returns Callback result.
 */
export async function withSkillsWorkflowHarness<T>(
  fn: (context: SkillsWorkflowHarnessContext) => Promise<T>
): Promise<T> {
  const previousCwd = process.cwd();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-skills-workflow-"));
  try {
    process.chdir(tempDir);
    await mkdir(path.resolve(tempDir, "runtime"), { recursive: true });
    const skillRegistryStore = new SkillRegistryStore(path.resolve(tempDir, "runtime/skills"));
    const workflowLearningStore = new WorkflowLearningStore(
      path.resolve(tempDir, "runtime/workflow_learning.json")
    );
    const sessionStore = new InterfaceSessionStore(
      path.resolve(tempDir, "runtime/interface_sessions.json")
    );
    const conversationManager = new ConversationManager(
      sessionStore,
      {},
      {
        listAvailableSkills: () => skillRegistryStore.listAvailableSkills()
      }
    );
    return await fn({
      tempDir,
      skillRegistryStore,
      workflowLearningStore,
      sessionStore,
      conversationManager
    });
  } finally {
    process.chdir(previousCwd);
    await removeTempDirWithRetry(tempDir);
  }
}

/**
 * Builds the canonical create-skill action used by the skills/workflow proof harness.
 *
 * @returns Planned create-skill action.
 */
export function buildCreateSkillAction(): PlannedAction {
  return {
    id: "action_create_skill_triage_planner_failure",
    type: "create_skill",
    description: "Create a reusable planner triage skill.",
    params: {
      name: "triage_planner_failure",
      code: [
        "export default async function run(input) {",
        "  const normalized = String(input ?? '').trim();",
        "  return `triaged:${normalized}`;",
        "}"
      ].join("\n"),
      description: "Inspect planner failures and summarize likely causes.",
      purpose: "Provide deterministic planner failure triage.",
      inputSummary: "Short planner failure description.",
      outputSummary: "Short triage summary.",
      riskLevel: "low",
      allowedSideEffects: ["filesystem_read"],
      tags: ["planner", "tests"],
      capabilities: ["triage", "planner"],
      version: "1.0.0",
      userSummary: "Reusable tool for planner failure triage.",
      invocationHints: ["Ask me what skills I know or run skill triage_planner_failure."],
      testInput: "planner branch mismatch",
      expectedOutputContains: "triaged:"
    },
    estimatedCostUsd: 0.02
  };
}

/**
 * Builds the canonical run-skill action used by the skills/workflow proof harness.
 *
 * @returns Planned run-skill action.
 */
export function buildRunSkillAction(): PlannedAction {
  return {
    id: "action_run_skill_triage_planner_failure",
    type: "run_skill",
    description: "Reuse the verified planner triage skill.",
    params: {
      name: "triage_planner_failure",
      input: "planner branch mismatch"
    },
    estimatedCostUsd: 0.01
  };
}

/**
 * Executes the canonical create/run skill lifecycle and returns the manifest-backed inventory
 * surface for later proof checks.
 *
 * @param skillRegistryStore - Canonical runtime skill registry.
 * @returns Skill lifecycle evidence bundle.
 */
export async function runSkillLifecycleEvidence(
  skillRegistryStore: SkillRegistryStore
): Promise<SkillLifecycleEvidence> {
  const createAction = buildCreateSkillAction();
  const runAction = buildRunSkillAction();
  const createOutcome = await executeCreateSkillAction(createAction);
  const runOutcome = await executeRunSkillAction(runAction);
  const inventory = await skillRegistryStore.listAvailableSkills();
  const inventoryText = renderSkillInventory(inventory);

  return {
    createAction,
    runAction,
    createOutcome,
    runOutcome,
    inventoryText
  };
}

/**
 * Converts a planned action plus runtime execution outcome into the canonical action-result shape
 * used by workflow-learning extraction.
 *
 * @param action - Planned action that was executed.
 * @param outcome - Real runtime execution outcome.
 * @returns Action-run result for task receipts.
 */
export function buildActionRunResultFromOutcome(
  action: PlannedAction,
  outcome: SkillLifecycleEvidence["createOutcome"]
): ActionRunResult {
  return {
    action,
    mode: "fast_path",
    approved: true,
    output: outcome.output,
    executionStatus: outcome.status,
    executionFailureCode: outcome.failureCode,
    executionMetadata: outcome.executionMetadata,
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Builds a reusable task-run receipt that links a verified skill into workflow learning.
 *
 * @param runOutcome - Real runtime outcome from `run_skill`.
 * @param completedAt - Timestamp used for deterministic receipts.
 * @returns Task-run result suitable for workflow observation extraction.
 */
export function buildSkillWorkflowTaskRunResult(
  runOutcome: SkillLifecycleEvidence["runOutcome"],
  completedAt: string
): TaskRunResult {
  const readFileAction: PlannedAction = {
    id: "action_read_file_planner",
    type: "read_file",
    description: "Read the planner file before triage.",
    params: {
      path: "src/organs/planner.ts"
    },
    estimatedCostUsd: 0.01
  };
  const respondAction: PlannedAction = {
    id: "action_respond_triage_summary",
    type: "respond",
    description: "Respond with the triage summary.",
    params: {
      message: "triaged:planner branch mismatch"
    },
    estimatedCostUsd: 0.01
  };
  return {
    task: {
      id: `task_skill_workflow_${completedAt}`,
      goal: "Triage the planner failure with a reusable skill.",
      userInput:
        "Please inspect the planner failure, reuse the proven skill if it exists, and summarize the cause.",
      createdAt: completedAt
    },
    plan: {
      taskId: `task_skill_workflow_${completedAt}`,
      plannerNotes: "Use the verified planner triage skill for repeated planner failures.",
      actions: [readFileAction, buildRunSkillAction(), respondAction]
    },
    actionResults: [
      {
        action: readFileAction,
        mode: "fast_path",
        approved: true,
        output: "planner contents",
        executionStatus: "success",
        blockedBy: [],
        violations: [],
        votes: []
      },
      buildActionRunResultFromOutcome(buildRunSkillAction(), runOutcome),
      {
        action: respondAction,
        mode: "fast_path",
        approved: true,
        output: "triaged:planner branch mismatch",
        executionStatus: "success",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary: "Planner failure triaged with a verified skill.",
    startedAt: completedAt,
    completedAt
  };
}

/**
 * Builds a repeated non-skill workflow observation that should mature into a governed skill
 * suggestion when recorded enough times.
 *
 * @param observedAt - Deterministic observation timestamp.
 * @returns Structured workflow observation.
 */
export function buildWorkflowSuggestionObservation(observedAt: string): WorkflowObservation {
  return {
    workflowKey: "read_file+respond:planner_summary",
    outcome: "success",
    observedAt,
    domainLane: "workflow",
    contextTags: ["planner", "summary"],
    executionStyle: "multi_action",
    actionSequenceShape: "read_file>respond",
    approvalPosture: "fast_path_only",
    verificationProofPresent: false,
    costBand: "low",
    latencyBand: "fast",
    dominantFailureMode: null,
    recoveryPath: null,
    linkedSkillName: null,
    linkedSkillVerificationStatus: null
  };
}

/**
 * Records repeated skill-linked and non-skill workflow observations, then returns the planner
 * learning/inspection surfaces used by the proof scripts.
 *
 * @param workflowLearningStore - Canonical workflow-learning store.
 * @param runOutcome - Real `run_skill` runtime outcome used for linked-skill observations.
 * @param listAvailableSkills - Inventory callback for planner-learning context loading.
 * @returns Workflow evidence bundle.
 */
export async function runWorkflowEvidence(
  workflowLearningStore: WorkflowLearningStore,
  runOutcome: SkillLifecycleEvidence["runOutcome"],
  listAvailableSkills: () => Promise<readonly import("../../src/organs/skillRegistry/contracts").SkillInventoryEntry[]>
): Promise<WorkflowEvidence> {
  const linkedRunResultOne = buildSkillWorkflowTaskRunResult(
    runOutcome,
    "2026-03-10T16:00:00.000Z"
  );
  const linkedRunResultTwo = buildSkillWorkflowTaskRunResult(
    runOutcome,
    "2026-03-10T16:05:00.000Z"
  );
  const linkedRunResultThree = buildSkillWorkflowTaskRunResult(
    runOutcome,
    "2026-03-10T16:10:00.000Z"
  );

  await workflowLearningStore.recordObservation(deriveWorkflowObservationFromTaskRun(linkedRunResultOne));
  await workflowLearningStore.recordObservation(deriveWorkflowObservationFromTaskRun(linkedRunResultTwo));
  await workflowLearningStore.recordObservation(deriveWorkflowObservationFromTaskRun(linkedRunResultThree));
  await workflowLearningStore.recordObservation(
    buildWorkflowSuggestionObservation("2026-03-10T16:15:00.000Z")
  );
  await workflowLearningStore.recordObservation(
    buildWorkflowSuggestionObservation("2026-03-10T16:20:00.000Z")
  );

  const relevantPatterns = await workflowLearningStore.getRelevantPatterns(
    "planner failure summary skill",
    5
  );
  const plannerLearningContext = await loadPlannerLearningContext(
    {
      workflowLearningStore,
      listAvailableSkills
    },
    "Please handle the planner failure summary and reuse a proven skill if one exists."
  );
  const inspectionSummary = summarizeWorkflowPatterns((await workflowLearningStore.load()).patterns);

  return {
    relevantPatterns,
    bridgeSummary: plannerLearningContext.workflowBridge,
    inspectionSummary
  };
}

/**
 * Sends one inbound message through the real conversation manager and returns the immediate user
 * reply text.
 *
 * @param conversationManager - Stable conversation manager entrypoint.
 * @param message - Inbound provider message.
 * @returns Immediate reply text from the manager.
 */
export async function runConversationManagerMessage(
  conversationManager: ConversationManager,
  message: ConversationInboundMessage
): Promise<string> {
  const executeTask: ExecuteConversationTask = async (input) => ({
    summary: `executed:${input}`
  });
  return conversationManager.handleMessage(message, executeTask, async () => undefined);
}

/**
 * Compares slash, natural, or voice skill-discovery replies against the canonical inventory text.
 *
 * @param reply - User-facing reply returned by the conversation manager.
 * @param inventoryText - Canonical slash-command inventory text.
 * @returns `true` when the reply expresses the same inventory content.
 */
export function matchesSkillDiscoveryReply(reply: string, inventoryText: string): boolean {
  return canonicalizeSkillDiscoveryReply(reply) === inventoryText;
}
