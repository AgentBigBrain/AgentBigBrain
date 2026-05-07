/**
 * @fileoverview Synthetic multi-day evidence matrix for Dynamic Pulse semantic inquiry behavior.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildProactiveInquiryCandidateFromPulseCandidate,
  normalizeProactiveInquiryCandidate,
  type ProactiveInquiryCandidate,
  type ProactiveInquiryEvidenceBlockReason,
  type ProactiveInquirySourceRecallStatus,
  type ProactiveInquiryType
} from "../../src/core/stage6_86/proactiveInquiryCandidates";
import type { PulseEmissionRecordV1 } from "../../src/core/stage6_86PulseCandidates";
import type { PulseCandidateV1, PulseReasonCodeV1 } from "../../src/core/types";
import {
  evaluateProactiveInquiryDeliveryPolicy,
  type ProactiveInquirySuppressionReason
} from "../../src/interfaces/proactiveRuntime/deliveryPolicy";

export const DYNAMIC_PULSE_SEMANTIC_INQUIRY_FIXTURE_PATH =
  "tests/fixtures/dynamicPulseSemanticInquiryScenarios.json";
export const DYNAMIC_PULSE_SEMANTIC_INQUIRY_ARTIFACT_PATH =
  "runtime/evidence/dynamic_pulse/dynamic_pulse_semantic_inquiry_matrix.json";

const TOKEN_SHAPED_SECRET_PATTERN =
  /(ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|\b[0-9]{8,10}:[A-Za-z0-9_-]{35,}\b)/;
const LOCAL_DESKTOP_PATH_PATTERN = /C:\\Users\\|\/home\/runner\/work\/AgentBigBrain\/AgentBigBrain/i;

export type DynamicPulseEvidenceMode =
  | "schema_only"
  | "mocked_provider"
  | "runtime_observed"
  | "source_recall_retrieval"
  | "deterministic_suppression"
  | "live_dependency_blocked";

export type DynamicPulseProofCategory =
  | "candidate_generation"
  | "deterministic_suppression"
  | "outcome_learning"
  | "source_recall_retrieval"
  | "schema_validation"
  | "blocked_dependency";

export type DynamicPulseMatrixSuppressionReason =
  | ProactiveInquirySuppressionReason
  | "agent_pulse_disabled"
  | "dynamic_pulse_disabled"
  | "user_not_opted_in"
  | "quiet_hours"
  | "cooldown"
  | "daily_cap"
  | "pulse_muted"
  | "model_unavailable"
  | "malformed_model_candidate"
  | "low_confidence_model_candidate"
  | "source_recall_disabled"
  | "source_recall_blocked"
  | "source_recall_unavailable";

interface DynamicPulseScenarioControls {
  agentPulseEnabled: boolean;
  dynamicPulseEnabled: boolean;
  optedIn: boolean;
  quietHours?: boolean;
  cooldown?: boolean;
  dailyCap?: boolean;
  exactPulseOff?: boolean;
  modelUnavailable?: boolean;
  malformedModelCandidate?: boolean;
  lowConfidenceModelCandidate?: boolean;
}

export interface DynamicPulseSemanticInquiryScenario {
  id: string;
  day: number;
  description: string;
  evidenceMode: DynamicPulseEvidenceMode;
  proofCategory: DynamicPulseProofCategory;
  reasonCode: PulseReasonCodeV1;
  targetMode: "private" | "public";
  sourceRecallStatus: ProactiveInquirySourceRecallStatus;
  requiresSourceRecall?: boolean;
  sourceRecallRefs?: readonly string[];
  sourceRecallBlockReasons?: readonly ProactiveInquiryEvidenceBlockReason[];
  expectedUserValue: number;
  novelty: number;
  privacyRisk: "none" | "private_only" | "sensitive" | "blocked";
  publicSafe: boolean;
  activeMissionSafe: boolean;
  recentOutcomePattern?: "ignored" | "dismissed" | "negative" | "muted" | "engaged";
  outcomeFeedback?: "useful" | "ignored" | "dismissed" | "negative" | "muted";
  controls: DynamicPulseScenarioControls;
  expected: {
    candidateProposed: boolean;
    messageEmitted: boolean;
    suppressionReason: DynamicPulseMatrixSuppressionReason | null;
  };
}

export interface DynamicPulseSemanticInquiryScenarioResult {
  id: string;
  day: number;
  status: "PASS" | "FAIL";
  evidenceMode: DynamicPulseEvidenceMode;
  candidateProposed: boolean;
  candidateType: ProactiveInquiryType | null;
  sourceRecallStatus: ProactiveInquirySourceRecallStatus;
  deliveryDecision: "emitted" | "suppressed";
  suppressionReason: DynamicPulseMatrixSuppressionReason | null;
  messageEmitted: boolean;
  authorityFlags: {
    outreachAuthority: false;
    memoryWriteAuthority: false;
    truthAuthority: false;
    approvalAuthority: false;
    deliveryPermission: false;
  };
  outcomeLearningEffect:
    | "none"
    | "boosted_similar_useful_candidate"
    | "suppressed_repeated_ignored"
    | "suppressed_repeated_dismissed"
    | "suppressed_repeated_negative"
    | "suppressed_repeated_muted"
    | "muted_by_user";
  proofCategory: DynamicPulseProofCategory;
  liveDependencyStatus: "NOT_REQUIRED" | "BLOCKED";
  failureReasons: string[];
}

export interface DynamicPulseSemanticInquiryMatrix {
  generatedAt: string;
  artifactKind: "dynamic_pulse_semantic_inquiry_matrix";
  summary: {
    total: number;
    passed: number;
    failed: number;
    emissions: number;
    suppressions: number;
    suppressionsPerEmission: number;
    suppressionBalancePass: boolean;
  };
  artifactPrivacyProof: {
    localDesktopPathPresentInArtifact: boolean;
    tokenShapedSecretPresentInArtifact: boolean;
  };
  topLevelStatus: {
    status: "PASS" | "FAIL";
    failureReasons: readonly string[];
  };
  results: DynamicPulseSemanticInquiryScenarioResult[];
}

/**
 * Loads Dynamic Pulse semantic inquiry scenarios from the fixture file.
 *
 * @param fixturePath - Fixture path.
 * @returns Parsed scenarios.
 */
