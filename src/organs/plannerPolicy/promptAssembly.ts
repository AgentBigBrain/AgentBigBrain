/**
 * @fileoverview Planner prompt assembly and model-request helpers for execution-style policy.
 */

import { Stage685PlaybookPlanningContext } from "../../core/stage6_85PlaybookRuntime";
import { ModelClient, PlannerModelOutput } from "../../models/types";
import {
  allowsImplicitFiniteShellForBuildRequest,
  buildExecutionStyleRequiredActionHint
} from "./buildExecutionPolicy";
import {
  PlannerPromptBuildInput,
  PlannerRepairPromptBuildInput,
  RequiredActionType
} from "./executionStyleContracts";
import {
  allowsImplicitManagedProcessForBuildRequest,
  isExecutionStyleBuildRequest,
  isLiveVerificationBuildRequest,
  requiresBrowserVerificationBuildRequest
} from "./liveVerificationPolicy";

const SHELL_EXPLICIT_REQUEST_PATTERN =
  /\b(shell|terminal|powershell|bash|zsh|cmd(?:\.exe)?|command line|run (?:a )?command|execute (?:a )?command)\b/i;
const SELF_MODIFY_EXPLICIT_REQUEST_PATTERN =
  /\b(self[-\s]?modify|modify (?:yourself|your own|the agent|the brain|runtime|source|codebase|governor|policy)|edit (?:agent|runtime|source|code|config)|patch (?:agent|runtime|codebase)|change (?:governor|policy|hard constraint|runtime|codebase))\b/i;

export const RESPONSE_IDENTITY_GUARDRAIL =
  "Keep explicit AI-agent identity in all user-facing text. " +
  "Do not claim to be human, do not claim to be the user, and do not write in first person as if you are the user. ";
export const RESPONSE_STYLE_GUARDRAIL =
  "When you write user-facing text, keep it human-first: plain language first, brief explanation second, and a concrete next step when relevant. " +
  "Avoid internal control-plane jargon unless diagnostics were explicitly requested. ";

/**
 * Builds execution environment guidance for planner prompts.
 */
export function buildExecutionEnvironmentGuidance(
  executionEnvironment: PlannerPromptBuildInput["executionEnvironment"]
): string {
  return (
    "\nExecution Environment:\n" +
    `- platform: ${executionEnvironment.platform}\n` +
    `- shellKind: ${executionEnvironment.shellKind}\n` +
    `- invocationMode: ${executionEnvironment.invocationMode}\n` +
    `- commandMaxChars: ${executionEnvironment.commandMaxChars}\n` +
    "- If you emit shell_command or start_process, the command must be valid for this shellKind."
  );
}

/**
 * Builds deterministic build-task strategy guidance for planner prompts.
 */
export function buildExecutionStyleBuildStrategyGuidance(currentUserRequest: string): string {
  if (!isExecutionStyleBuildRequest(currentUserRequest)) {
    return "";
  }

  const browserVerificationClause = requiresBrowserVerificationBuildRequest(currentUserRequest)
    ? " Explicit browser/UI proof is required: after localhost readiness succeeds, use verify_browser with params.url and any available expectedTitle/expectedText hints."
    : "";
  const liveVerificationClause = isLiveVerificationBuildRequest(currentUserRequest)
    ? " Live-run verification intent detected: only choose a long-running run/observe step after finite proof steps succeed. When localhost readiness proof is required, pair start_process with probe_port or probe_http. The same plan must contain the local proof chain needed to finish truthfully: start_process (when a local server is required), then probe_port or probe_http for loopback readiness, then verify_browser when UI verification was requested. Do not stop at helper-file creation or partial setup when live proof is still missing. Do not claim browser or UI verification from probes alone." +
      browserVerificationClause +
      " If live verification still cannot be proven truthfully in this runtime path, say so plainly instead of claiming the app was running or the UI was verified."
    : "";

  return (
    "\nDeterministic build-task strategy: prefer finite proof steps before any live session. " +
    "Use the smallest executable sequence that can prove progress, usually scaffold -> edit -> install -> build -> finite verification. " +
    "Read_file, list_directory, check_process, or stop_process can support the plan, but they do not satisfy an execution-style build request by themselves. " +
    "Do not use long-running dev-server commands (for example npm start, npm run dev, next dev, vite dev, or watch mode) as the default proof step when a finite build/test verification step exists. " +
    "Only use managed-process actions (start_process/check_process/stop_process) when live verification is explicitly required and policy allows it. " +
    "Use probe_port or probe_http only for loopback-local readiness checks." +
    liveVerificationClause
  );
}

