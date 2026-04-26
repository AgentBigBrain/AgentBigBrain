/**
 * @fileoverview Runs a concrete Stage 6.5 checkpoint 6.9 live check and emits a reviewer artifact with federated auth/quote gate and orchestrator governance-trace proof.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BrainOrchestrator } from "../../src/core/orchestrator";
import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { StateStore } from "../../src/core/stateStore";
import { GovernanceMemoryStore } from "../../src/core/governanceMemory";
import { PersonalityStore } from "../../src/core/personalityStore";
import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import { SemanticMemoryStore } from "../../src/core/semanticMemory";
import { FederatedDelegationGateway, ExecutionReceiptStore } from "../../src/core/advancedAutonomyRuntime";
import { createDefaultGovernors } from "../../src/governors/defaultGovernors";
import { MasterGovernor } from "../../src/governors/masterGovernor";
import { MockModelClient } from "../../src/models/mockModelClient";
import { PlannerOrgan } from "../../src/organs/planner";
import { ReflectionOrgan } from "../../src/organs/reflection";
import { ToolExecutorOrgan } from "../../src/organs/executor";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_5_6_9_live_check_output.json"
);

interface FederatedDecisionSnapshot {
  accepted: boolean;
  blockedBy: readonly string[];
  reasons: readonly string[];
  contractId: string;
}

interface ActionGovernanceTrace {
  actionId: string;
  actionType: string;
  approved: boolean;
  voteCount: number;
  blockedBy: readonly string[];
  decision:
    | {
      approved: boolean;
      yesVotes: number;
      noVotes: number;
      threshold: number;
    }
    | null;
}

export interface Stage65Checkpoint69Artifact {
  artifactHash: string;
  linkedFrom: {
    receiptHash?: string;
    traceId?: string;
  };
  generatedAt: string;
  command: string;
  contract: {
    externalAgentId: string;
    quoteId: string;
    maxQuotedCostUsd: number;
  };
  federationContractV1: {
    requestPayload: {
      quoteId: string;
      quotedCostUsd: number;
      goal: string;
      userInput: string;
      requestedAt: string;
    };
    responseMetadata: {
      accepted: boolean;
      contractId: string;
      blockedBy: readonly string[];
      reasons: readonly string[];
      taskId: string | null;
    };
    requestFingerprint: string;
    responseFingerprint: string;
    acceptedTaskId: string;
    normalizedTaskFingerprint: string;
    governancePathEvidenceRefs: readonly string[];
  };
  invalidAuthDecision: FederatedDecisionSnapshot;
  overQuoteDecision: FederatedDecisionSnapshot;
  validDecision: FederatedDecisionSnapshot;
  orchestratorRun: {
    taskId: string;
    taskGoal: string;
    taskGoalHasFederatedContractPrefix: boolean;
    approvedActionCount: number;
    blockedActionCount: number;
    actionGovernanceTrace: ActionGovernanceTrace[];
  };
  passCriteria: {
    invalidAuthBlocked: boolean;
    overQuoteBlocked: boolean;
    validRequestReachedGovernancePath: boolean;
    overallPass: boolean;
  };
}

interface TestBrainHarness {
  brain: BrainOrchestrator;
  receiptStore: ExecutionReceiptStore;
}

/**
 * Implements `hashSha256` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function hashSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Canonicalizes nested values by sorting object keys recursively for deterministic hashing.
 */
function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeForHash(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = canonicalizeForHash(record[key]);
        return accumulator;
      }, {});
  }
  return value;
}