export async function loadDynamicPulseSemanticInquiryScenarios(
  fixturePath = DYNAMIC_PULSE_SEMANTIC_INQUIRY_FIXTURE_PATH
): Promise<DynamicPulseSemanticInquiryScenario[]> {
  const raw = await readFile(fixturePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Dynamic Pulse semantic inquiry fixture must be an array.");
  }
  return parsed.map(parseScenario);
}

/**
 * Runs the Dynamic Pulse semantic inquiry evidence matrix.
 *
 * @param scenarios - Scenarios to execute.
 * @returns Evidence matrix.
 */
export async function runDynamicPulseSemanticInquiryMatrix(
  scenarios: readonly DynamicPulseSemanticInquiryScenario[]
): Promise<DynamicPulseSemanticInquiryMatrix> {
  const results = scenarios.map(runScenario);
  const passed = results.filter((result) => result.status === "PASS").length;
  const emissions = results.filter((result) => result.messageEmitted).length;
  const suppressions = results.length - emissions;
  const suppressionBalancePass = suppressions >= emissions;
  const matrixWithoutPrivacy: Omit<
    DynamicPulseSemanticInquiryMatrix,
    "artifactPrivacyProof" | "topLevelStatus"
  > = {
    generatedAt: new Date().toISOString(),
    artifactKind: "dynamic_pulse_semantic_inquiry_matrix",
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      emissions,
      suppressions,
      suppressionsPerEmission: emissions > 0 ? Number((suppressions / emissions).toFixed(4)) : suppressions,
      suppressionBalancePass
    },
    results
  };
  const artifactPrivacyProof = buildArtifactPrivacyProof(matrixWithoutPrivacy);
  const topLevelFailures = buildTopLevelFailureReasons({
    results,
    summary: matrixWithoutPrivacy.summary,
    artifactPrivacyProof
  });
  return {
    ...matrixWithoutPrivacy,
    artifactPrivacyProof,
    topLevelStatus: {
      status: topLevelFailures.length === 0 ? "PASS" : "FAIL",
      failureReasons: topLevelFailures
    }
  };
}

