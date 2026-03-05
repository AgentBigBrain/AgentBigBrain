/**
 * @fileoverview Resolves deterministic Stage 6.85 playbook selection/fallback context for live planner runs.
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { isSchemaEnvelopeV1, verifySchemaEnvelopeV1 } from "./schemaEnvelope";
import {
  compileCandidatePlaybookFromTrace,
  createPlaybookEnvelopeV1,
  PlaybookSelectionDecision,
  PlaybookSelectionSignal,
  selectPlaybookDeterministically
} from "./stage6_85PlaybookPolicy";
import { PlaybookV1, SchemaEnvelopeV1 } from "./types";

const DEFAULT_PLAYBOOK_REGISTRY_PATH = path.resolve(
  process.cwd(),
  "runtime/playbooks/playbook_registry.json"
);

interface PlaybookRegistryEntryV1 {
  playbookId: string;
  version: number;
  hash: string;
}

interface PlaybookRegistryPayloadV1 {
  entries: PlaybookRegistryEntryV1[];
}

export interface Stage685PlaybookPlanningContext {
  selectedPlaybookId: string | null;
  selectedPlaybookName: string | null;
  fallbackToPlanner: boolean;
  reason: string;
  requestedTags: readonly string[];
  requiredInputSchema: string;
  registryValidated: boolean;
  scoreSummary: readonly {
    playbookId: string;
    score: number;
  }[];
}

export interface ResolveStage685PlaybookPlanningInput {
  userInput: string;
  nowIso?: string;
  registryPath?: string;
}

export interface Stage685SeedPlaybookSet {
  build: PlaybookV1;
  research: PlaybookV1;
  all: readonly PlaybookV1[];
}

interface RequestedPlaybookIntent {
  requestedTags: readonly string[];
  requiredInputSchema: string;
}

const CURRENT_USER_REQUEST_MARKER = "Current user request:";
const STRUCTURED_PROMPT_SCAFFOLD_HINTS = [
  "recent conversation context",
  "assistant:",
  "user:",
  "current user request:"
] as const;

/**
 * Normalizes input for playbook matching into a stable shape for `stage6_85PlaybookRuntime` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for input for playbook matching so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param userInput - Structured input object for this operation.
 * @returns Resulting string value.
 */
function normalizeInputForPlaybookMatching(userInput: string): string {
  return userInput.trim().toLowerCase();
}

/**
 * Derives first non empty line from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for first non empty line in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function extractFirstNonEmptyLine(value: string): string {
  const firstLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? "";
}

/**
 * Checks whether structured prompt scaffold contains the required signal.
 *
 * **Why it exists:**
 * Makes structured prompt scaffold containment checks explicit so threshold behavior is easy to audit.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns `true` when this check passes.
 */
function containsStructuredPromptScaffold(value: string): boolean {
  const normalized = value.toLowerCase();
  return STRUCTURED_PROMPT_SCAFFOLD_HINTS.some((hint) => normalized.includes(hint));
}

/**
 * Derives current request for playbook intent from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for current request for playbook intent in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param userInput - Structured input object for this operation.
 * @returns Resulting string value.
 */
function extractCurrentRequestForPlaybookIntent(userInput: string): string {
  const normalized = userInput.trim();
  if (!normalized) {
    return "";
  }

  const markerIndex = normalized
    .toLowerCase()
    .lastIndexOf(CURRENT_USER_REQUEST_MARKER.toLowerCase());
  if (markerIndex < 0) {
    if (containsStructuredPromptScaffold(normalized)) {
      const firstLine = extractFirstNonEmptyLine(normalized);
      return firstLine || normalized;
    }
    return normalized;
  }

  const extracted = normalized
    .slice(markerIndex + CURRENT_USER_REQUEST_MARKER.length)
    .trim();
  return extracted || normalized;
}

/**
 * Evaluates build intent and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the build intent policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param normalizedInput - Structured input object for this operation.
 * @returns `true` when this check passes.
 */
function isBuildIntent(normalizedInput: string): boolean {
  return /\b(build|scaffold|typescript\s+cli|runbook|tests?)\b/.test(normalizedInput);
}

/**
 * Evaluates research intent and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the research intent policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param normalizedInput - Structured input object for this operation.
 * @returns `true` when this check passes.
 */