/**
 * Serializes values into deterministic canonical JSON for hash/fingerprint derivation.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeForHash(value));
}

/**
 * Implements `toDecisionSnapshot` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function toDecisionSnapshot(decision: {
  accepted: boolean;
  blockedBy: readonly string[];
  reasons: readonly string[];
  contractId: string;
}): FederatedDecisionSnapshot {
  return {
    accepted: decision.accepted,
    blockedBy: decision.blockedBy,
    reasons: decision.reasons,
    contractId: decision.contractId
  };
}

/**
 * Implements `withTempRuntimeDir` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withTempRuntimeDir<T>(callback: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage6_5_6_9-"));
  try {
    return await callback(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Implements `buildTestBrain` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildTestBrain(tempDir: string): TestBrainHarness {
  const modelClient = new MockModelClient();
  const runtimeDir = path.join(tempDir, "runtime");
  const semanticMemoryPath = path.join(runtimeDir, "semantic_memory.json");
  const statePath = path.join(runtimeDir, "state.json");
  const governancePath = path.join(runtimeDir, "governance_memory.json");
  const personalityPath = path.join(runtimeDir, "personality_profile.json");
  const profilePath = path.join(runtimeDir, "profile_memory.secure.json");
  const receiptPath = path.join(runtimeDir, "execution_receipts.json");
  const receiptStore = new ExecutionReceiptStore(receiptPath);

  const brain = new BrainOrchestrator(
    DEFAULT_BRAIN_CONFIG,
    new PlannerOrgan(modelClient, new SemanticMemoryStore(semanticMemoryPath)),
    new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG),
    createDefaultGovernors(),
    new MasterGovernor(DEFAULT_BRAIN_CONFIG.governance.supermajorityThreshold),
    new StateStore(statePath),
    modelClient,
    new ReflectionOrgan(new SemanticMemoryStore(semanticMemoryPath), modelClient),
    new PersonalityStore(personalityPath),
    new GovernanceMemoryStore(governancePath),
    new ProfileMemoryStore(profilePath, Buffer.alloc(32, 23), 90),
    undefined,
    receiptStore
  );

  return { brain, receiptStore };
}

/**
 * Implements `runCheckpoint69LiveCheck` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runCheckpoint69LiveCheck(): Promise<Stage65Checkpoint69Artifact> {
  return withTempRuntimeDir(async (tempDir) => {
    const externalAgentId = "partner-agent-alpha";
    const sharedSecret = "stage6_5_secret_token";
    const quoteId = "quote_live_6_9_001";
    const maxQuotedCostUsd = 0.8;

    const gateway = new FederatedDelegationGateway([
      {
        externalAgentId,
        sharedSecretHash: hashSha256(sharedSecret),
        maxQuotedCostUsd
      }
    ]);

    const invalidAuthPayload = {
      quoteId,
      quotedCostUsd: 0.22,
      goal: "Create a delegated skill under governance.",
      userInput:
        "Create skill stage6_5_federated_gate with markdown instructions: " +
        "\"Record that federated delegation reached the governed acceptance path.\"",
      requestedAt: "2026-02-26T00:00:00.000Z"
    };
    const invalidAuthDecision = gateway.routeInboundRequest(
      invalidAuthPayload,
      externalAgentId,
      "wrong-stage6_5-secret"
    );

    const overQuotePayload = {
      quoteId: `${quoteId}_over`,
      quotedCostUsd: 1.25,
      goal: "Create a delegated skill under governance.",
      userInput:
        "Create skill stage6_5_federated_gate with markdown instructions: " +
        "\"Record that federated delegation reached the governed acceptance path.\"",
      requestedAt: "2026-02-26T00:00:05.000Z"
    };
    const overQuoteDecision = gateway.routeInboundRequest(
      overQuotePayload,
      externalAgentId,
      sharedSecret
    );

    const validRequestPayload = {
      quoteId,
      quotedCostUsd: 0.22,
      goal: "Create a delegated skill under governance.",
      userInput:
        "Create skill stage6_5_federated_gate with markdown instructions: " +
        "\"Record that federated delegation reached the governed acceptance path.\"",
      requestedAt: "2026-02-26T00:00:10.000Z"
    };
    const validDecision = gateway.routeInboundRequest(
      validRequestPayload,
      externalAgentId,
      sharedSecret
    );

    if (!validDecision.accepted || !validDecision.taskRequest) {
      throw new Error("Valid federated request was unexpectedly rejected.");
    }

    const { brain, receiptStore } = buildTestBrain(tempDir);
    const runResult = await brain.runTask(validDecision.taskRequest);
    const actionGovernanceTrace: ActionGovernanceTrace[] = runResult.actionResults.map((result) => ({
      actionId: result.action.id,
      actionType: result.action.type,
      approved: result.approved,
      voteCount: result.votes.length,
      blockedBy: result.blockedBy,
      decision: result.decision
        ? {
          approved: result.decision.approved,
          yesVotes: result.decision.yesVotes,
          noVotes: result.decision.noVotes,
          threshold: result.decision.threshold
        }
        : null
    }));
    const receiptDocument = await receiptStore.load();
    const receiptHashes = receiptDocument.receipts
      .filter((receipt) => receipt.taskId === runResult.task.id)
      .map((receipt) => receipt.receiptHash);
    const governancePathEvidenceRefs =
      receiptHashes.length > 0
        ? receiptHashes
        : actionGovernanceTrace.map((trace) => `trace:${trace.actionId}`);

    const invalidAuthBlocked = invalidAuthDecision.blockedBy.includes("FEDERATED_AUTH_FAILED");
    const overQuoteBlocked = overQuoteDecision.blockedBy.includes("FEDERATED_QUOTE_EXCEEDED");
    const validRequestReachedGovernancePath = actionGovernanceTrace.some(
      (trace) => trace.actionType === "create_skill" && trace.voteCount > 0
    );
    const overallPass = invalidAuthBlocked && overQuoteBlocked && validRequestReachedGovernancePath;
    const responseMetadata = {
      accepted: validDecision.accepted,
      contractId: validDecision.contractId,
      blockedBy: validDecision.blockedBy,
      reasons: validDecision.reasons,
      taskId: validDecision.taskRequest?.id ?? null
    };
    const baseArtifact = {
      generatedAt: new Date().toISOString(),
      command: "npm run test:stage6_5:live:6_9",
      contract: {
        externalAgentId,
        quoteId,
        maxQuotedCostUsd
      },
      federationContractV1: {
        requestPayload: validRequestPayload,
        responseMetadata,
        requestFingerprint: hashSha256(canonicalJson(validRequestPayload)),
        responseFingerprint: hashSha256(canonicalJson(responseMetadata)),
        acceptedTaskId: validDecision.taskRequest.id,
        normalizedTaskFingerprint: hashSha256(canonicalJson(validDecision.taskRequest)),
        governancePathEvidenceRefs
      },
      invalidAuthDecision: toDecisionSnapshot(invalidAuthDecision),
      overQuoteDecision: toDecisionSnapshot(overQuoteDecision),
      validDecision: toDecisionSnapshot(validDecision),
      orchestratorRun: {
        taskId: runResult.task.id,
        taskGoal: runResult.task.goal,
        taskGoalHasFederatedContractPrefix: /\[FederatedContract partner-agent-alpha:quote_live_6_9_001\]/i.test(
          runResult.task.goal
        ),
        approvedActionCount: runResult.actionResults.filter((result) => result.approved).length,
        blockedActionCount: runResult.actionResults.filter((result) => !result.approved).length,
        actionGovernanceTrace
      },
      passCriteria: {
        invalidAuthBlocked,
        overQuoteBlocked,
        validRequestReachedGovernancePath,
        overallPass
      }
    };
    const linkedFrom =
      receiptHashes.length > 0
        ? { receiptHash: receiptHashes[0] }
        : { traceId: actionGovernanceTrace[0]?.actionId ?? runResult.task.id };

    return {
      ...baseArtifact,
      artifactHash: hashSha256(canonicalJson(baseArtifact)),
      linkedFrom
    };
  });
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runCheckpoint69LiveCheck();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, JSON.stringify(artifact, null, 2), "utf8");

  console.log(`Stage 6.5 checkpoint 6.9 live check artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