/**
 * Writes the Dynamic Pulse semantic inquiry matrix artifact.
 *
 * @param matrix - Matrix to write.
 * @param artifactPath - Output artifact path.
 */
export async function writeDynamicPulseSemanticInquiryMatrix(
  matrix: DynamicPulseSemanticInquiryMatrix,
  artifactPath = DYNAMIC_PULSE_SEMANTIC_INQUIRY_ARTIFACT_PATH
): Promise<void> {
  const resolved = path.resolve(process.cwd(), artifactPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
}

/**
 * Parses one raw fixture scenario into the bounded matrix contract.
 *
 * @param raw - Raw scenario object.
 * @returns Parsed scenario.
 */
function parseScenario(raw: unknown): DynamicPulseSemanticInquiryScenario {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Dynamic Pulse scenario must be an object.");
  }
  const record = raw as DynamicPulseSemanticInquiryScenario;
  if (
    typeof record.id !== "string" ||
    typeof record.day !== "number" ||
    typeof record.description !== "string" ||
    typeof record.reasonCode !== "string" ||
    !record.controls ||
    typeof record.controls !== "object" ||
    !record.expected ||
    typeof record.expected !== "object"
  ) {
    throw new Error("Dynamic Pulse scenario is missing required fields.");
  }
  return record;
}

/**
 * Runs one matrix scenario against candidate and delivery-policy runtime helpers.
 *
 * @param scenario - Scenario to execute.
 * @returns Scenario result.
 */
function runScenario(
  scenario: DynamicPulseSemanticInquiryScenario
): DynamicPulseSemanticInquiryScenarioResult {
  const preSuppressionReason = resolvePreCandidateSuppressionReason(scenario);
  const candidate = preSuppressionReason ? null : buildScenarioCandidate(scenario);
  const policyDecision = candidate
    ? evaluateProactiveInquiryDeliveryPolicy({
        candidate,
        targetMode: scenario.targetMode,
        recentPulseHistory: buildRecentPulseHistory(candidate, scenario)
      })
    : null;
  const policySuppression = policyDecision && !policyDecision.allowed
    ? policyDecision.suppressedBy[0] ?? null
    : null;
  const suppressionReason = preSuppressionReason ?? policySuppression;
  const messageEmitted = Boolean(candidate && !suppressionReason && policyDecision?.allowed);
  const failureReasons = buildScenarioFailureReasons({
    scenario,
    candidate,
    messageEmitted,
    suppressionReason
  });

  return {
    id: scenario.id,
    day: scenario.day,
    status: failureReasons.length === 0 ? "PASS" : "FAIL",
    evidenceMode: scenario.evidenceMode,
    candidateProposed: Boolean(candidate),
    candidateType: candidate?.inquiryType ?? null,
    sourceRecallStatus: scenario.sourceRecallStatus,
    deliveryDecision: messageEmitted ? "emitted" : "suppressed",
    suppressionReason,
    messageEmitted,
    authorityFlags: candidate?.authority ?? {
      outreachAuthority: false,
      memoryWriteAuthority: false,
      truthAuthority: false,
      approvalAuthority: false,
      deliveryPermission: false
    },
    outcomeLearningEffect: resolveOutcomeLearningEffect(scenario, suppressionReason),
    proofCategory: scenario.proofCategory,
    liveDependencyStatus: scenario.evidenceMode === "live_dependency_blocked" ? "BLOCKED" : "NOT_REQUIRED",
    failureReasons
  };
}

/**
 * Resolves pre-candidate deterministic suppression for controls and unavailable dependencies.
 *
 * @param scenario - Scenario controls and dependency state.
 * @returns Suppression reason, or `null` when candidate generation may proceed.
 */