function isResearchIntent(normalizedInput: string): boolean {
  return (
    /\b(research|findings|proof\s+refs?|sources?)\b/.test(normalizedInput) ||
    /\bsandboxing\s+controls?\b/.test(normalizedInput)
  );
}

/**
 * Evaluates workflow intent and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the workflow intent policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param normalizedInput - Structured input object for this operation.
 * @returns `true` when this check passes.
 */
function isWorkflowIntent(normalizedInput: string): boolean {
  return /\b(workflow|replay|selector\s+drift|browser\s+workflow|capture)\b/.test(normalizedInput);
}

/**
 * Derives requested playbook intent from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for requested playbook intent in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param userInput - Structured input object for this operation.
 * @returns Computed `RequestedPlaybookIntent` result.
 */
function deriveRequestedPlaybookIntent(userInput: string): RequestedPlaybookIntent {
  const currentRequest = extractCurrentRequestForPlaybookIntent(userInput);
  const normalizedInput = normalizeInputForPlaybookMatching(currentRequest);
  const requestedTags = new Set<string>();
  const buildIntent = isBuildIntent(normalizedInput);
  const researchIntent = isResearchIntent(normalizedInput);
  const workflowIntent = isWorkflowIntent(normalizedInput);

  if (buildIntent) {
    requestedTags.add("build");
    requestedTags.add("cli");
    requestedTags.add("verify");
  }
  if (researchIntent) {
    requestedTags.add("research");
    requestedTags.add("security");
  }
  if (workflowIntent) {
    requestedTags.add("workflow");
    requestedTags.add("replay");
    requestedTags.add("computer_use");
  }

  let requiredInputSchema = "unknown_input_schema";
  if (buildIntent && !researchIntent && !workflowIntent) {
    requiredInputSchema = "build_cli_v1";
  } else if (researchIntent && !buildIntent && !workflowIntent) {
    requiredInputSchema = "research_v1";
  } else if (workflowIntent && !buildIntent && !researchIntent) {
    requiredInputSchema = "workflow_replay_v1";
  } else if (buildIntent || researchIntent || workflowIntent) {
    requiredInputSchema = "multi_intent_v1";
  }

  return {
    requestedTags: [...requestedTags].sort((left, right) => left.localeCompare(right)),
    requiredInputSchema
  };
}

/**
 * Compiles stage685 seed playbooks into deterministic output artifacts.
 *
 * **Why it exists:**
 * Centralizes stage685 seed playbooks state-transition logic to keep evolution deterministic and reviewable.
 *
 * **What it talks to:**
 * - Uses `compileCandidatePlaybookFromTrace` (import `compileCandidatePlaybookFromTrace`) from `./stage6_85PlaybookPolicy`.
 * @returns Computed `Stage685SeedPlaybookSet` result.
 */
export function compileStage685SeedPlaybooks(): Stage685SeedPlaybookSet {
  const build = compileCandidatePlaybookFromTrace({
    traceId: "stage685_a_build",
    goal: "Build deterministic backup CLI",
    intentTags: ["build", "cli", "verify"],
    inputSchema: "build_cli_v1",
    steps: [
      {
        actionFamily: "build",
        operation: "compile",
        succeeded: true,
        durationMs: 2_200,
        denyCount: 0,
        verificationPassed: true
      },
      {
        actionFamily: "verification",
        operation: "test",
        succeeded: true,
        durationMs: 4_400,
        denyCount: 0,
        verificationPassed: true
      }
    ]
  });

  const research = compileCandidatePlaybookFromTrace({
    traceId: "stage685_a_research",
    goal: "Research deterministic sandboxing controls",
    intentTags: ["research", "security"],
    inputSchema: "research_v1",
    steps: [
      {
        actionFamily: "research",
        operation: "summarize",
        succeeded: true,
        durationMs: 6_200,
        denyCount: 1,
        verificationPassed: false
      }
    ]
  });

  return {
    build,
    research,
    all: [build, research]
  };
}

/**
 * Builds seed signals for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of seed signals consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `PlaybookSelectionSignal` (import `PlaybookSelectionSignal`) from `./stage6_85PlaybookPolicy`.
 *
 * @param seedPlaybooks - Value for seed playbooks.
 * @returns Ordered collection produced by this step.
 */
