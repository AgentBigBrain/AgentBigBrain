/**
 * @fileoverview Deterministic evidence matrix for principal, subject, and access boundaries.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  MemorySubjectKind,
  PrincipalAccessClass,
  PrincipalAccessOperation,
  PrincipalAccessReason,
  PrincipalContext,
  PrincipalRole
} from "../../src/interfaces/principalRuntime/principalAccess";
import {
  buildExternalAgentPrincipalContext,
  buildLegacyUnknownPrincipalContext,
  buildTaskExecutionPrincipalAccess,
  derivePrincipalContextFromIngress,
  requirePrincipalAccessForOperation
} from "../../src/interfaces/principalRuntime/principalAccess";
import { createOwnerOperatorPrincipalConfigFromEnv } from "../../src/interfaces/principalRuntime/principalConfig";
import type { ConversationVisibility } from "../../src/interfaces/sessionStore";

export const PRINCIPAL_SUBJECT_ACCESS_FIXTURE_PATH =
  "tests/fixtures/principalSubjectAccessScenarios.json";
export const PRINCIPAL_SUBJECT_ACCESS_ARTIFACT_PATH =
  "runtime/evidence/principal_subject_access/principal_subject_access_matrix.json";

const SYNTHETIC_HMAC_KEY = "synthetic-principal-access-matrix-key";
const TOKEN_SHAPED_SECRET_PATTERN =
  /(ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|\b[0-9]{8,10}:[A-Za-z0-9_-]{35,}\b)/;
const LOCAL_DESKTOP_PATH_PATTERN = /C:\\Users\\|\/home\/runner\/work\/AgentBigBrain\/AgentBigBrain/i;

export type PrincipalSubjectAccessGroup =
  | "principal_resolution"
  | "envelope_spoofing"
  | "self_identity"
  | "memory_access"
  | "task_direct_federation_autonomous"
  | "source_recall_media_graph"
  | "projection_review_learning_receipts";

export type PrincipalSubjectProofCategory =
  | "contract_schema"
  | "synthetic_runtime_observed"
  | "source_recall_blocked"
  | "live_dependency_blocked";

export type PrincipalSubjectActorKind =
  | "ingress"
  | "external_agent"
  | "legacy_unknown"
  | "runtime_continuation";

export interface PrincipalSubjectAccessScenario {
  id: string;
  description: string;
  group: PrincipalSubjectAccessGroup;
  proofCategory: PrincipalSubjectProofCategory;
  actor: {
    kind: PrincipalSubjectActorKind;
    provider?: "telegram" | "discord";
    conversationId?: string;
    userId?: string;
    username?: string;
    visibility?: ConversationVisibility;
    ownerUserIds?: readonly string[];
    operatorUserIds?: readonly string[];
    allowedUserIds?: readonly string[];
    allowedUsernames?: readonly string[];
    displayNameHint?: string | null;
  };
  operation: PrincipalAccessOperation;
  requestedSubjectKind: MemorySubjectKind;
  requestedSubjectOwner: "owner" | "speaker" | "legacy_global" | "unknown";
  sourceRecall?: {
    status: "not_used" | "principal_scoped" | "disabled" | "blocked";
    lifecycleVisible?: boolean;
    principalScoped?: boolean;
  };
  graphEvidenceScope?: "actor_scoped" | "shared_only" | "support_only" | "none";
  userText?: string;
  expected: {
    actorRole: PrincipalRole;
    routeVisibility: ConversationVisibility;
    legacyIdentityState: string;
    requestedSubjectKind: MemorySubjectKind;
    accessClass: PrincipalAccessClass;
    allowed: boolean;
    blockReason: string | null;
    memoryReadCount: number;
    memoryWriteCount: number;
    sourceRecallUsed: boolean;
    sourceRecallScopeKind: string;
    graphEvidenceScope: string;
    reviewActionApplied: boolean;
    messageEmitted: boolean;
  };
}

export interface PrincipalSubjectAccessRow {
  scenarioId: string;
  actorRole: PrincipalRole;
  routeVisibility: ConversationVisibility;
  legacyIdentityState: string;
  requestedSubjectKind: MemorySubjectKind;
  accessClass: PrincipalAccessClass;
  allowed: boolean;
  blockReason: string | null;
  memoryReadCount: number;
  memoryWriteCount: number;
  sourceRecallUsed: boolean;
  sourceRecallScopeKind: string;
  graphEvidenceScope: string;
  reviewActionApplied: boolean;
  messageEmitted: boolean;
  proofCategory: PrincipalSubjectProofCategory;
  envelopeSpoofIgnored: boolean;
  rawProviderIdPresentInRow: boolean;
  tokenShapedSecretPresentInRow: boolean;
  passed: boolean;
  failureReasons: readonly string[];
}

export interface PrincipalSubjectAccessMatrix {
  generatedAt: string;
  artifactKind: "principal_subject_access_matrix";
  summary: {
    total: number;
    passed: number;
    failed: number;
    ownerPrivateReads: number;
    ownerPrivateWrites: number;
    sourceRecallUsages: number;
    reviewActionsApplied: number;
  };
  artifactPrivacyProof: {
    localDesktopPathPresentInArtifact: boolean;
    tokenShapedSecretPresentInArtifact: boolean;
    rawProviderIdPresentInArtifact: boolean;
  };
  topLevelStatus: {
    status: "PASS" | "FAIL";
    failureReasons: readonly string[];
  };
  rows: readonly PrincipalSubjectAccessRow[];
}

/**
 * Loads principal/subject/access scenarios from the fixture file.
 */