function resolvePreCandidateSuppressionReason(
  scenario: DynamicPulseSemanticInquiryScenario
): DynamicPulseMatrixSuppressionReason | null {
  if (!scenario.controls.agentPulseEnabled) return "agent_pulse_disabled";
  if (!scenario.controls.dynamicPulseEnabled) return "dynamic_pulse_disabled";
  if (!scenario.controls.optedIn) return "user_not_opted_in";
  if (scenario.controls.quietHours === true) return "quiet_hours";
  if (scenario.controls.cooldown === true) return "cooldown";
  if (scenario.controls.dailyCap === true) return "daily_cap";
  if (scenario.controls.exactPulseOff === true) return "pulse_muted";
  if (scenario.controls.modelUnavailable === true) return "model_unavailable";
  if (scenario.controls.malformedModelCandidate === true) {
    const normalized = normalizeProactiveInquiryCandidate({ candidateId: "bad_candidate" });
    return normalized ? null : "malformed_model_candidate";
  }
  if (scenario.controls.lowConfidenceModelCandidate === true) {
    const normalized = normalizeProactiveInquiryCandidate(buildLowConfidenceCandidateDraft(scenario));
    return normalized ? null : "low_confidence_model_candidate";
  }
  if (scenario.requiresSourceRecall === true && scenario.sourceRecallStatus === "disabled") {
    return "source_recall_disabled";
  }
  if (scenario.requiresSourceRecall === true && scenario.sourceRecallStatus === "blocked") {
    return "source_recall_blocked";
  }
  if (scenario.requiresSourceRecall === true && scenario.sourceRecallStatus === "unavailable") {
    return "source_recall_unavailable";
  }
  return null;
}

/**
 * Builds one proactive inquiry candidate from a scenario.
 *
 * @param scenario - Scenario describing candidate evidence and risk.
 * @returns Candidate used by deterministic delivery policy.
 */
function buildScenarioCandidate(
  scenario: DynamicPulseSemanticInquiryScenario
): ProactiveInquiryCandidate {
  const base = buildProactiveInquiryCandidateFromPulseCandidate(buildPulseCandidate(scenario), {
    sourceRecallStatus: scenario.sourceRecallStatus,
    sourceRecallRefs: scenario.sourceRecallRefs ?? [],
    blockedSourceRecallRefs:
      scenario.sourceRecallBlockReasons && scenario.sourceRecallBlockReasons.length > 0
        ? scenario.sourceRecallRefs ?? [`${scenario.id}_source_ref`]
        : [],
    blockReasons: scenario.sourceRecallBlockReasons ?? []
  });
  const feedbackBoost = scenario.outcomeFeedback === "useful" ? 0.15 : 0;
  return {
    ...base,
    expectedUserValue: clamp01(scenario.expectedUserValue + feedbackBoost),
    novelty: clamp01(scenario.novelty),
    risk: {
      ...base.risk,
      privacyRisk: scenario.privacyRisk,
      publicSafe: scenario.publicSafe,
      activeMissionSafe: scenario.activeMissionSafe
    },
    evidencePolicy: {
      ...base.evidencePolicy,
      sourceRecallUsable:
        scenario.sourceRecallStatus === "available" &&
        (scenario.sourceRecallBlockReasons ?? []).length === 0,
      blockReasons: scenario.sourceRecallBlockReasons ?? [],
      blockedSourceRecallRefs:
        scenario.sourceRecallBlockReasons && scenario.sourceRecallBlockReasons.length > 0
          ? scenario.sourceRecallRefs ?? [`${scenario.id}_source_ref`]
          : []
    }
  };
}

/**
 * Builds one deterministic Stage 6.86 pulse candidate fixture.
 *
 * @param scenario - Scenario containing reason and scoring inputs.
 * @returns Pulse candidate.
 */