function buildSeedSignals(seedPlaybooks: Stage685SeedPlaybookSet): readonly PlaybookSelectionSignal[] {
  return [
    {
      playbookId: seedPlaybooks.build.id,
      passCount: 12,
      failCount: 1,
      lastSuccessAt: "2026-02-27T00:00:00.000Z",
      averageDenyRate: 0.02,
      averageTimeToCompleteMs: 15_000,
      verificationPassRate: 0.98
    },
    {
      playbookId: seedPlaybooks.research.id,
      passCount: 2,
      failCount: 5,
      lastSuccessAt: "2026-01-20T00:00:00.000Z",
      averageDenyRate: 0.35,
      averageTimeToCompleteMs: 80_000,
      verificationPassRate: 0.45
    }
  ];
}

/**
 * Converts values into fallback context form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for fallback context deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `Stage685PlaybookPlanningContext` result.
 */
function toFallbackContext(input: {
  reason: string;
  requestedTags: readonly string[];
  requiredInputSchema: string;
  registryValidated: boolean;
  scoreSummary?: readonly {
    playbookId: string;
    score: number;
  }[];
}): Stage685PlaybookPlanningContext {
  return {
    selectedPlaybookId: null,
    selectedPlaybookName: null,
    fallbackToPlanner: true,
    reason: input.reason,
    requestedTags: input.requestedTags,
    requiredInputSchema: input.requiredInputSchema,
    registryValidated: input.registryValidated,
    scoreSummary: input.scoreSummary ?? []
  };
}

/**
 * Evaluates playbook registry entry v1 and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the playbook registry entry v1 policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is PlaybookRegistryEntryV1` result.
 */
function isPlaybookRegistryEntryV1(value: unknown): value is PlaybookRegistryEntryV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<PlaybookRegistryEntryV1>;
  return (
    typeof candidate.playbookId === "string" &&
    typeof candidate.version === "number" &&
    Number.isFinite(candidate.version) &&
    typeof candidate.hash === "string"
  );
}

/**
 * Evaluates playbook registry payload v1 and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the playbook registry payload v1 policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is PlaybookRegistryPayloadV1` result.
 */
function isPlaybookRegistryPayloadV1(value: unknown): value is PlaybookRegistryPayloadV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<PlaybookRegistryPayloadV1>;
  return Array.isArray(candidate.entries) && candidate.entries.every(isPlaybookRegistryEntryV1);
}

/**
 * Applies deterministic validity checks for registry coverage against seeds.
 *
 * **Why it exists:**
 * Fails fast when registry coverage against seeds is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses `createPlaybookEnvelopeV1` (import `createPlaybookEnvelopeV1`) from `./stage6_85PlaybookPolicy`.
 * - Uses `PlaybookV1` (import `PlaybookV1`) from `./types`.
 *
 * @param registryEntries - Value for registry entries.
 * @param seedPlaybooks - Value for seed playbooks.
 * @returns `true` when this check passes.
 */
function validateRegistryCoverageAgainstSeeds(
  registryEntries: readonly PlaybookRegistryEntryV1[],
  seedPlaybooks: readonly PlaybookV1[]
): boolean {
  const entriesByPlaybookId = new Map(
    registryEntries.map((entry) => [entry.playbookId, entry])
  );

  for (const playbook of seedPlaybooks) {
    const entry = entriesByPlaybookId.get(playbook.id);
    if (!entry) {
      return false;
    }
    const expectedHash = createPlaybookEnvelopeV1(
      playbook,
      "2026-02-27T00:00:00.000Z"
    ).hash;
    if (entry.hash !== expectedHash) {
      return false;
    }
  }

  return true;
}

/**
 * Reads registry envelope needed for this execution step.
 *
 * **Why it exists:**
 * Separates registry envelope read-path handling from orchestration and mutation code.
 *
 * **What it talks to:**
 * - Uses `isSchemaEnvelopeV1` (import `isSchemaEnvelopeV1`) from `./schemaEnvelope`.
 * - Uses `verifySchemaEnvelopeV1` (import `verifySchemaEnvelopeV1`) from `./schemaEnvelope`.
 * - Uses `SchemaEnvelopeV1` (import `SchemaEnvelopeV1`) from `./types`.
 * - Uses `access` (import `access`) from `node:fs/promises`.
 * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
 *
 * @param registryPath - Filesystem location used by this operation.
 * @returns Promise resolving to SchemaEnvelopeV1<PlaybookRegistryPayloadV1> | null.
 */