/**
 * Appends deterministic repair guidance for invalid planner action plans.
 *
 * @param repairReason - Machine-readable repair reason emitted by planner validation.
 * @returns Additional prompt text describing how the repaired plan should change.
 */
function buildPlannerRepairReasonGuidance(repairReason: string): string {
  if (repairReason.startsWith("invalid_execution_style_build_plan:LIVE_VERIFICATION_ACTION_REQUIRED")) {
    return (
      " The prior plan failed because it omitted live-verification actions. " +
      "Repair by returning one action list that contains the complete local proof chain needed to finish truthfully: " +
      "start_process when a local server is required, then probe_port or probe_http for loopback readiness, " +
      "and verify_browser when the request asks for UI or homepage verification. " +
      "Do not return helper-file creation by itself as the repaired plan."
    );
  }
  if (repairReason.startsWith("invalid_execution_style_build_plan:START_PROCESS_REQUIRES_PROOF_ACTION")) {
    return (
      " The prior plan failed because it started a process without also planning the required proof steps. " +
      "Repair by keeping start_process and adding loopback readiness proof with probe_port or probe_http, " +
      "plus verify_browser whenever the request explicitly asks for UI verification."
    );
  }
  if (repairReason.startsWith("invalid_execution_style_build_plan:BROWSER_VERIFICATION_ACTION_REQUIRED")) {
    return (
      " The prior plan failed because it omitted verify_browser for an explicit UI verification request. " +
      "Repair by adding verify_browser after readiness proof in the same action list."
    );
  }
  return "";
}

/**
 * Builds playbook guidance for planner prompts.
 */
export function buildPlaybookGuidance(
  playbookSelection: Stage685PlaybookPlanningContext | null
): string {
  if (!playbookSelection) {
    return "";
  }

  if (!playbookSelection.fallbackToPlanner && playbookSelection.selectedPlaybookId) {
    const selectedPlaybookName = playbookSelection.selectedPlaybookName ?? "unnamed_playbook";
    const tags = playbookSelection.requestedTags.join(",");
    return (
      "\nDeterministic Stage 6.85 playbook match is available. " +
      `Selected playbook id: ${playbookSelection.selectedPlaybookId}. ` +
      `Selected playbook name: ${selectedPlaybookName}. ` +
      `Requested tags: ${tags}. ` +
      `Required input schema: ${playbookSelection.requiredInputSchema}. ` +
      "Use this playbook context as the default workflow scaffold and avoid clarification-only output " +
      "unless a safety-critical unknown blocks execution. " +
      "For build/research playbook matches, prefer respond actions with deterministic steps. " +
      "Do not emit run_skill unless the current user request explicitly asks to run or use a named skill."
    );
  }

  return (
    "\nDeterministic Stage 6.85 playbook fallback is active. " +
    `Fallback reason: ${playbookSelection.reason}. ` +
    "Use normal planning with explicit assumptions and avoid repeated clarification loops."
  );
}

/**
 * Builds deterministic high-risk action guardrails for planner prompts.
 */