function buildPulseCandidate(scenario: DynamicPulseSemanticInquiryScenario): PulseCandidateV1 {
  return {
    candidateId: `pulse_candidate_${scenario.id}`,
    reasonCode: scenario.reasonCode,
    score: clamp01(scenario.expectedUserValue),
    scoreBreakdown: {
      recency: 0.7,
      frequency: 0.6,
      unresolvedImportance: clamp01(scenario.expectedUserValue),
      sensitivityPenalty: scenario.privacyRisk === "none" ? 0 : 0.3,
      cooldownPenalty: Math.max(0, 1 - clamp01(scenario.novelty))
    },
    lastTouchedAt: `2026-05-0${Math.min(7, Math.max(1, scenario.day))}T12:00:00.000Z`,
    threadKey: `thread_${scenario.id}`,
    entityRefs: [`entity_${scenario.id}`],
    evidenceRefs: [`evidence_${scenario.id}`],
    sourceAuthority: "semantic_model",
    provenanceTier: "supporting",
    sensitive: scenario.privacyRisk !== "none",
    activeMissionSuppressed: !scenario.activeMissionSafe,
    stableHash: `stable_${scenario.id}`
  };
}

/**
 * Builds recent pulse history needed to prove outcome-driven suppression.
 *
 * @param candidate - Candidate being evaluated.
 * @param scenario - Scenario outcome controls.
 * @returns Recent pulse history.
 */
function buildRecentPulseHistory(
  candidate: ProactiveInquiryCandidate,
  scenario: DynamicPulseSemanticInquiryScenario
): readonly PulseEmissionRecordV1[] {
  if (!scenario.recentOutcomePattern || scenario.recentOutcomePattern === "engaged") {
    return [];
  }
  return [0, 1].map((index) => ({
    emittedAt: `2026-05-0${Math.max(1, scenario.day - index - 1)}T12:00:00.000Z`,
    reasonCode: scenario.reasonCode,
    candidateEntityRefs: candidate.evidence.graphRefs,
    candidateId: candidate.sourcePulseCandidateId ?? candidate.candidateId,
    proactiveInquiryCandidate: candidate,
    responseOutcome: scenario.recentOutcomePattern
  }));
}

/**
 * Builds one low-confidence model draft to prove schema-only fail-closed behavior.
 *
 * @param scenario - Scenario used for ids and topic labels.
 * @returns Low-confidence candidate draft.
 */
function buildLowConfidenceCandidateDraft(
  scenario: DynamicPulseSemanticInquiryScenario
): Parameters<typeof normalizeProactiveInquiryCandidate>[0] {
  return {
    candidateId: `low_confidence_${scenario.id}`,
    inquiryType: "ask_missing_constraint",
    userValueReason: "asks_for_missing_constraint",
    userValueRationale: "Synthetic low-confidence candidate for schema proof.",
    questionPlan: {
      userFacingGoal: "Ask for one missing constraint.",
      allowedTopic: `thread_${scenario.id}`,
      forbiddenDetails: [],
      suggestedTone: "tentative",
      boundedDraft: null
    },
    evidence: {
      sourceRecallRefs: [],
      memoryRefs: [],
      graphRefs: [],
      recentTurnRefs: []
    },
    evidencePolicy: {
      sourceRecallStatus: scenario.sourceRecallStatus,
      sourceRecallUsable: false,
      blockedSourceRecallRefs: [],
      blockReasons: []
    },
    risk: {
      interruptionRisk: "low",
      privacyRisk: "none",
      publicSafe: true,
      activeMissionSafe: true
    },
    confidence: 0.3,
    novelty: 0.8,
    expectedUserValue: 0.7
  };
}

/**
 * Resolves a bounded outcome-learning label for one scenario result.
 *
 * @param scenario - Scenario containing outcome inputs.
 * @param suppressionReason - Final suppression reason.
 * @returns Outcome-learning effect label.
 */
function resolveOutcomeLearningEffect(
  scenario: DynamicPulseSemanticInquiryScenario,
  suppressionReason: DynamicPulseMatrixSuppressionReason | null
): DynamicPulseSemanticInquiryScenarioResult["outcomeLearningEffect"] {
  if (scenario.outcomeFeedback === "useful") return "boosted_similar_useful_candidate";
  if (suppressionReason === "pulse_muted") return "muted_by_user";
  if (suppressionReason === "repeated_negative_outcome") {
    switch (scenario.recentOutcomePattern) {
      case "ignored":
        return "suppressed_repeated_ignored";
      case "dismissed":
        return "suppressed_repeated_dismissed";
      case "negative":
        return "suppressed_repeated_negative";
      case "muted":
        return "suppressed_repeated_muted";
      default:
        return "none";
    }
  }
  return "none";
}