async function loadRegistryEnvelope(
  registryPath: string
): Promise<SchemaEnvelopeV1<PlaybookRegistryPayloadV1> | null> {
  try {
    await access(registryPath);
  } catch {
    return null;
  }

  const raw = await readFile(registryPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isSchemaEnvelopeV1(parsed) || !verifySchemaEnvelopeV1(parsed)) {
    return null;
  }
  if (parsed.schemaName !== "PlaybookRegistryV1") {
    return null;
  }
  if (!isPlaybookRegistryPayloadV1(parsed.payload)) {
    return null;
  }
  return parsed as SchemaEnvelopeV1<PlaybookRegistryPayloadV1>;
}

/**
 * Builds score summary for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of score summary consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `PlaybookSelectionDecision` (import `PlaybookSelectionDecision`) from `./stage6_85PlaybookPolicy`.
 *
 * @param decision - Value for decision.
 * @returns Computed `Stage685PlaybookPlanningContext["scoreSummary"]` result.
 */
function buildScoreSummary(decision: PlaybookSelectionDecision): Stage685PlaybookPlanningContext["scoreSummary"] {
  return decision.scores.map((score) => ({
    playbookId: score.playbookId,
    score: score.score
  }));
}

/**
 * Resolves stage685 playbook planning context from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of stage685 playbook planning context by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `selectPlaybookDeterministically` (import `selectPlaybookDeterministically`) from `./stage6_85PlaybookPolicy`.
 *
 * @param input - Structured input object for this operation.
 * @returns Promise resolving to Stage685PlaybookPlanningContext.
 */
export async function resolveStage685PlaybookPlanningContext(
  input: ResolveStage685PlaybookPlanningInput
): Promise<Stage685PlaybookPlanningContext> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const registryPath = input.registryPath ?? DEFAULT_PLAYBOOK_REGISTRY_PATH;
  const requestedIntent = deriveRequestedPlaybookIntent(input.userInput);
  if (requestedIntent.requestedTags.length === 0) {
    return toFallbackContext({
      reason: "No deterministic playbook tag match found for this request; fallback to normal planning.",
      requestedTags: requestedIntent.requestedTags,
      requiredInputSchema: requestedIntent.requiredInputSchema,
      registryValidated: false
    });
  }

  const seedPlaybooks = compileStage685SeedPlaybooks();
  const registryEnvelope = await loadRegistryEnvelope(registryPath);
  if (!registryEnvelope) {
    return toFallbackContext({
      reason: "Playbook registry envelope unavailable or invalid; fallback to normal planning.",
      requestedTags: requestedIntent.requestedTags,
      requiredInputSchema: requestedIntent.requiredInputSchema,
      registryValidated: false
    });
  }

  const registryCoverageValid = validateRegistryCoverageAgainstSeeds(
    registryEnvelope.payload.entries,
    seedPlaybooks.all
  );
  if (!registryCoverageValid) {
    return toFallbackContext({
      reason: "Playbook registry hash coverage mismatch; fallback to normal planning.",
      requestedTags: requestedIntent.requestedTags,
      requiredInputSchema: requestedIntent.requiredInputSchema,
      registryValidated: false
    });
  }

  const decision = selectPlaybookDeterministically({
    playbooks: seedPlaybooks.all,
    signals: buildSeedSignals(seedPlaybooks),
    requestedTags: requestedIntent.requestedTags,
    requiredInputSchema: requestedIntent.requiredInputSchema,
    nowIso
  });
  if (!decision.selectedPlaybook || decision.fallbackToPlanner) {
    return toFallbackContext({
      reason: decision.reason,
      requestedTags: requestedIntent.requestedTags,
      requiredInputSchema: requestedIntent.requiredInputSchema,
      registryValidated: true,
      scoreSummary: buildScoreSummary(decision)
    });
  }

  return {
    selectedPlaybookId: decision.selectedPlaybook.id,
    selectedPlaybookName: decision.selectedPlaybook.name,
    fallbackToPlanner: false,
    reason: decision.reason,
    requestedTags: requestedIntent.requestedTags,
    requiredInputSchema: requestedIntent.requiredInputSchema,
    registryValidated: true,
    scoreSummary: buildScoreSummary(decision)
  };
}
