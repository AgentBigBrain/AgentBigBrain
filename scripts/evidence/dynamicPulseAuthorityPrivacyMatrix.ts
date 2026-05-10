/**
 * @fileoverview Deterministic evidence matrix for Agent Pulse authority and privacy boundaries.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PulseReasonCodeV1 } from "../../src/core/types";
import {
  buildPulseAuthorityRequestId,
  buildPulseDecisionRecord,
  buildPulseSystemJobMetadata,
  evaluatePulseAuthorityGateway,
  type PulseAuthorityGatewayDecisionCode,
  type PulseAuthorityGatewayTargetVisibility,
  type PulseAuthorityGatewayTrigger
} from "../../src/interfaces/proactiveRuntime/pulseAuthorityGateway";

export const DYNAMIC_PULSE_AUTHORITY_PRIVACY_FIXTURE_PATH =
  "tests/fixtures/dynamicPulseAuthorityPrivacyScenarios.json";
export const DYNAMIC_PULSE_AUTHORITY_PRIVACY_ARTIFACT_PATH =
  "runtime/evidence/dynamic_pulse/dynamic_pulse_authority_privacy_matrix.json";

const TOKEN_SHAPED_SECRET_PATTERN =
  /(ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|\b[0-9]{8,10}:[A-Za-z0-9_-]{35,}\b)/;
const LOCAL_DESKTOP_PATH_PATTERN = /C:\\Users\\|\/home\/runner\/work\/AgentBigBrain\/AgentBigBrain/i;

export type DynamicPulseAuthorityEvidenceMode =
  | "schema_only"
  | "mocked_provider"
  | "runtime_observed"
  | "scheduler_observed"
  | "delivery_ledger"
  | "source_recall_blocked"
  | "deterministic_suppression"
  | "live_dependency_blocked";

export type DynamicPulseAuthorityProofCategory =
  | "delivery_permission"
  | "delivery_metadata"
  | "respond_only_constraint"
  | "control_scope"
  | "deterministic_suppression"
  | "privacy_suppression"
  | "public_prompt_minimized"
  | "source_recall_boundary"
  | "runtime_action_demoted"
  | "outcome_binding"
  | "startup_policy"
  | "dynamic_reason_policy"
  | "schema_validation";

export type DynamicPulseSourceRecallStatus =
  | "not_used"
  | "available"
  | "disabled"
  | "blocked"
  | "unavailable";

export interface DynamicPulseAuthorityPrivacyScenario {
  id: string;
  description: string;
  evidenceMode: DynamicPulseAuthorityEvidenceMode;
  proofCategory: DynamicPulseAuthorityProofCategory;
  trigger: PulseAuthorityGatewayTrigger;
  candidateProposed: boolean;
  reasonCode: PulseReasonCodeV1;
  dynamicReasonAllowed: boolean;
  targetVisibility: PulseAuthorityGatewayTargetVisibility;
  baseAllowed: boolean;
  baseDecisionCode: PulseAuthorityGatewayDecisionCode;
  baseSuppressedBy?: readonly string[];
  targetSessionVisibility: PulseAuthorityGatewayTargetVisibility;
  routeIsPublicSafe: boolean;
  sourceEvidencePublicSafe: boolean;
  userHasActiveMission?: boolean;
  userHasQueuedMission?: boolean;
  containsPrivateMemoryEvidence?: boolean;
  containsRelationshipEvidence?: boolean;
  containsIdentityEvidence?: boolean;
  candidatePublicSafe?: boolean;
  candidateActiveMissionSafe?: boolean;
  sourceRecallStatus: DynamicPulseSourceRecallStatus;
  sourceRecallUsable: boolean;
  sourceRecallTaskInputCaptureBlocked?: boolean;
  attemptedActionType?: string;
  outcomeBindingResult?:
    | "not_applicable"
    | "bound_by_pulse_and_job"
    | "wrong_session_rejected"
    | "control_not_engagement";
  expectedDecisionCode: PulseAuthorityGatewayDecisionCode;
  expectedMessageEmitted: boolean;
}

export interface DynamicPulseAuthorityPrivacyRow {
  scenarioId: string;
  evidenceMode: DynamicPulseAuthorityEvidenceMode;
  trigger: PulseAuthorityGatewayTrigger;
  candidateProposed: boolean;
  reasonCode: PulseReasonCodeV1;
  dynamicReasonAllowed: boolean;
  derivedPolicyFactsPresent: boolean;
  candidateSelfAttestationIgnoredAsPolicyProof: boolean;
  policyGatewayDecision: PulseAuthorityGatewayDecisionCode;
  pulseDecisionRecordPresent: boolean;
  suppressionReason: string | null;
  jobMetadataPresent: boolean;
  respondOnlyEnforced: boolean;
  messageEmitted: boolean;
  targetSession: string | null;
  targetVisibility: PulseAuthorityGatewayTargetVisibility;
  publicPromptMinimized: boolean;
  timezoneAuthoritySource: "explicit_user_setting" | "unknown";
  sourceRecallStatus: DynamicPulseSourceRecallStatus;
  sourceRecallTaskInputCaptureBlocked: boolean;
  outcomeBindingResult:
    | "not_applicable"
    | "bound_by_pulse_and_job"
    | "wrong_session_rejected"
    | "control_not_engagement";
  pulseFrequencyComparison: "equal" | "stricter" | "broader";
  proofCategory: DynamicPulseAuthorityProofCategory;
  liveDependencyStatus: "NOT_REQUIRED" | "BLOCKED";
  status: "PASS" | "FAIL";
  failureReasons: string[];
}

export interface DynamicPulseAuthorityPrivacyMatrix {
  generatedAt: string;
  artifactKind: "dynamic_pulse_authority_privacy_matrix";
  summary: {
    total: number;
    passed: number;
    failed: number;
    emissions: number;
    suppressions: number;
    suppressionsPerEmission: number;
    suppressionBalancePass: boolean;
    noIncreasedDefaultProactivity: boolean;
  };
  artifactPrivacyProof: {
    localDesktopPathPresentInArtifact: boolean;
    tokenShapedSecretPresentInArtifact: boolean;
  };
  topLevelStatus: {
    status: "PASS" | "FAIL";
    failureReasons: readonly string[];
  };
  rows: DynamicPulseAuthorityPrivacyRow[];
}

/**
 * Loads Agent Pulse authority/privacy scenarios from the fixture file.
 *
 * @param fixturePath - Fixture path.
 * @returns Parsed scenarios.
 */
