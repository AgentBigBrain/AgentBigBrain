/**
 * @fileoverview Planner prompt assembly and model-request helpers for execution-style policy.
 */

import { Stage685PlaybookPlanningContext } from "../../core/stage6_85PlaybookRuntime";
import { ModelClient, PlannerModelOutput } from "../../models/types";
import {
  allowsImplicitFiniteShellForBuildRequest
} from "./buildExecutionPolicy";
import { buildExecutionStyleRequiredActionHint } from "./buildExecutionPlanMessaging";
import {
  PlannerPromptBuildInput,
  PlannerRepairPromptBuildInput,
  RequiredActionType
} from "./executionStyleContracts";
import { buildPlannerRepairReasonGuidance } from "./promptAssemblyRepairGuidance";
import { buildWorkspaceRecoveryActionPolicyGuidance } from "./promptAssemblyRecoveryGuidance";
import {
  allowsImplicitManagedProcessForBuildRequest,
  isExecutionStyleBuildRequest,
  isLocalWorkspaceOrganizationRequest,
  isLiveVerificationBuildRequest,
  requiresBrowserVerificationBuildRequest,
  requiresPersistentBrowserOpenBuildRequest
} from "./liveVerificationPolicy";

const SHELL_EXPLICIT_REQUEST_PATTERN =
  /\b(shell|terminal|powershell|bash|zsh|cmd(?:\.exe)?|command line|run (?:a )?command|execute (?:a )?command)\b/i;
const SELF_MODIFY_EXPLICIT_REQUEST_PATTERN =
  /\b(self[-\s]?modify|modify (?:yourself|your own|the agent|the brain|runtime|source|codebase|governor|policy)|edit (?:agent|runtime|source|code|config)|patch (?:agent|runtime|codebase)|change (?:governor|policy|hard constraint|runtime|codebase))\b/i;
const USER_OWNED_LOCAL_DESTINATION_PATTERN =
  /\bon\s+my\s+(desktop|documents|downloads)\b|\bcreate\s+a\s+folder\s+called\b|\bin\s+the\s+folder\s+called\b/i;
const BROWSER_CONTROL_REQUEST_PATTERN =
  /\b(?:open|reopen|close|leave|keep)\b[\s\S]{0,40}\b(?:browser|tab|window|page)\b/i;

export const RESPONSE_IDENTITY_GUARDRAIL =
  "Use first-person voice for your own actions and replies by default. " +
  "Do not claim to be human, do not claim to be the user, and do not write in first person as if you are the user. " +
  "Do not volunteer AI-agent identity or refer to yourself in third person or by name unless the user explicitly asks for that style or the identity is directly relevant. ";
export const RESPONSE_STYLE_GUARDRAIL =
  "When you write user-facing text, keep it human-first: plain language first, brief explanation second, and a concrete next step when relevant. " +
  "Avoid internal control-plane jargon unless diagnostics were explicitly requested. ";

/**
 * Builds execution environment guidance for planner prompts.
 */
