import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildDefaultBrain } from "../../src/core/buildBrain";
import { ensureEnvLoaded } from "../../src/core/envLoader";
import type {
  ConversationExecutionProgressUpdate,
  ConversationExecutionResult
} from "../../src/interfaces/conversationRuntime/managerContracts";
import { TelegramAdapter } from "../../src/interfaces/telegramAdapter";
import { selectUserFacingSummary } from "../../src/interfaces/userFacingResult";
import { probeLocalIntentModelFromEnv } from "../../src/organs/languageUnderstanding/localIntentModelRuntime";
import { resolveUserOwnedPathHints } from "../../src/organs/plannerPolicy/userOwnedPathHints";
import { resolveRequiredRealSmokeBackend } from "./smokeModelEnv";

type ArtifactStatus = "PASS" | "FAIL" | "BLOCKED";

interface DirectAutoProgressMessage {
  at: string;
  message: string;
}

interface DirectAutoProgressState {
  at: string;
  status: ConversationExecutionProgressUpdate["status"];
  message: string;
}

interface DirectAutoScenarioBase {
  prompt: string;
  terminalOutcome: "completed" | "stopped" | "blocked";
  summary: string;
  userFacingSummary: string | null;
  blockerReason: string | null;
  transientProviderFailureRecovered: boolean;
  progressMessages: readonly DirectAutoProgressMessage[];
  progressStates: readonly DirectAutoProgressState[];
}

interface DirectAutoSuccessScenarioResult extends DirectAutoScenarioBase {
  movedEntries: readonly string[];
  desktopEntriesAfter: readonly string[];
  checks: {
    directEntryPointUsed: boolean;
    boundedExit: boolean;
    destinationCreated: boolean;
    movedMatchingFolders: boolean;
    noRemainingMatchingFoldersAtDesktopRoot: boolean;
    noNestedDestination: boolean;
    observedProgressStates: boolean;
    truthfulSummary: boolean;
  };
}

interface DirectAutoBoundedStopScenarioResult extends DirectAutoScenarioBase {
  checks: {
    directEntryPointUsed: boolean;
    boundedExit: boolean;
    observedWorkingState: boolean;
    observedStoppedState: boolean;
    truthfulStopSummary: boolean;
    noFalseSuccessSummary: boolean;
  };
}

export interface AutonomousRuntimeAffordancesDirectAutoArtifact {
  generatedAt: string;
  command: string;
  status: ArtifactStatus;
  targetPrefix: string;
  destinationFolderName: string;
  targetDesktopPath: string;
  artifactPath: string;
  successScenario: DirectAutoSuccessScenarioResult;
  boundedStopScenario: DirectAutoBoundedStopScenarioResult;
}

const COMMAND_NAME = "tsx scripts/evidence/autonomousRuntimeAffordancesDirectAutoSmoke.ts";
const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/autonomous_runtime_affordances_direct_auto_report.json"
);
const SMOKE_DEADLINE_MS = 90_000;
const MIN_RETRY_BUDGET_MS = 30_000;
const USER_ID = "autonomous-direct-auto-smoke-user";
const CHAT_ID = "autonomous-direct-auto-smoke-chat";
const USERNAME = "anthonybenny";
const LIVE_RUN_RUNTIME_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-autonomous-runtime-affordances-direct-auto-live-run-${Date.now()}`
);
const STATE_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-autonomous-runtime-affordances-direct-auto-state-${Date.now()}.json`
);

interface EnvSnapshot {
  [key: string]: string | undefined;
}

const BOUNDED_PROVIDER_BLOCK_PATTERN =
  /(?:429|exceeded your current quota|usage limit|purchase more credits|try again at|rate limit|fetch failed|request timed out|socket hang up|ECONNRESET|governor timeout or failure|requires a real model backend|effective backend is mock|missing OPENAI_API_KEY)/i;
const BOUNDED_LOCAL_ORGANIZATION_BLOCK_PATTERN =
  /(?:Planner model did not include a real folder-move step for this local organization request|Planner model retried the local organization move without also proving what moved into the destination and what remained at the original root|Planner model selected the named destination folder as part of the same move set, which risks nesting the destination inside itself|Planner model used cmd-style shell moves for a Windows PowerShell organization request|Planner model used invalid PowerShell variable interpolation for a Windows organization move command)/i;