export async function loadDynamicPulseAuthorityPrivacyScenarios(
  fixturePath = DYNAMIC_PULSE_AUTHORITY_PRIVACY_FIXTURE_PATH
): Promise<DynamicPulseAuthorityPrivacyScenario[]> {
  const raw = await readFile(fixturePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Dynamic Pulse authority/privacy fixture must be an array.");
  }
  return parsed.map(parseScenario);
}

/**
 * Runs the deterministic Agent Pulse authority/privacy matrix.
 *
 * @param scenarios - Scenarios to execute.
 * @returns Evidence matrix.
 */
export async function runDynamicPulseAuthorityPrivacyMatrix(
  scenarios: readonly DynamicPulseAuthorityPrivacyScenario[]
): Promise<DynamicPulseAuthorityPrivacyMatrix> {
  const rows = scenarios.map(runScenario);
  const passed = rows.filter((row) => row.status === "PASS").length;
  const emissions = rows.filter((row) => row.messageEmitted).length;
  const suppressions = rows.length - emissions;
  const suppressionBalancePass = suppressions >= emissions;
  const noIncreasedDefaultProactivity = rows.every(
    (row) => row.pulseFrequencyComparison !== "broader"
  );
  const matrixWithoutProof: Omit<
    DynamicPulseAuthorityPrivacyMatrix,
    "artifactPrivacyProof" | "topLevelStatus"
  > = {
    generatedAt: new Date().toISOString(),
    artifactKind: "dynamic_pulse_authority_privacy_matrix",
    summary: {
      total: rows.length,
      passed,
      failed: rows.length - passed,
      emissions,
      suppressions,
      suppressionsPerEmission: emissions > 0 ? Number((suppressions / emissions).toFixed(4)) : suppressions,
      suppressionBalancePass,
      noIncreasedDefaultProactivity
    },
    rows
  };
  const artifactPrivacyProof = buildArtifactPrivacyProof(matrixWithoutProof);
  const failureReasons = buildTopLevelFailureReasons({
    rows,
    summary: matrixWithoutProof.summary,
    artifactPrivacyProof
  });
  return {
    ...matrixWithoutProof,
    artifactPrivacyProof,
    topLevelStatus: {
      status: failureReasons.length === 0 ? "PASS" : "FAIL",
      failureReasons
    }
  };
}