export function buildExecutionEnvironmentGuidance(
  executionEnvironment: PlannerPromptBuildInput["executionEnvironment"]
): string {
  const pathHints = [
    executionEnvironment.desktopPath
      ? `- desktopPath: ${executionEnvironment.desktopPath}`
      : null,
    executionEnvironment.documentsPath
      ? `- documentsPath: ${executionEnvironment.documentsPath}`
      : null,
    executionEnvironment.downloadsPath
      ? `- downloadsPath: ${executionEnvironment.downloadsPath}`
      : null
  ].filter((line): line is string => line !== null);
  return (
    "\nExecution Environment:\n" +
    `- platform: ${executionEnvironment.platform}\n` +
    `- shellKind: ${executionEnvironment.shellKind}\n` +
    `- invocationMode: ${executionEnvironment.invocationMode}\n` +
    `- commandMaxChars: ${executionEnvironment.commandMaxChars}\n` +
    (pathHints.length > 0 ? `${pathHints.join("\n")}\n` : "") +
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

  const frameworkNativePreviewClause =
    /\b(?:react|vite|next\.?js|nextjs|vue|svelte|angular)\b/i.test(currentUserRequest)
      ? " For framework apps that already have package scripts, prefer the workspace-native command from the exact project folder, such as npm run preview, npm run dev, npm run start, vite preview, or vite dev. Avoid ad-hoc preview servers like npx serve when the framework already provides a native preview/runtime path. Once the exact project folder is known, use cwd/workdir or Set-Location into that folder instead of relying on multi-step npm --prefix chaining from the parent directory."
      : "";
  const staticPreviewClause = requiresPersistentBrowserOpenBuildRequest(currentUserRequest)
    ? " If the request only needs a visible local preview and does not explicitly ask for localhost readiness, browser verification, screenshots, or Playwright proof, prefer opening a static artifact directly with an absolute file:// URL instead of inventing a local server."
    : "";
  const browserVerificationClause = requiresBrowserVerificationBuildRequest(currentUserRequest)
    ? " Explicit browser/UI proof is required: after localhost readiness succeeds, use verify_browser with params.url and any available expectedTitle/expectedText hints."
    : "";
  const persistentBrowserOpenClause = requiresPersistentBrowserOpenBuildRequest(currentUserRequest)
    ? " The request also asks to leave the page open afterward, so include open_browser as the final visible-browser step using the same verified loopback URL or the same local file URL you just built."
    : "";
  const liveVerificationClause = isLiveVerificationBuildRequest(currentUserRequest)
    ? " Live-run verification intent detected: only choose a long-running run/observe step after finite proof steps succeed. When localhost readiness proof is required, pair start_process with probe_port or probe_http. The same plan must contain the local proof chain needed to finish truthfully: start_process (when a local server is required), then probe_port or probe_http for loopback readiness, then verify_browser when UI verification was requested. Do not stop at helper-file creation or partial setup when live proof is still missing. Do not claim browser or UI verification from probes alone. For framework-app live verification, prefer the workspace-native preview/runtime command such as npm run preview, npm run dev, vite preview, or vite dev from the exact project folder instead of inventing an ad-hoc npx serve server." +
      browserVerificationClause +
      persistentBrowserOpenClause +
      " Do not use file:// URLs for open_browser when live verification or browser proof is required. If the built artifact is a static local site but the user explicitly asked for localhost proof, serve that folder on localhost first and then open the resulting loopback http URL." +
      " If live verification still cannot be proven truthfully in this runtime path, say so plainly instead of claiming the app was running or the UI was verified."
    : "";

  return (
    "\nDeterministic build-task strategy: prefer finite proof steps before any live session. " +
    "Use the smallest executable sequence that can prove progress, usually scaffold -> edit -> install -> build -> finite verification. " +
    "Keep shell and start-process commands within the configured commandMaxChars budget; when file contents are large, emit write_file actions instead of one oversized shell script. " +
    "Read_file, list_directory, check_process, or stop_process can support the plan, but they do not satisfy an execution-style build request by themselves. " +
    "Do not use long-running dev-server commands (for example npm start, npm run dev, next dev, vite dev, or watch mode) as the default proof step when a finite build/test verification step exists. " +
    "Only use managed-process actions (start_process/check_process/stop_process) when live verification is explicitly required and policy allows it. " +
    "Use probe_port or probe_http only for loopback-local readiness checks." +
    frameworkNativePreviewClause +
    staticPreviewClause +
    liveVerificationClause
  );
}

/**
 * Builds deterministic capability guidance for explicit local-destination and persistent-browser requests.
 */
function buildLocalCapabilityGuidance(
  currentUserRequest: string,
  executionEnvironment: PlannerPromptBuildInput["executionEnvironment"]
): string {
  const mentionsOwnedDestination = USER_OWNED_LOCAL_DESTINATION_PATTERN.test(currentUserRequest);
  const wantsWorkspaceOrganization = isLocalWorkspaceOrganizationRequest(currentUserRequest);
  const wantsPersistentBrowserOpen = requiresPersistentBrowserOpenBuildRequest(currentUserRequest);
  if (!mentionsOwnedDestination && !wantsPersistentBrowserOpen && !wantsWorkspaceOrganization) {
    return "";
  }

  const parts: string[] = [];
  if (mentionsOwnedDestination) {
    parts.push(
      "The user explicitly named a local destination they want used, such as their Desktop or a named folder. Treat that as an allowed local target when hard constraints permit it."
    );
    if (executionEnvironment.desktopPath && /\bdesktop\b/i.test(currentUserRequest)) {
      parts.push(
        `When the user says "my desktop", prefer ${executionEnvironment.desktopPath} instead of guessing Public Desktop or another shared location. Never substitute C:\\Users\\Public\\Desktop for \"my desktop.\"`
      );
    }
    if (executionEnvironment.documentsPath && /\bdocuments\b/i.test(currentUserRequest)) {
      parts.push(
        `When the user says "my documents", prefer ${executionEnvironment.documentsPath}.`
      );
    }
    if (executionEnvironment.downloadsPath && /\bdownloads\b/i.test(currentUserRequest)) {
      parts.push(
        `When the user says "my downloads", prefer ${executionEnvironment.downloadsPath}.`
      );
    }
  }
  if (wantsWorkspaceOrganization) {
    parts.push(
      "This request is executable local workspace organization, not a guidance-only question."
    );
    if (executionEnvironment.desktopPath) {
      parts.push(
        `If the user refers to project folders made earlier and names a new folder without another location, prefer ${executionEnvironment.desktopPath} as the concrete user-owned root instead of stalling for a second approval-style reply.`
      );
    }
    parts.push(
      "A bounded finite shell_command is allowed here for folder creation and move steps when the command stays scoped to the clearly matching project folders and the named destination folder."
    );
    parts.push(
      "Prefer a small plan such as list_directory of the concrete user-owned root, then create the destination folder if it is missing, then move only the matching project folders. Do not touch unrelated entries."
    );
    parts.push(
      "Inspection, holder shutdown, or browser actions can support the recovery, but they do not complete the organization request by themselves. The same plan must retry the actual scoped move after those recovery steps."
    );
    parts.push(
      "Do not treat an empty shell output as proof that folders were moved. Verify both sides after the move: the named destination should now contain the matching folders, and the original user-owned root should no longer show those same matching folders."
    );
    parts.push(
      "When a single bounded shell command is the simplest proof path, emit explicit move-proof markers in that command output, for example MOVED_TO_DEST=..., DEST_CONTENTS=..., and ROOT_REMAINING_MATCHES=..., so the runtime can render a human summary without guessing."
    );
    parts.push(
      "If a move fails because something still holds a folder open, do not emit broad process-name shutdown commands such as Stop-Process -Name, taskkill /IM, pkill, or killall. Prefer exact tracked stop_process actions first, then holder inspection or clarification if the blocker is still not proven."
    );
    if (
      executionEnvironment.platform === "win32" &&
      executionEnvironment.shellKind === "powershell"
    ) {
      parts.push(
        "For this Windows PowerShell runtime, emit real PowerShell syntax only. Prefer commands built from Get-ChildItem, New-Item, Test-Path, Move-Item, and Where-Object. Do not emit cmd.exe batch syntax such as if not exist, %D, %~fD, or chained && loops."
      );
      parts.push(
        "When you build status strings in PowerShell, do not write invalid fragments like \"$name:\" inside double-quoted strings. Use ${name}, $($name), or concatenation instead."
      );
    }
  }
  if (wantsPersistentBrowserOpen) {
    parts.push(
      "This runtime can launch a real visible local browser window with open_browser after verification, and a tracked runtime-managed session can later be closed with close_browser. Do not replace that with a claim that browser control is unavailable."
    );
  }
  parts.push(
    "Do not fall back to guidance-only respond output just because the request involves a local folder, a local loopback app, or a visible local browser window."
  );
  return `\nDeterministic local capability guidance: ${parts.join(" ")}`;
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
  if (
    !requiresPersistentBrowserOpenBuildRequest(currentUserRequest) &&
    !BROWSER_CONTROL_REQUEST_PATTERN.test(currentUserRequest)
  ) {
    disallowedActionTypes.push("open_browser");
  }
  if (!BROWSER_CONTROL_REQUEST_PATTERN.test(currentUserRequest)) {
    disallowedActionTypes.push("close_browser");
  }
  if (!SELF_MODIFY_EXPLICIT_REQUEST_PATTERN.test(currentUserRequest)) {
    disallowedActionTypes.push("self_modify");
  }
  if (disallowedActionTypes.length === 0) {
    return "";
  }

  const buildExecutionBias = isExecutionStyleBuildRequest(currentUserRequest)
    ? " Execution-style build request detected: prefer concrete build or proof actions (for example write_file, shell_command, start_process, probe_http, verify_browser, or open_browser when the user wants it left open). Read_file, list_directory, check_process, and stop_process may support the plan but are too weak by themselves. Avoid guidance-only respond output when policy allows."
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
  if (requiredActionType === "write_file") {
    return repairMode
      ? "Repair must include at least one write_file action because this is a tracked artifact-edit follow-up. Update the tracked primary artifact or another clearly related tracked file under the preferred workspace. Do not satisfy this request by only reopening or focusing the preview. If a visible tracked preview already exists in the request context, reopen that same preview after the edit so the user sees the updated artifact instead of stale content. Treat that as a file-update follow-up, not as a fresh live-verification build."
      : "Current user request is a tracked artifact-edit follow-up. Include at least one write_file action that changes the tracked primary artifact or another clearly related tracked file under the preferred workspace, and do not satisfy this request by only reopening or focusing the preview. If a visible tracked preview already exists in the request context, reopen that same preview after the edit so the user sees the updated artifact instead of stale content. Treat that as a file-update follow-up, not as a fresh live-verification build.";
  }
  if (requiredActionType === "close_browser") {
    return repairMode
      ? "Repair must include at least one close_browser action. Use the tracked browser session id from the current request context when it is available. If the current request context also includes a linked preview-process lease, follow the browser close with stop_process for that same lease so the local preview stack is actually shut down."
      : "Current user request explicitly asks to close a tracked browser window. Include at least one close_browser action, prefer the tracked session id from the current request context, and do not replace it with unrelated actions or respond-only output. If the current request context also includes a linked preview-process lease, follow the browser close with stop_process for that same lease so the local preview stack is actually shut down.";
  }
  if (requiredActionType === "open_browser") {
    return repairMode
      ? "Repair must include at least one open_browser action. Reuse the tracked local browser URL from the current request context when it is available."
      : "Current user request explicitly asks to open or reopen a tracked browser window. Include at least one open_browser action, prefer the tracked local browser URL from the current request context, and do not replace it with unrelated actions or respond-only output.";
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
  const localCapabilityGuidance = buildLocalCapabilityGuidance(
    input.currentUserRequest,
    input.executionEnvironment
  );
  const workspaceRecoveryGuidance = buildWorkspaceRecoveryActionPolicyGuidance(
    input.currentUserRequest
  );
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
    "If you emit check_process, include params.leaseId. " +
    "If you emit stop_process, include params.leaseId unless the current recovery context already proved an exact recovered preview-holder pid, in which case params.pid is also allowed. " +
    "If you emit a probe_port action, include params.port and optional params.host/timeoutMs. " +
    "If you emit a probe_http action, include params.url and optional params.expectedStatus/timeoutMs. " +
    "If you emit a verify_browser action, include params.url and optional params.expectedTitle/expectedText/timeoutMs. " +
    "If you emit an open_browser action, include params.url for the local page that should be opened visibly and left open. Include optional params.timeoutMs only when local readiness needs a longer bounded wait. Use loopback http/https URLs for live verification flows, and use absolute file:// URLs only for local static preview flows that do not require localhost proof. " +
    "If you emit a close_browser action, include params.sessionId when a tracked browser session id is available; otherwise include params.url for the tracked local page that should be closed. Close browser supports tracked loopback URLs and tracked local file URLs. " +
    requiredActionHint +
    executionStyleRequiredActionHint +
    executionEnvironmentGuidance +
    buildStrategyGuidance +
    localCapabilityGuidance +
    workspaceRecoveryGuidance +
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
  const localCapabilityGuidance = buildLocalCapabilityGuidance(
    input.currentUserRequest,
    input.executionEnvironment
  );
  const workspaceRecoveryGuidance = buildWorkspaceRecoveryActionPolicyGuidance(
    input.currentUserRequest
  );
  const requiredActionHint = buildRequiredActionHint(input.requiredActionType, true);
  const executionStyleRequiredActionHint =
    buildExecutionStyleRequiredActionHint(input.currentUserRequest, true);
  const repairReasonGuidance = buildPlannerRepairReasonGuidance(input.repairReason);
  return (
    "You are repairing a planner JSON output that had no valid actions. " +
    "Return compact JSON with plannerNotes and actions[]. " +
    "Actions must use only allowed types: respond, read_file, write_file, delete_file, list_directory, create_skill, run_skill, network_write, self_modify, shell_command, start_process, check_process, stop_process, probe_port, probe_http, verify_browser, open_browser, close_browser, stop_folder_runtime_processes, inspect_path_holders, inspect_workspace_resources. " +
    "Always produce at least one valid action. For conversational requests, emit respond with params.message. " +
    RESPONSE_IDENTITY_GUARDRAIL +
    RESPONSE_STYLE_GUARDRAIL +
    "For write_file, include params.path and params.content (the full file content). " +
    "For read_file, include params.path. For shell_command, include params.command. " +
    "For start_process, include params.command and any needed cwd/workdir fields. " +
    "For check_process, include params.leaseId. " +
    "For stop_process, include params.leaseId unless the current recovery context already proved an exact recovered preview-holder pid, in which case params.pid is also allowed. " +
    "For probe_port, include params.port and optional params.host/timeoutMs. " +
    "For probe_http, include params.url and optional params.expectedStatus/timeoutMs. " +
    "For verify_browser, include params.url and optional params.expectedTitle/expectedText/timeoutMs. " +
    "For open_browser, include params.url for the local page that should be opened visibly and left open, and include optional params.timeoutMs only when a longer bounded local wait is required. " +
    "For close_browser, include params.sessionId when a tracked browser session id is available; otherwise include params.url for the tracked local page that should be closed. " +
    "For stop_folder_runtime_processes, include params.rootPath, params.selectorMode, and params.selectorTerm. Use it only for bounded user-owned folder sweeps that stop exact server processes tied to matching folders. " +
    "For inspect_path_holders, include params.path. " +
    "For inspect_workspace_resources, include params.rootPath and any exact known previewUrl/browserSessionId/previewProcessLeaseId values when available. " +
    requiredActionHint +
    executionStyleRequiredActionHint +
    repairReasonGuidance +
    executionEnvironmentGuidance +
    buildStrategyGuidance +
    localCapabilityGuidance +
    workspaceRecoveryGuidance +
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