export function buildHighRiskActionGuardrails(currentUserRequest: string): string {
  const disallowedActionTypes: string[] = [];
  const allowImplicitFiniteShell =
    allowsImplicitFiniteShellForBuildRequest(currentUserRequest);
  const allowImplicitManagedProcess =
    allowsImplicitManagedProcessForBuildRequest(currentUserRequest);
  if (
    !SHELL_EXPLICIT_REQUEST_PATTERN.test(currentUserRequest) &&
    !allowImplicitFiniteShell
  ) {
    disallowedActionTypes.push("shell_command");
  }
  if (
    !SHELL_EXPLICIT_REQUEST_PATTERN.test(currentUserRequest) &&
    !allowImplicitManagedProcess
  ) {
    disallowedActionTypes.push("start_process");
  }
  if (!requiresBrowserVerificationBuildRequest(currentUserRequest)) {
    disallowedActionTypes.push("verify_browser");
  }
  if (!SELF_MODIFY_EXPLICIT_REQUEST_PATTERN.test(currentUserRequest)) {
    disallowedActionTypes.push("self_modify");
  }
  if (disallowedActionTypes.length === 0) {
    return "";
  }

  const buildExecutionBias = isExecutionStyleBuildRequest(currentUserRequest)
    ? " Execution-style build request detected: prefer concrete build or proof actions (for example write_file, shell_command, start_process, probe_http, or verify_browser). Read_file, list_directory, check_process, and stop_process may support the plan but are too weak by themselves. Avoid guidance-only respond output when policy allows."
    : "";

  return (
    "\nDeterministic high-risk action guardrail: " +
    `for this request, do not emit ${disallowedActionTypes.join(" or ")} actions unless the user explicitly requests them. ` +
    "Prefer request-relevant action types such as respond, run_skill, or scoped file actions." +
    buildExecutionBias
  );
}

/**
 * Builds required-action guidance for planner and repair prompts.
 */
function buildRequiredActionHint(requiredActionType: RequiredActionType, repairMode = false): string {
  if (requiredActionType === "create_skill") {
    return repairMode
      ? "Repair must include at least one create_skill action because the explicit user request is to create a skill."
      : "Current user request explicitly asks to create a skill. Include at least one create_skill action and do not replace it with respond-only output.";
  }
  if (requiredActionType === "run_skill") {
    return repairMode
      ? "Repair must include at least one run_skill action because the explicit user request is to run or use a skill."
      : "Current user request explicitly asks to run or use a skill. Include at least one run_skill action and do not replace it with respond-only output.";
  }
  if (!requiredActionType) {
    return "";
  }
  return repairMode
    ? `Repair must include at least one ${requiredActionType} action because the explicit user request names ${requiredActionType}.`
    : `Current user request explicitly asks for ${requiredActionType}. Include at least one ${requiredActionType} action and do not replace it with unrelated actions or respond-only output.`;
}

/**
 * Builds the planner system prompt for the first-pass planning call.
 */
export function buildPlannerSystemPrompt(input: PlannerPromptBuildInput): string {
  const playbookGuidance = buildPlaybookGuidance(input.playbookSelection);
  const highRiskActionGuardrails = buildHighRiskActionGuardrails(input.currentUserRequest);
  const executionEnvironmentGuidance = buildExecutionEnvironmentGuidance(input.executionEnvironment);
  const buildStrategyGuidance =
    buildExecutionStyleBuildStrategyGuidance(input.currentUserRequest);
  const requiredActionHint = buildRequiredActionHint(input.requiredActionType, false);
  const executionStyleRequiredActionHint =
    buildExecutionStyleRequiredActionHint(input.currentUserRequest);
  return (
    "You are a planning organ for an autonomous system. Return compact JSON with plannerNotes and actions[]. " +
    "Always produce at least one valid action. For conversational requests, emit a `respond` action. " +
    "If you emit a respond action, include params.message with the exact user-facing text. " +
    RESPONSE_IDENTITY_GUARDRAIL +
    RESPONSE_STYLE_GUARDRAIL +
    "If you emit a write_file action, include params.path and params.content with the full file content to write. " +
    "If you emit a read_file action, include params.path. " +
    "If you emit a shell_command action, include params.command with the exact command string. " +
    "If you emit a start_process action, include params.command and any needed cwd/workdir fields. " +
    "If you emit check_process or stop_process, include params.leaseId. " +
    "If you emit a probe_port action, include params.port and optional params.host/timeoutMs. " +
    "If you emit a probe_http action, include params.url and optional params.expectedStatus/timeoutMs. " +
    "If you emit a verify_browser action, include params.url and optional params.expectedTitle/expectedText/timeoutMs. " +
    requiredActionHint +
    executionStyleRequiredActionHint +
    executionEnvironmentGuidance +
    buildStrategyGuidance +
    playbookGuidance +
    highRiskActionGuardrails +
    input.firstPrinciplesGuidance +
    input.learningGuidance +
    input.lessonsText
  );
}