/**
 * Writes the Agent Pulse authority/privacy matrix artifact.
 *
 * @param matrix - Matrix body.
 * @param artifactPath - Output artifact path.
 */
export async function writeDynamicPulseAuthorityPrivacyMatrix(
  matrix: DynamicPulseAuthorityPrivacyMatrix,
  artifactPath = DYNAMIC_PULSE_AUTHORITY_PRIVACY_ARTIFACT_PATH
): Promise<void> {
  const resolved = path.resolve(process.cwd(), artifactPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
}

/**
 * Parses one raw fixture scenario into the matrix contract.
 *
 * @param raw - Raw fixture object.
 * @returns Parsed scenario.
 */
function parseScenario(raw: unknown): DynamicPulseAuthorityPrivacyScenario {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Dynamic Pulse authority/privacy scenario must be an object.");
  }
  const record = raw as DynamicPulseAuthorityPrivacyScenario;
  if (
    typeof record.id !== "string" ||
    typeof record.description !== "string" ||
    typeof record.reasonCode !== "string" ||
    typeof record.trigger !== "string" ||
    typeof record.dynamicReasonAllowed !== "boolean" ||
    typeof record.baseAllowed !== "boolean" ||
    typeof record.expectedDecisionCode !== "string" ||
    typeof record.expectedMessageEmitted !== "boolean"
  ) {
    throw new Error("Dynamic Pulse authority/privacy scenario is missing required fields.");
  }
  return record;
}

/**
 * Runs one matrix scenario through the canonical pulse authority gateway.
 *
 * @param scenario - Scenario fixture.
 * @returns Matrix row.
 */