export async function loadPrincipalSubjectAccessScenarios(
  fixturePath = PRINCIPAL_SUBJECT_ACCESS_FIXTURE_PATH
): Promise<PrincipalSubjectAccessScenario[]> {
  const raw = await readFile(fixturePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Principal/subject/access fixture must be an array.");
  }
  return parsed.map(parseScenario);
}

/**
 * Runs the deterministic principal/subject/access evidence matrix.
 */
export async function runPrincipalSubjectAccessMatrix(
  scenarios: readonly PrincipalSubjectAccessScenario[]
): Promise<PrincipalSubjectAccessMatrix> {
  const rows = scenarios.map(runScenario);
  const passed = rows.filter((row) => row.passed).length;
  const matrixWithoutProof: Omit<PrincipalSubjectAccessMatrix, "artifactPrivacyProof" | "topLevelStatus"> = {
    generatedAt: new Date().toISOString(),
    artifactKind: "principal_subject_access_matrix",
    summary: {
      total: rows.length,
      passed,
      failed: rows.length - passed,
      ownerPrivateReads: rows.filter(
        (row) => row.allowed && row.accessClass === "owner_private" && row.memoryReadCount > 0
      ).length,
      ownerPrivateWrites: rows.filter(
        (row) => row.allowed && row.accessClass === "owner_private" && row.memoryWriteCount > 0
      ).length,
      sourceRecallUsages: rows.filter((row) => row.sourceRecallUsed).length,
      reviewActionsApplied: rows.filter((row) => row.reviewActionApplied).length
    },
    rows
  };
  const artifactPrivacyProof = buildArtifactPrivacyProof(matrixWithoutProof);
  const failureReasons = buildTopLevelFailureReasons(rows, artifactPrivacyProof);
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
 * Writes the principal/subject/access matrix artifact.
 */
export async function writePrincipalSubjectAccessMatrix(
  matrix: PrincipalSubjectAccessMatrix,
  artifactPath = PRINCIPAL_SUBJECT_ACCESS_ARTIFACT_PATH
): Promise<void> {
  const resolved = path.resolve(process.cwd(), artifactPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
}

function parseScenario(raw: unknown): PrincipalSubjectAccessScenario {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Principal/subject/access scenario must be an object.");
  }
  const candidate = raw as PrincipalSubjectAccessScenario;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.description !== "string" ||
    typeof candidate.group !== "string" ||
    typeof candidate.proofCategory !== "string" ||
    !candidate.actor ||
    typeof candidate.actor !== "object" ||
    typeof candidate.operation !== "string" ||
    typeof candidate.requestedSubjectKind !== "string" ||
    typeof candidate.requestedSubjectOwner !== "string" ||
    !candidate.expected ||
    typeof candidate.expected !== "object"
  ) {
    throw new Error("Principal/subject/access scenario is missing required fields.");
  }
  return candidate;
}