/**
 * Builds per-scenario pass/fail reasons from observed behavior.
 *
 * @param input - Observed and expected scenario state.
 * @returns Failure reasons.
 */
function buildScenarioFailureReasons(input: {
  scenario: DynamicPulseSemanticInquiryScenario;
  candidate: ProactiveInquiryCandidate | null;
  messageEmitted: boolean;
  suppressionReason: DynamicPulseMatrixSuppressionReason | null;
}): string[] {
  const failures: string[] = [];
  if (Boolean(input.candidate) !== input.scenario.expected.candidateProposed) {
    failures.push("candidate proposal state did not match expected result");
  }
  if (input.messageEmitted !== input.scenario.expected.messageEmitted) {
    failures.push("message emission state did not match expected result");
  }
  if (input.suppressionReason !== input.scenario.expected.suppressionReason) {
    failures.push(
      `suppression reason ${input.suppressionReason ?? "none"} did not match ` +
      `${input.scenario.expected.suppressionReason ?? "none"}`
    );
  }
  if (input.candidate && Object.values(input.candidate.authority).some((value) => value !== false)) {
    failures.push("candidate authority flags were not all false");
  }
  if (
    input.scenario.evidenceMode === "schema_only" &&
    (input.scenario.expected.messageEmitted || input.scenario.expected.candidateProposed)
  ) {
    failures.push("schema-only evidence cannot claim runtime candidate or delivery proof");
  }
  return failures;
}

/**
 * Builds top-level matrix failure reasons.
 *
 * @param input - Matrix summary and privacy proof.
 * @returns Failure reasons.
 */
function buildTopLevelFailureReasons(input: {
  results: readonly DynamicPulseSemanticInquiryScenarioResult[];
  summary: DynamicPulseSemanticInquiryMatrix["summary"];
  artifactPrivacyProof: DynamicPulseSemanticInquiryMatrix["artifactPrivacyProof"];
}): string[] {
  const failures: string[] = [];
  if (input.results.some((result) => result.status === "FAIL")) {
    failures.push("one or more scenarios failed");
  }
  if (!input.summary.suppressionBalancePass) {
    failures.push("matrix emitted more messages than it suppressed");
  }
  if (input.artifactPrivacyProof.localDesktopPathPresentInArtifact) {
    failures.push("artifact contains a local desktop path");
  }
  if (input.artifactPrivacyProof.tokenShapedSecretPresentInArtifact) {
    failures.push("artifact contains a token-shaped secret");
  }
  return failures;
}

/**
 * Builds privacy proof over the generated matrix artifact body.
 *
 * @param matrix - Matrix body without privacy proof.
 * @returns Artifact privacy proof.
 */
function buildArtifactPrivacyProof(
  matrix: Omit<DynamicPulseSemanticInquiryMatrix, "artifactPrivacyProof" | "topLevelStatus">
): DynamicPulseSemanticInquiryMatrix["artifactPrivacyProof"] {
  const serialized = JSON.stringify(matrix);
  return {
    localDesktopPathPresentInArtifact: LOCAL_DESKTOP_PATH_PATTERN.test(serialized),
    tokenShapedSecretPresentInArtifact: TOKEN_SHAPED_SECRET_PATTERN.test(serialized)
  };
}

/**
 * Clamps one score to the matrix's deterministic 0..1 range.
 *
 * @param value - Numeric score.
 * @returns Clamped score.
 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(Math.min(1, Math.max(0, value)).toFixed(4));
}

/**
 * Runs the matrix script and writes the evidence artifact.
 */
async function main(): Promise<void> {
  const scenarios = await loadDynamicPulseSemanticInquiryScenarios();
  const matrix = await runDynamicPulseSemanticInquiryMatrix(scenarios);
  await writeDynamicPulseSemanticInquiryMatrix(matrix);
  console.log(JSON.stringify(matrix.summary, null, 2));
  if (matrix.summary.failed > 0 || matrix.topLevelStatus.status === "FAIL") {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