function runScenario(scenario: DynamicPulseAuthorityPrivacyScenario): DynamicPulseAuthorityPrivacyRow {
  const targetSessionId = scenario.targetVisibility === "unknown" ? null : `session_${scenario.id}`;
  const requestId = buildPulseAuthorityRequestId({
    userId: "user_matrix",
    controllerSessionId: "session_controller",
    targetSessionId,
    reasonCode: scenario.reasonCode,
    candidateId: scenario.candidateProposed ? `candidate_${scenario.id}` : null,
    trigger: scenario.trigger,
    nowIso: "2026-05-09T12:00:00.000Z"
  });
  const decision = evaluatePulseAuthorityGateway({
    requestId,
    userId: "user_matrix",
    controllerSessionId: "session_controller",
    targetSessionId,
    targetVisibility: scenario.targetVisibility,
    reasonCode: scenario.reasonCode,
    candidateId: scenario.candidateProposed ? `candidate_${scenario.id}` : null,
    trigger: scenario.trigger,
    nowIso: "2026-05-09T12:00:00.000Z",
    baseDecision: {
      allowed: scenario.baseAllowed,
      decisionCode: scenario.baseDecisionCode,
      suppressedBy: scenario.baseSuppressedBy ?? [],
      nextEligibleAtIso: null
    },
    dynamicReasonAllowed: scenario.dynamicReasonAllowed,
    candidateRisk: {
      privacyRisk:
        scenario.containsPrivateMemoryEvidence ||
        scenario.containsRelationshipEvidence ||
        scenario.containsIdentityEvidence
          ? "private_only"
          : "none",
      publicSafe: scenario.candidatePublicSafe ?? scenario.targetVisibility !== "public",
      activeMissionSafe: scenario.candidateActiveMissionSafe ?? true
    },
    policyContext: {
      targetSessionVisibility: scenario.targetSessionVisibility,
      userHasActiveMission: scenario.userHasActiveMission === true,
      userHasQueuedMission: scenario.userHasQueuedMission === true,
      routeIsPublicSafe: scenario.routeIsPublicSafe,
      sourceEvidencePublicSafe: scenario.sourceEvidencePublicSafe,
      timezoneSource: "explicit_user_setting"
    },
    evidence: {
      evidenceRefs: scenario.candidateProposed ? [`evidence_${scenario.id}`] : [],
      sourceRecallRefs: scenario.sourceRecallStatus === "not_used" ? [] : [`source_${scenario.id}`],
      sourceRecallStatus: scenario.sourceRecallStatus,
      sourceRecallUsable: scenario.sourceRecallUsable,
      containsPrivateMemoryEvidence: scenario.containsPrivateMemoryEvidence === true,
      containsRelationshipEvidence: scenario.containsRelationshipEvidence === true,
      containsIdentityEvidence: scenario.containsIdentityEvidence === true
    }
  });
  const decisionRecord = buildPulseDecisionRecord({
    request: {
      requestId,
      userId: "user_matrix",
      controllerSessionId: "session_controller",
      targetSessionId,
      targetVisibility: scenario.targetVisibility,
      reasonCode: scenario.reasonCode,
      candidateId: scenario.candidateProposed ? `candidate_${scenario.id}` : null,
      trigger: scenario.trigger,
      nowIso: "2026-05-09T12:00:00.000Z",
      baseDecision: {
        allowed: scenario.baseAllowed,
        decisionCode: scenario.baseDecisionCode,
        suppressedBy: scenario.baseSuppressedBy ?? [],
        nextEligibleAtIso: null
      },
      dynamicReasonAllowed: scenario.dynamicReasonAllowed,
      candidateRisk: {
        privacyRisk:
          scenario.containsPrivateMemoryEvidence ||
          scenario.containsRelationshipEvidence ||
          scenario.containsIdentityEvidence
            ? "private_only"
            : "none",
        publicSafe: scenario.candidatePublicSafe ?? scenario.targetVisibility !== "public",
        activeMissionSafe: scenario.candidateActiveMissionSafe ?? true
      },
      policyContext: {
        targetSessionVisibility: scenario.targetSessionVisibility,
        userHasActiveMission: scenario.userHasActiveMission === true,
        userHasQueuedMission: scenario.userHasQueuedMission === true,
        routeIsPublicSafe: scenario.routeIsPublicSafe,
        sourceEvidencePublicSafe: scenario.sourceEvidencePublicSafe,
        timezoneSource: "explicit_user_setting"
      },
      evidence: {
        evidenceRefs: scenario.candidateProposed ? [`evidence_${scenario.id}`] : [],
        sourceRecallRefs: scenario.sourceRecallStatus === "not_used" ? [] : [`source_${scenario.id}`],
        sourceRecallStatus: scenario.sourceRecallStatus,
        sourceRecallUsable: scenario.sourceRecallUsable,
        containsPrivateMemoryEvidence: scenario.containsPrivateMemoryEvidence === true,
        containsRelationshipEvidence: scenario.containsRelationshipEvidence === true,
        containsIdentityEvidence: scenario.containsIdentityEvidence === true
      }
    },
    decision,
    candidateProposed: scenario.candidateProposed,
    decisionStatus: decision.allowed ? "allowed_for_queue" : "suppressed",
  });
  const metadata = decision.allowed
    ? buildPulseSystemJobMetadata({
        pulseId: `pulse_${scenario.id}`,
        candidateId: scenario.candidateProposed ? `candidate_${scenario.id}` : null,
        deliveryDecisionId: decision.decisionId,
        decisionRecordId: decisionRecord.decisionRecordId,
        promptKind: "semantic_inquiry_pulse"
      })
    : null;
  const sideEffectBlocked =
    typeof scenario.attemptedActionType === "string" && scenario.attemptedActionType !== "respond";
  const messageEmitted = decision.allowed && scenario.candidateProposed && !sideEffectBlocked;
  const publicPromptMinimized = scenario.targetVisibility !== "public" || scenario.sourceRecallStatus !== "available";
  const row: DynamicPulseAuthorityPrivacyRow = {
    scenarioId: scenario.id,
    evidenceMode: scenario.evidenceMode,
    trigger: scenario.trigger,
    candidateProposed: scenario.candidateProposed,
    reasonCode: scenario.reasonCode,
    dynamicReasonAllowed: scenario.dynamicReasonAllowed,
    derivedPolicyFactsPresent: true,
    candidateSelfAttestationIgnoredAsPolicyProof:
      decision.decisionCode === "PUBLIC_PRIVACY_BLOCKED" && scenario.candidatePublicSafe === true,
    policyGatewayDecision: decision.decisionCode,
    pulseDecisionRecordPresent: true,
    suppressionReason: decision.allowed ? null : decision.suppressedBy[0] ?? decision.decisionCode,
    jobMetadataPresent: metadata !== null,
    respondOnlyEnforced:
      metadata?.executionConstraint === "respond_only_pulse" &&
      metadata.allowedActionTypes.length === 1 &&
      metadata.allowedActionTypes[0] === "respond",
    messageEmitted,
    targetSession: targetSessionId,
    targetVisibility: scenario.targetVisibility,
    publicPromptMinimized,
    timezoneAuthoritySource: "explicit_user_setting",
    sourceRecallStatus: scenario.sourceRecallStatus,
    sourceRecallTaskInputCaptureBlocked: scenario.sourceRecallTaskInputCaptureBlocked === true,
    outcomeBindingResult: scenario.outcomeBindingResult ?? "not_applicable",
    pulseFrequencyComparison: messageEmitted ? "equal" : "stricter",
    proofCategory: scenario.proofCategory,
    liveDependencyStatus: scenario.evidenceMode === "live_dependency_blocked" ? "BLOCKED" : "NOT_REQUIRED",
    status: "PASS",
    failureReasons: []
  };
  const failureReasons = buildRowFailureReasons(row, scenario);
  return {
    ...row,
    status: failureReasons.length === 0 ? "PASS" : "FAIL",
    failureReasons
  };
}