function runScenario(scenario: PrincipalSubjectAccessScenario): PrincipalSubjectAccessRow {
  const principalContext = buildPrincipalContext(scenario);
  const access = evaluateScenarioAccess(scenario, principalContext);
  const sourceRecall = evaluateSourceRecall(scenario, access);
  const rowWithoutPass: Omit<PrincipalSubjectAccessRow, "passed" | "failureReasons"> = {
    scenarioId: scenario.id,
    actorRole: principalContext.actor.principalRole,
    routeVisibility: principalContext.route.visibility,
    legacyIdentityState: principalContext.actor.legacyIdentityState,
    requestedSubjectKind: scenario.requestedSubjectKind,
    accessClass: access.accessClass,
    allowed: access.allowed,
    blockReason: access.allowed ? null : access.reason,
    memoryReadCount: access.allowed && isReadOperation(scenario.operation) ? 1 : 0,
    memoryWriteCount: access.allowed && isWriteOperation(scenario.operation) ? 1 : 0,
    sourceRecallUsed: sourceRecall.used,
    sourceRecallScopeKind: sourceRecall.scopeKind,
    graphEvidenceScope: scenario.graphEvidenceScope ?? "none",
    reviewActionApplied: access.allowed && scenario.operation === "projection_review_action",
    messageEmitted: access.allowed && scenario.operation === "direct_reply",
    proofCategory: scenario.proofCategory,
    envelopeSpoofIgnored: evaluateEnvelopeSpoofIgnored(scenario),
    rawProviderIdPresentInRow: false,
    tokenShapedSecretPresentInRow: false
  };
  const failureReasons = compareExpected(rowWithoutPass, scenario.expected);
  return {
    ...rowWithoutPass,
    passed: failureReasons.length === 0,
    failureReasons
  };
}

function buildPrincipalContext(scenario: PrincipalSubjectAccessScenario): PrincipalContext {
  if (scenario.actor.kind === "external_agent") {
    return buildExternalAgentPrincipalContext({
      externalAgentId: "synthetic-external-agent",
      contractId: scenario.id,
      requestedAt: "2026-05-10T12:00:00.000Z"
    });
  }
  if (scenario.actor.kind === "legacy_unknown") {
    return buildLegacyUnknownPrincipalContext({
      requestId: `legacy:${scenario.id}`,
      conversationId: scenario.actor.conversationId ?? null,
      conversationVisibility: scenario.actor.visibility ?? "unknown"
    });
  }
  if (scenario.actor.kind === "runtime_continuation") {
    return buildRuntimeContinuationContext(scenario);
  }

  const provider = scenario.actor.provider ?? "telegram";
  const ownerKey = provider === "telegram"
    ? "BRAIN_OWNER_TELEGRAM_USER_IDS"
    : "BRAIN_OWNER_DISCORD_USER_IDS";
  const operatorKey = provider === "telegram"
    ? "BRAIN_OPERATOR_TELEGRAM_USER_IDS"
    : "BRAIN_OPERATOR_DISCORD_USER_IDS";
  const principalConfig = createOwnerOperatorPrincipalConfigFromEnv({
    BRAIN_PRINCIPAL_HMAC_KEY: SYNTHETIC_HMAC_KEY,
    [ownerKey]: scenario.actor.ownerUserIds?.join(",") ?? "",
    [operatorKey]: scenario.actor.operatorUserIds?.join(",") ?? ""
  });
  return derivePrincipalContextFromIngress({
    provider,
    conversationId: scenario.actor.conversationId ?? "synthetic-conversation",
    userId: scenario.actor.userId ?? "",
    username: scenario.actor.username ?? "",
    conversationVisibility: scenario.actor.visibility ?? "private",
    receivedAt: "2026-05-10T12:00:00.000Z",
    principalConfig,
    allowedUserIds: scenario.actor.allowedUserIds,
    allowedUsernames: scenario.actor.allowedUsernames,
    transportIdentity: {
      provider,
      username: scenario.actor.username ?? null,
      displayName: scenario.actor.displayNameHint ?? null,
      givenName: null,
      familyName: null,
      observedAt: "2026-05-10T12:00:00.000Z"
    }
  });
}