/**
 * Builds the planner system prompt for deterministic repair calls.
 */
export function buildPlannerRepairSystemPrompt(input: PlannerRepairPromptBuildInput): string {
  const playbookGuidance = buildPlaybookGuidance(input.playbookSelection);
  const highRiskActionGuardrails = buildHighRiskActionGuardrails(input.currentUserRequest);
  const executionEnvironmentGuidance = buildExecutionEnvironmentGuidance(input.executionEnvironment);
  const buildStrategyGuidance =
    buildExecutionStyleBuildStrategyGuidance(input.currentUserRequest);
  const requiredActionHint = buildRequiredActionHint(input.requiredActionType, true);
  const executionStyleRequiredActionHint =
    buildExecutionStyleRequiredActionHint(input.currentUserRequest, true);
  const repairReasonGuidance = buildPlannerRepairReasonGuidance(input.repairReason);
  return (
    "You are repairing a planner JSON output that had no valid actions. " +
    "Return compact JSON with plannerNotes and actions[]. " +
    "Actions must use only allowed types: respond, read_file, write_file, delete_file, list_directory, create_skill, run_skill, network_write, self_modify, shell_command, start_process, check_process, stop_process, probe_port, probe_http, verify_browser. " +
    "Always produce at least one valid action. For conversational requests, emit respond with params.message. " +
    RESPONSE_IDENTITY_GUARDRAIL +
    RESPONSE_STYLE_GUARDRAIL +
    "For write_file, include params.path and params.content (the full file content). " +
    "For read_file, include params.path. For shell_command, include params.command. " +
    "For start_process, include params.command and any needed cwd/workdir fields. " +
    "For check_process or stop_process, include params.leaseId. " +
    "For probe_port, include params.port and optional params.host/timeoutMs. " +
    "For probe_http, include params.url and optional params.expectedStatus/timeoutMs. " +
    "For verify_browser, include params.url and optional params.expectedTitle/expectedText/timeoutMs. " +
    requiredActionHint +
    executionStyleRequiredActionHint +
    repairReasonGuidance +
    executionEnvironmentGuidance +
    buildStrategyGuidance +
    playbookGuidance +
    highRiskActionGuardrails +
    input.firstPrinciplesGuidance +
    input.learningGuidance +
    input.lessonsText
  );
}

/**
 * Requests planner output using the canonical planner-policy prompt assembly.
 */
export async function requestPlannerOutput(
  modelClient: ModelClient,
  input: PlannerPromptBuildInput
): Promise<PlannerModelOutput> {
  return modelClient.completeJson<PlannerModelOutput>({
    model: input.plannerModel,
    schemaName: "planner_v1",
    temperature: 0,
    systemPrompt: buildPlannerSystemPrompt(input),
    userPrompt: JSON.stringify({
      taskId: input.task.id,
      goal: input.task.goal,
      userInput: input.task.userInput,
      currentUserRequest: input.currentUserRequest,
      requiredActionType: input.requiredActionType,
      playbookSelection: input.playbookSelection
    })
  });
}

/**
 * Requests repair planner output using the canonical planner-policy prompt assembly.
 */
export async function requestPlannerRepairOutput(
  modelClient: ModelClient,
  input: PlannerRepairPromptBuildInput
): Promise<PlannerModelOutput> {
  return modelClient.completeJson<PlannerModelOutput>({
    model: input.plannerModel,
    schemaName: "planner_v1",
    temperature: 0,
    systemPrompt: buildPlannerRepairSystemPrompt(input),
    userPrompt: JSON.stringify({
      taskId: input.task.id,
      goal: input.task.goal,
      userInput: input.task.userInput,
      currentUserRequest: input.currentUserRequest,
      requiredActionType: input.requiredActionType,
      repairReason: input.repairReason,
      invalidPlannerOutput: input.previousOutput,
      playbookSelection: input.playbookSelection
    })
  });
}