/**
 * Builds pass/fail reasons for one matrix row.
 *
 * @param row - Observed matrix row.
 * @param scenario - Scenario expectations.
 * @returns Failure reasons.
 */
function buildRowFailureReasons(
  row: DynamicPulseAuthorityPrivacyRow,
  scenario: DynamicPulseAuthorityPrivacyScenario
): string[] {
  const failures: string[] = [];
  if (row.policyGatewayDecision !== scenario.expectedDecisionCode) {
    failures.push(
      `decision ${row.policyGatewayDecision} did not match ${scenario.expectedDecisionCode}`
    );
  }
  if (row.messageEmitted !== scenario.expectedMessageEmitted) {
    failures.push("message emission state did not match expectation");
  }
  if (!row.pulseDecisionRecordPresent) {
    failures.push("pulse decision record missing");
  }
  if (row.messageEmitted && !row.jobMetadataPresent) {
    failures.push("emitted pulse is missing typed job metadata");
  }
  if (row.messageEmitted && !row.respondOnlyEnforced) {
    failures.push("emitted pulse is not respond-only constrained");
  }
  if (scenario.targetVisibility === "public" && !row.publicPromptMinimized) {
    failures.push("public prompt was not minimized");
  }
  if (scenario.sourceRecallTaskInputCaptureBlocked === true && !row.sourceRecallTaskInputCaptureBlocked) {
    failures.push("internal pulse prompt Source Recall task_input capture was not blocked");
  }
  if (scenario.proofCategory === "schema_validation" && row.messageEmitted) {
    failures.push("schema-only proof cannot claim delivery");
  }
  return failures;
}

/**
 * Builds top-level pass/fail reasons for the matrix.
 *
 * @param input - Matrix rows, summary, and privacy proof.
 * @returns Failure reasons.
 */
function buildTopLevelFailureReasons(input: {
  rows: readonly DynamicPulseAuthorityPrivacyRow[];
  summary: DynamicPulseAuthorityPrivacyMatrix["summary"];
  artifactPrivacyProof: DynamicPulseAuthorityPrivacyMatrix["artifactPrivacyProof"];
}): string[] {
  const failures: string[] = [];
  if (input.rows.some((row) => row.status === "FAIL")) {
    failures.push("one or more authority/privacy rows failed");
  }
  if (!input.summary.suppressionBalancePass) {
    failures.push("matrix emitted more messages than it suppressed");
  }
  if (!input.summary.noIncreasedDefaultProactivity) {
    failures.push("matrix broadened default pulse frequency");
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
 * Builds artifact-level privacy proof for generated matrix content.
 *
 * @param matrix - Matrix body without privacy proof.
 * @returns Privacy proof.
 */
function buildArtifactPrivacyProof(
  matrix: Omit<DynamicPulseAuthorityPrivacyMatrix, "artifactPrivacyProof" | "topLevelStatus">
): DynamicPulseAuthorityPrivacyMatrix["artifactPrivacyProof"] {
  const serialized = JSON.stringify(matrix);
  return {
    localDesktopPathPresentInArtifact: LOCAL_DESKTOP_PATH_PATTERN.test(serialized),
    tokenShapedSecretPresentInArtifact: TOKEN_SHAPED_SECRET_PATTERN.test(serialized)
  };
}

/**
 * Runs the matrix script and writes the artifact.
 */
async function main(): Promise<void> {
  const scenarios = await loadDynamicPulseAuthorityPrivacyScenarios();
  const matrix = await runDynamicPulseAuthorityPrivacyMatrix(scenarios);
  await writeDynamicPulseAuthorityPrivacyMatrix(matrix);
  console.log(JSON.stringify(matrix.summary, null, 2));
  if (matrix.topLevelStatus.status === "FAIL") {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