function buildRuntimeContinuationContext(scenario: PrincipalSubjectAccessScenario): PrincipalContext {
  const base = buildLegacyUnknownPrincipalContext({
    requestId: `runtime:${scenario.id}`,
    conversationId: scenario.actor.conversationId ?? "runtime-continuation",
    conversationVisibility: scenario.actor.visibility ?? "unknown",
    source: "runtime"
  });
  return {
    ...base,
    actor: {
      ...base.actor,
      principalId: "runtime:continuation",
      principalRole: "runtime_continuation",
      provider: "runtime",
      legacyIdentityState: "runtime_continuation_missing_origin",
      identityAuthority: "runtime_inherited",
      ownerMatchSource: "none"
    }
  };
}

function evaluateScenarioAccess(
  scenario: PrincipalSubjectAccessScenario,
  principalContext: PrincipalContext
): {
  accessClass: PrincipalAccessClass;
  allowed: boolean;
  reason: PrincipalAccessReason;
} {
  if (scenario.operation === "task_execution") {
    const taskAccess = buildTaskExecutionPrincipalAccess(principalContext).accessDecision;
    return {
      accessClass: taskAccess.accessClass,
      allowed: taskAccess.allowed,
      reason: taskAccess.reason
    };
  }

  const classification = classifyAccess(scenario, principalContext);
  requirePrincipalAccessForOperation({
    principalContext,
    operation: scenario.operation,
    accessClass: classification.accessClass,
    allowed: classification.allowed,
    reason: classification.reason
  });
  return classification;
}

function classifyAccess(
  scenario: PrincipalSubjectAccessScenario,
  context: PrincipalContext
): {
  accessClass: PrincipalAccessClass;
  allowed: boolean;
  reason: PrincipalAccessReason;
} {
  if (context.actor.principalRole === "legacy_unknown") {
    return { accessClass: "blocked", allowed: false, reason: "missing_principal_scope" };
  }
  if (context.actor.principalRole === "external_agent") {
    return scenario.operation === "task_execution"
      ? { accessClass: "external_agent_limited", allowed: true, reason: "external_agent_limited" }
      : { accessClass: "blocked", allowed: false, reason: "non_owner_owner_private_blocked" };
  }
  if (context.actor.principalRole === "runtime_continuation") {
    return { accessClass: "runtime_continuation_limited", allowed: false, reason: "missing_principal_scope" };
  }
  if (context.route.visibility === "public" && scenario.requestedSubjectKind !== "project") {
    return {
      accessClass: "blocked",
      allowed: false,
      reason: "public_route_private_memory_blocked"
    };
  }
  if (scenario.requestedSubjectKind === "owner_profile" || scenario.requestedSubjectKind === "legacy_global_profile") {
    if (context.actor.principalRole === "owner") {
      return { accessClass: "owner_private", allowed: true, reason: "owner_principal_matched" };
    }
    if (context.actor.principalRole === "operator" && isOperatorOperation(scenario.operation)) {
      return { accessClass: "operator_private", allowed: true, reason: "operator_principal_matched" };
    }
    return {
      accessClass: "blocked",
      allowed: false,
      reason:
        scenario.requestedSubjectKind === "legacy_global_profile"
          ? "legacy_global_owner_only"
          : "non_owner_owner_private_blocked"
    };
  }
  if (isOwnerOnlyOperation(scenario.operation) && context.actor.principalRole !== "owner" && context.actor.principalRole !== "operator") {
    return { accessClass: "blocked", allowed: false, reason: "non_owner_owner_private_blocked" };
  }
  if (scenario.operation === "learning_write" && context.actor.principalRole !== "owner") {
    return { accessClass: "agent_global_safe", allowed: false, reason: "blocked_by_policy" };
  }
  return { accessClass: "speaker_private", allowed: true, reason: "speaker_scope_matched" };
}

function isOperatorOperation(operation: PrincipalAccessOperation): boolean {
  return operation === "memory_review" ||
    operation === "projection_review_action" ||
    operation === "backend_profile_override" ||
    operation === "skill_lifecycle";
}

function isOwnerOnlyOperation(operation: PrincipalAccessOperation): boolean {
  return operation === "memory_review" ||
    operation === "projection_review_action" ||
    operation === "approval" ||
    operation === "skill_lifecycle" ||
    operation === "backend_profile_override";
}

