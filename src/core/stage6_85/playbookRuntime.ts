/**
 * @fileoverview Canonical Stage 6.85 playbook-runtime helpers for selection, fallback, and registry validation during live planning.
 */

import {
  selectPlaybookDeterministically,
  type PlaybookSelectionDecision
} from "./playbookPolicy";
import { deriveRequestedPlaybookIntent } from "./playbookIntent";
import {
  buildStage685SeedSignals,
  compileStage685SeedPlaybooks
} from "./playbookSeeds";
import {
  DEFAULT_PLAYBOOK_REGISTRY_PATH,
  loadPlaybookRegistryEnvelope,
  validatePlaybookRegistryCoverageAgainstSeeds
} from "./playbookRegistry";

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

/**
 * Converts deterministic fallback data into the stable playbook-planning context shape.
 *
 * @param input - Fallback reason and metadata.
 * @returns Fail-closed playbook-planning context.
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
 * Reduces detailed selection scores into the stable summary used by planner context.
 *
 * @param decision - Deterministic playbook selection decision.
 * @returns Compact score summary for planner diagnostics and evidence.
 */
function buildScoreSummary(
  decision: PlaybookSelectionDecision
): Stage685PlaybookPlanningContext["scoreSummary"] {
  return decision.scores.map((score) => ({
    playbookId: score.playbookId,
    score: score.score
  }));
}

/**
 * Resolves deterministic Stage 6.85 playbook planning context for live planner runs.
 *
 * @param input - User input plus optional time/registry overrides for deterministic tests.
 * @returns Playbook selection context or a fail-closed fallback-to-planner signal.
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
  const registryEnvelope = await loadPlaybookRegistryEnvelope(registryPath);
  if (!registryEnvelope) {
    return toFallbackContext({
      reason: "Playbook registry envelope unavailable or invalid; fallback to normal planning.",
      requestedTags: requestedIntent.requestedTags,
      requiredInputSchema: requestedIntent.requiredInputSchema,
      registryValidated: false
    });
  }

  const registryCoverageValid = validatePlaybookRegistryCoverageAgainstSeeds(
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
    signals: buildStage685SeedSignals(seedPlaybooks),
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