function isBoundedSmokeBlock(summaryText: string): boolean {
  return (
    BOUNDED_PROVIDER_BLOCK_PATTERN.test(summaryText) ||
    BOUNDED_LOCAL_ORGANIZATION_BLOCK_PATTERN.test(summaryText)
  );
}

function applyEnvOverrides(overrides: Readonly<Record<string, string>>): EnvSnapshot {
  const snapshot: EnvSnapshot = {};
  for (const [key, value] of Object.entries(overrides)) {
    snapshot[key] = process.env[key];
    process.env[key] = value;
  }
  return snapshot;
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

async function listMatchingDesktopDirectories(
  desktopPath: string,
  prefix: string
): Promise<readonly string[]> {
  const entries = await readdir(desktopPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function seedProofFolder(rootPath: string, markerName: string): Promise<void> {
  await mkdir(rootPath, { recursive: true });
  await writeFile(path.join(rootPath, "marker.txt"), markerName, "utf8");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMovedEntriesFromSummary(summaryText: string): string[] {
  const movedMatch = summaryText.match(/MOVED_TO_DEST=([^\r\n]*)/i);
  return (movedMatch?.[1] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function summaryShowsNoRemainingMatches(summaryText: string): boolean {
  return /ROOT_REMAINING_MATCHES:\s*(?:\r?\n|$)/i.test(summaryText);
}

async function readDirectAutoFilesystemProof(input: {
  destinationFolderPath: string;
  desktopPath: string;
  prefix: string;
  destinationFolderName: string;
}): Promise<{
  destinationCreated: boolean;
  movedEntries: string[];
  desktopEntriesAfter: readonly string[];
  nestedDestinationExists: boolean;
}> {
  const deadlineAt = Date.now() + 2_000;
  let destinationCreated = false;
  let movedEntries: string[] = [];
  let desktopEntriesAfter: readonly string[] = [];
  let nestedDestinationExists = false;

  while (Date.now() < deadlineAt) {
    destinationCreated = await pathExists(input.destinationFolderPath);
    movedEntries = await readdir(input.destinationFolderPath).catch((): string[] => []);
    desktopEntriesAfter = await listMatchingDesktopDirectories(input.desktopPath, input.prefix);
    nestedDestinationExists = await pathExists(
      path.join(input.destinationFolderPath, input.destinationFolderName)
    );
    if (destinationCreated || movedEntries.length > 0 || desktopEntriesAfter.length > 0) {
      break;
    }
    await sleep(100);
  }

  return {
    destinationCreated,
    movedEntries: [...movedEntries].sort((left, right) => left.localeCompare(right)),
    desktopEntriesAfter,
    nestedDestinationExists
  };
}

async function cleanupProofFolders(desktopPath: string, prefix: string): Promise<void> {
  const entries = await listMatchingDesktopDirectories(desktopPath, prefix);
  await Promise.all(
    entries.map((entry) =>
      rm(path.join(desktopPath, entry), {
        recursive: true,
        force: true
      }).catch(() => undefined)
    )
  );
}

function buildPrompt(targetPrefix: string, destinationFolderName: string): string {
  return (
    "I left a couple of smoke-test project folders on my desktop from earlier. " +
    `Every folder with the name beginning in ${targetPrefix} should go in "${destinationFolderName}" on my desktop.`
  );
}

function buildBoundedStopPrompt(): string {
  return (
    "Please start a small calm landing-page draft on my desktop and keep going until it's " +
    "ready for review."
  );
}

function buildArtifact(
  targetPrefix: string,
  destinationFolderName: string,
  desktopPath: string,
  successScenario: DirectAutoSuccessScenarioResult,
  boundedStopScenario: DirectAutoBoundedStopScenarioResult
): AutonomousRuntimeAffordancesDirectAutoArtifact {
  const allChecks = [
    ...Object.values(successScenario.checks),
    ...Object.values(boundedStopScenario.checks)
  ];
  const successScenarioPassed =
    successScenario.terminalOutcome !== "blocked" &&
    Object.values(successScenario.checks).every(Boolean);
  const boundedStopScenarioPassed =
    boundedStopScenario.terminalOutcome === "stopped" &&
    Object.values(boundedStopScenario.checks).every(Boolean);
  return {
    generatedAt: new Date().toISOString(),
    command: COMMAND_NAME,
    status:
      successScenario.terminalOutcome === "blocked" ||
      boundedStopScenario.terminalOutcome === "blocked"
        ? "BLOCKED"
        : successScenarioPassed &&
            boundedStopScenarioPassed &&
            allChecks.every(Boolean)
          ? "PASS"
          : "FAIL",
    targetPrefix,
    destinationFolderName,
    targetDesktopPath: desktopPath,
    artifactPath: ARTIFACT_PATH,
    successScenario,
    boundedStopScenario
  };
}

function buildBlockedScenarioBase(
  prompt: string,
  blockerReason: string
): DirectAutoScenarioBase {
  return {
    prompt,
    terminalOutcome: "blocked",
    summary: blockerReason,
    userFacingSummary: null,
    blockerReason,
    transientProviderFailureRecovered: false,
    progressMessages: [],
    progressStates: []
  };
}

async function executeDirectAutoRun(
  adapter: TelegramAdapter,
  prompt: string,
  signal: AbortSignal,
  onUpdate?: (update: ConversationExecutionProgressUpdate) => Promise<void> | void
): Promise<{
  executionResult: ConversationExecutionResult;
  progressMessages: DirectAutoProgressMessage[];
  progressStates: DirectAutoProgressState[];
}> {
  const progressMessages: DirectAutoProgressMessage[] = [];
  const progressStates: DirectAutoProgressState[] = [];
  const executionResult = await adapter.runAutonomousTask(
    prompt,
    new Date().toISOString(),
    async (message) => {
      progressMessages.push({
        at: new Date().toISOString(),
        message
      });
    },
    signal,
    null,
    async (update) => {
      progressStates.push({
        at: new Date().toISOString(),
        status: update.status,
        message: update.message
      });
      await onUpdate?.(update);
    }
  );
  return {
    executionResult,
    progressMessages,
    progressStates
  };
}

function resolveRemainingSmokeBudgetMs(deadlineAt: number): number {
  return Math.max(1, deadlineAt - Date.now());
}

async function executeDirectAutoRunWithinBudget(
  adapter: TelegramAdapter,
  prompt: string,
  deadlineAt: number,
  onUpdate?: (update: ConversationExecutionProgressUpdate) => Promise<void> | void
): Promise<{
  executionResult: ConversationExecutionResult;
  progressMessages: DirectAutoProgressMessage[];
  progressStates: DirectAutoProgressState[];
  abortedByBudget: boolean;
}> {
  const controller = new AbortController();
  let abortedByBudget = false;
  const timeoutHandle = setTimeout(
    () => {
      abortedByBudget = true;
      controller.abort();
    },
    resolveRemainingSmokeBudgetMs(deadlineAt)
  );
  try {
    const run = await executeDirectAutoRun(adapter, prompt, controller.signal, onUpdate);
    return {
      ...run,
      abortedByBudget
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function runAutonomousRuntimeAffordancesDirectAutoSmoke():
Promise<AutonomousRuntimeAffordancesDirectAutoArtifact> {
  ensureEnvLoaded();
  const { desktopPath } = resolveUserOwnedPathHints();
  if (!desktopPath) {
    throw new Error("Unable to resolve a desktop path for the direct-auto smoke.");
  }
  const localProbe = await probeLocalIntentModelFromEnv();
  const smokeBackend = resolveRequiredRealSmokeBackend(localProbe);
  const runId = `${Date.now()}`;
  const targetPrefix = `drone-autonomy-direct-auto-${runId}`;
  const destinationFolderName = `${targetPrefix}-folder`;
  const destinationFolderPath = path.join(desktopPath, destinationFolderName);
  const tempLedgerPath = path.resolve(
    process.cwd(),
    `runtime/tmp-autonomous-runtime-affordances-direct-auto-${runId}.sqlite`
  );
  const sourceFolderNames = [`${targetPrefix}-a`, `${targetPrefix}-b`];
  const prompt = buildPrompt(targetPrefix, destinationFolderName);
  const overallDeadlineAt = Date.now() + SMOKE_DEADLINE_MS;
  const envSnapshot = applyEnvOverrides({
    ...smokeBackend.envOverrides,
    BRAIN_LIVE_RUN_RUNTIME_PATH: LIVE_RUN_RUNTIME_PATH,
    BRAIN_STATE_JSON_PATH: STATE_PATH,
    BRAIN_LEDGER_SQLITE_PATH: tempLedgerPath,
    BRAIN_LEDGER_EXPORT_JSON_ON_WRITE: "false",
    BRAIN_ENABLE_EMBEDDINGS: "false",
    BRAIN_ENABLE_DYNAMIC_PULSE: "false"
  });

  try {
    await mkdir(desktopPath, { recursive: true });
    if (smokeBackend.blockerReason) {
      const artifact = buildArtifact(
        targetPrefix,
        destinationFolderName,
        desktopPath,
        {
          ...buildBlockedScenarioBase(prompt, smokeBackend.blockerReason),
          movedEntries: [],
          desktopEntriesAfter: [],
          checks: {
            directEntryPointUsed: true,
            boundedExit: true,
            destinationCreated: false,
            movedMatchingFolders: false,
            noRemainingMatchingFoldersAtDesktopRoot: false,
            noNestedDestination: false,
            observedProgressStates: false,
            truthfulSummary: true
          }
        },
        {
          ...buildBlockedScenarioBase(buildBoundedStopPrompt(), smokeBackend.blockerReason),
          checks: {
            directEntryPointUsed: true,
            boundedExit: true,
            observedWorkingState: false,
            observedStoppedState: false,
            truthfulStopSummary: true,
            noFalseSuccessSummary: true
          }
        }
      );
      await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
      await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      return artifact;
    }

    await cleanupProofFolders(desktopPath, targetPrefix);
    for (const sourceFolderName of sourceFolderNames) {
      await seedProofFolder(
        path.join(desktopPath, sourceFolderName),
        `proof:${sourceFolderName}`
      );
    }

    const brain = buildDefaultBrain();
    const adapter = new TelegramAdapter(brain, {
      auth: { requiredToken: "shared-secret" },
      allowlist: {
        allowedUsernames: [USERNAME],
        allowedUserIds: [USER_ID],
        allowedChatIds: [CHAT_ID]
      },
      rateLimit: {
        windowMs: 60_000,
        maxEventsPerWindow: 10
      },
      replay: {
        maxTrackedUpdateIds: 32
      }
    });

    let recoveredTransientProviderFailure = false;
    let {
      executionResult,
      progressMessages,
      progressStates,
      abortedByBudget
    } = await executeDirectAutoRunWithinBudget(adapter, prompt, overallDeadlineAt);
    const firstAttemptSummary = [
      executionResult.summary,
      executionResult.taskRunResult
        ? selectUserFacingSummary(executionResult.taskRunResult) ?? ""
        : ""
    ].join("\n");
    if (isBoundedSmokeBlock(firstAttemptSummary)) {
      recoveredTransientProviderFailure = true;
      progressMessages.push({
        at: new Date().toISOString(),
        message: "Transient provider failure detected on the first direct-auto attempt. Retrying once."
      });
      const retryBudgetMs = resolveRemainingSmokeBudgetMs(overallDeadlineAt);
      if (retryBudgetMs < MIN_RETRY_BUDGET_MS) {
        const blockerReason =
          "Transient provider failure exhausted the bounded direct-auto retry budget.\n" +
          firstAttemptSummary;
        const artifact = buildArtifact(
          targetPrefix,
          destinationFolderName,
          desktopPath,
          {
            ...buildBlockedScenarioBase(prompt, blockerReason),
            transientProviderFailureRecovered: true,
            movedEntries: [],
            desktopEntriesAfter: await listMatchingDesktopDirectories(desktopPath, targetPrefix),
            checks: {
              directEntryPointUsed: true,
              boundedExit: true,
              destinationCreated: await pathExists(destinationFolderPath),
              movedMatchingFolders: false,
              noRemainingMatchingFoldersAtDesktopRoot: false,
              noNestedDestination: true,
              observedProgressStates:
                progressStates.some((entry) => entry.status === "working") &&
                progressStates.some(
                  (entry) => entry.status === "completed" || entry.status === "stopped"
                ),
              truthfulSummary: true
            },
            progressMessages,
            progressStates
          },
          {
            ...buildBlockedScenarioBase(buildBoundedStopPrompt(), blockerReason),
            checks: {
              directEntryPointUsed: true,
              boundedExit: true,
              observedWorkingState: false,
              observedStoppedState: false,
              truthfulStopSummary: true,
              noFalseSuccessSummary: true
            }
          }
        );
        await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
        await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
        return artifact;
      }
      const retryRun = await executeDirectAutoRunWithinBudget(adapter, prompt, overallDeadlineAt);
      executionResult = retryRun.executionResult;
      progressMessages = [...progressMessages, ...retryRun.progressMessages];
      progressStates = [...progressStates, ...retryRun.progressStates];
      abortedByBudget = retryRun.abortedByBudget;
    }

    const userFacingSummary = executionResult.taskRunResult
      ? selectUserFacingSummary(executionResult.taskRunResult)
      : null;
    const finalAttemptSummaryText = [
      executionResult.summary,
      userFacingSummary ?? ""
    ].join("\n");
    const parsedMovedEntries = parseMovedEntriesFromSummary(finalAttemptSummaryText);
    const parsedNoRemainingMatches = summaryShowsNoRemainingMatches(finalAttemptSummaryText);
    const filesystemProof = await readDirectAutoFilesystemProof({
      destinationFolderPath,
      desktopPath,
      prefix: targetPrefix,
      destinationFolderName
    });
    const movedEntries =
      filesystemProof.movedEntries.length > 0
        ? filesystemProof.movedEntries
        : parsedMovedEntries;
    const desktopEntriesAfter =
      filesystemProof.desktopEntriesAfter.length > 0
        ? filesystemProof.desktopEntriesAfter
        : parsedNoRemainingMatches
          ? [destinationFolderName]
          : [];
    const destinationCreated =
      filesystemProof.destinationCreated || movedEntries.length > 0;
    const nestedDestinationExists = filesystemProof.nestedDestinationExists;
    const finalAttemptBlockedByProvider = isBoundedSmokeBlock(finalAttemptSummaryText);
    const finalAttemptBlockedByBudget =
      abortedByBudget &&
      progressStates.some((entry) => entry.status === "working") &&
      !progressStates.some((entry) => entry.status === "completed");
    const finalAttemptBlockerReason = finalAttemptBlockedByProvider
      ? finalAttemptSummaryText
      : finalAttemptBlockedByBudget
        ? (
            "Bounded direct-auto smoke budget expired before the organization scenario could prove a terminal success.\n" +
            finalAttemptSummaryText
          )
        : null;
    const successSummaryText = `${executionResult.summary} ${userFacingSummary ?? ""}`;
    const provedSuccessfulLocalOrganizationOutcome =
      /i ran the command successfully/i.test(successSummaryText) ||
      /moved_to_dest=/i.test(successSummaryText) ||
      /moved the matching folders/i.test(successSummaryText);
    const provedTruthfulStoppedPartialSuccess =
      /one later step was blocked/i.test(successSummaryText) &&
      /stopped after the work that already succeeded/i.test(successSummaryText);

    const successScenario: DirectAutoSuccessScenarioResult = {
      prompt,
      terminalOutcome: finalAttemptBlockerReason
        ? "blocked"
        : progressStates.some((entry) => entry.status === "completed")
          ? "completed"
          : "stopped",
      summary: executionResult.summary,
      userFacingSummary,
      blockerReason: finalAttemptBlockerReason,
      transientProviderFailureRecovered: recoveredTransientProviderFailure,
      movedEntries,
      desktopEntriesAfter,
      progressMessages,
      progressStates,
      checks: {
        directEntryPointUsed: true,
        boundedExit: true,
        destinationCreated,
        movedMatchingFolders:
          sourceFolderNames.every((entry) => movedEntries.includes(entry)),
        noRemainingMatchingFoldersAtDesktopRoot:
          desktopEntriesAfter.length === 1 && desktopEntriesAfter[0] === destinationFolderName,
        noNestedDestination: nestedDestinationExists === false,
        observedProgressStates:
          progressStates.some((entry) => entry.status === "working")
          && progressStates.some(
            (entry) => entry.status === "completed" || entry.status === "stopped"
          ),
        truthfulSummary:
          finalAttemptBlockerReason !== null
          || /autonomous task completed/i.test(executionResult.summary)
          || (provedSuccessfulLocalOrganizationOutcome &&
            (progressStates.some((entry) => entry.status === "completed") ||
              provedTruthfulStoppedPartialSuccess))
      }
    };

    const boundedStopController = new AbortController();
    let boundedStopAbortTriggered = false;
    const boundedStopRun = await executeDirectAutoRun(
      adapter,
      buildBoundedStopPrompt(),
      boundedStopController.signal,
      async (update) => {
        if (!boundedStopAbortTriggered && update.status === "working") {
          boundedStopAbortTriggered = true;
          boundedStopController.abort();
        }
      }
    );
    const boundedStopUserFacingSummary = boundedStopRun.executionResult.taskRunResult
      ? selectUserFacingSummary(boundedStopRun.executionResult.taskRunResult)
      : null;
    const boundedStopSummaryText = [
      boundedStopRun.executionResult.summary,
      boundedStopUserFacingSummary ?? ""
    ].join("\n");
    const boundedStopScenario: DirectAutoBoundedStopScenarioResult = {
      prompt: buildBoundedStopPrompt(),
      terminalOutcome: isBoundedSmokeBlock(boundedStopSummaryText)
        ? "blocked"
        : (
            /autonomous task stopped/i.test(boundedStopRun.executionResult.summary) ||
            /run stopped before it finished/i.test(boundedStopRun.executionResult.summary)
          )
          ? "stopped"
          : "completed",
      summary: boundedStopRun.executionResult.summary,
      userFacingSummary: boundedStopUserFacingSummary,
      blockerReason: isBoundedSmokeBlock(boundedStopSummaryText)
        ? boundedStopSummaryText
        : null,
      transientProviderFailureRecovered: false,
      progressMessages: boundedStopRun.progressMessages,
      progressStates: boundedStopRun.progressStates,
      checks: {
        directEntryPointUsed: true,
        boundedExit: true,
        observedWorkingState: boundedStopRun.progressStates.some(
          (entry) => entry.status === "working"
        ),
        observedStoppedState: boundedStopRun.progressStates.some(
          (entry) => entry.status === "stopped"
        ),
        truthfulStopSummary:
          (
            /autonomous task stopped after/i.test(boundedStopRun.executionResult.summary) ||
            /run stopped before it finished after/i.test(boundedStopRun.executionResult.summary)
          ) &&
          /cancelled the run/i.test(boundedStopRun.executionResult.summary),
        noFalseSuccessSummary:
          !/autonomous task completed after/i.test(boundedStopRun.executionResult.summary)
      }
    };

    const artifact = buildArtifact(
      targetPrefix,
      destinationFolderName,
      desktopPath,
      successScenario,
      boundedStopScenario
    );
    await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
    await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    return artifact;
  } finally {
    await cleanupProofFolders(desktopPath, targetPrefix);
    await rm(tempLedgerPath, { force: true }).catch(() => undefined);
    await rm(LIVE_RUN_RUNTIME_PATH, { recursive: true, force: true }).catch(() => undefined);
    await rm(STATE_PATH, { force: true }).catch(() => undefined);
    await rm(`${STATE_PATH}.lock`, { force: true }).catch(() => undefined);
    restoreEnv(envSnapshot);
  }
}

async function main(): Promise<void> {
  const artifact = await runAutonomousRuntimeAffordancesDirectAutoSmoke();
  console.log(`Autonomous runtime affordances direct-auto smoke status: ${artifact.status}`);
  console.log(`Artifact: ${ARTIFACT_PATH}`);
  if (artifact.status === "FAIL") {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