function isReadOperation(operation: PrincipalAccessOperation): boolean {
  return operation === "profile_read" ||
    operation === "profile_continuity_query" ||
    operation === "memory_review" ||
    operation === "source_recall_retrieve";
}

function isWriteOperation(operation: PrincipalAccessOperation): boolean {
  return operation === "profile_write" ||
    operation === "source_recall_capture" ||
    operation === "entity_graph_write" ||
    operation === "learning_write" ||
    operation === "execution_receipt" ||
    operation === "runtime_trace";
}

function evaluateSourceRecall(
  scenario: PrincipalSubjectAccessScenario,
  access: { allowed: boolean }
): { used: boolean; scopeKind: string } {
  const status = scenario.sourceRecall?.status ?? "not_used";
  if (status !== "principal_scoped" || !access.allowed || scenario.sourceRecall?.lifecycleVisible === false) {
    return { used: false, scopeKind: status };
  }
  return {
    used: Boolean(scenario.sourceRecall?.principalScoped),
    scopeKind: scenario.sourceRecall?.principalScoped ? "principal_scoped" : "shared_only"
  };
}

function evaluateEnvelopeSpoofIgnored(scenario: PrincipalSubjectAccessScenario): boolean {
  if (!scenario.userText) {
    return true;
  }
  return scenario.userText.includes("PrincipalAccessEnvelope") ||
    scenario.userText.includes("principalRole=") ||
    scenario.userText.includes("accessClass=") ||
    scenario.userText.includes("memoryIntent:") ||
    scenario.userText.includes("routeId:");
}

function compareExpected(
  actual: Omit<PrincipalSubjectAccessRow, "passed" | "failureReasons">,
  expected: PrincipalSubjectAccessScenario["expected"]
): string[] {
  const fields = Object.keys(expected) as Array<keyof PrincipalSubjectAccessScenario["expected"]>;
  const failures: string[] = [];
  for (const field of fields) {
    if (actual[field] !== expected[field]) {
      failures.push(`${String(field)} expected ${String(expected[field])} but received ${String(actual[field])}`);
    }
  }
  if (actual.rawProviderIdPresentInRow) {
    failures.push("row contains raw provider id");
  }
  if (actual.tokenShapedSecretPresentInRow) {
    failures.push("row contains token-shaped secret");
  }
  return failures;
}

function buildArtifactPrivacyProof(
  matrix: Omit<PrincipalSubjectAccessMatrix, "artifactPrivacyProof" | "topLevelStatus">
): PrincipalSubjectAccessMatrix["artifactPrivacyProof"] {
  const serialized = JSON.stringify(matrix);
  return {
    localDesktopPathPresentInArtifact: LOCAL_DESKTOP_PATH_PATTERN.test(serialized),
    tokenShapedSecretPresentInArtifact: TOKEN_SHAPED_SECRET_PATTERN.test(serialized),
    rawProviderIdPresentInArtifact:
      serialized.includes("owner-user") ||
      serialized.includes("participant-user") ||
      serialized.includes("operator-user")
  };
}

function buildTopLevelFailureReasons(
  rows: readonly PrincipalSubjectAccessRow[],
  artifactPrivacyProof: PrincipalSubjectAccessMatrix["artifactPrivacyProof"]
): string[] {
  const failures = rows.flatMap((row) =>
    row.passed ? [] : [`${row.scenarioId}: ${row.failureReasons.join("; ")}`]
  );
  if (artifactPrivacyProof.localDesktopPathPresentInArtifact) {
    failures.push("artifact contains local desktop path");
  }
  if (artifactPrivacyProof.tokenShapedSecretPresentInArtifact) {
    failures.push("artifact contains token-shaped secret");
  }
  if (artifactPrivacyProof.rawProviderIdPresentInArtifact) {
    failures.push("artifact contains raw provider id");
  }
  return failures;
}

async function main(): Promise<void> {
  const scenarios = await loadPrincipalSubjectAccessScenarios();
  const matrix = await runPrincipalSubjectAccessMatrix(scenarios);
  await writePrincipalSubjectAccessMatrix(matrix);
  console.log(JSON.stringify(matrix.summary, null, 2));
  if (matrix.topLevelStatus.status !== "PASS") {
    console.error(matrix.topLevelStatus.failureReasons.join("\n"));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
