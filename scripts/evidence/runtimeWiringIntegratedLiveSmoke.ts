/**
 * @fileoverview Runs one integrated runtime-wiring live smoke that exercises cross-module production paths and writes a consolidated artifact.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEmptyConversationStackV1 } from "../../src/core/stage6_86ConversationStack";
import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { DistillerMergeLedgerStore } from "../../src/core/distillerLedger";
import { EntityGraphStore } from "../../src/core/entityGraphStore";
import { makeId } from "../../src/core/ids";
import { JudgmentPatternStore } from "../../src/core/judgmentPatterns";
import { BrainOrchestrator } from "../../src/core/orchestrator";
import { PersonalityStore } from "../../src/core/personalityStore";
import { SatelliteCloneCoordinator } from "../../src/core/satelliteClone";
import { SemanticMemoryStore } from "../../src/core/semanticMemory";
import { StateStore } from "../../src/core/stateStore";
import { TaskRequest } from "../../src/core/types";
import { WorkflowLearningStore } from "../../src/core/workflowLearningStore";
import { createDefaultGovernors } from "../../src/governors/defaultGovernors";
import { MasterGovernor } from "../../src/governors/masterGovernor";
import { MockModelClient } from "../../src/models/mockModelClient";
import {
  GovernorModelOutput,
  PlannerModelOutput,
  StructuredCompletionRequest
} from "../../src/models/types";
import { ToolExecutorOrgan } from "../../src/organs/executor";
import { PlannerOrgan } from "../../src/organs/planner";
import { ReflectionOrgan } from "../../src/organs/reflection";
import { runCliFromArgv } from "../../src/index";
import { maybeRecordInboundEntityGraphMutation, createDynamicPulseEntityGraphGetter } from "../../src/interfaces/entityGraphRuntime";
import { FederatedHttpClient } from "../../src/interfaces/federatedClient";
import { createFederationRuntimeConfigFromEnv, startFederationRuntime } from "../../src/interfaces/federationRuntime";
import { GovernanceMemoryStore } from "../../src/core/governanceMemory";
import { ConversationSession } from "../../src/interfaces/sessionStore";
import { renderPulseUserFacingSummaryV1 } from "../../src/interfaces/pulseUxRuntime";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/runtime_wiring_integrated_live_smoke_report.json"
);
const COMMAND_NAME = "npm run test:runtime_wiring:integrated_live_smoke";
const FEDERATION_AGENT_ID = "runtime_wiring_integrated_smoke_agent";
const FEDERATION_SECRET = "runtime_wiring_integrated_smoke_secret";

interface CheckResult {
  id: string;
  pass: boolean;
  detail: string;
}

interface IntegratedLiveSmokeArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL";
  checks: readonly CheckResult[];
  summary: {
    totalChecks: number;
    passedChecks: number;
    failedCheckIds: readonly string[];
  };
  runtimeSnapshots: {
    integratedArtifactPath: string;
    lastMemoryMutationReceiptHash: string | null;
    executionReceiptCount: number;
    entityCount: number;
    edgeCount: number;
  };
  passCriteria: {
    overallPass: boolean;
  };
}

/**
 * Applies temporary environment overrides for one async callback and always restores previous values.
 */
async function withEnvOverrides<T>(
  overrides: Partial<Record<string, string | undefined>>,
  callback: () => Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Executes callback in a temporary working directory and performs deterministic cleanup.
 */
async function withTempWorkingDirectory<T>(callback: (tempDir: string) => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbb-runtime-wiring-integrated-"));
  process.chdir(tempDir);
  try {
    return await callback(tempDir);
  } finally {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Computes SHA-256 digest for deterministic federation fixture contracts.
 */
function hashSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Creates deterministic task fixture with optional clone agent id.
 */
function buildTask(userInput: string, agentId = "main"): TaskRequest {
  return {
    id: makeId("task"),
    agentId,
    goal: "Run integrated runtime wiring validation.",
    userInput,
    createdAt: new Date().toISOString()
  };
}

/**
 * Parses JSON object payload from model prompt text when available.
 */
function parsePromptObject(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Deterministic fallback to empty object.
  }
  return {};
}

class IntegratedPlannerModelClient extends MockModelClient {
  /**
   * Returns deterministic integrated-scenario planner actions and permissive governor votes.
   */
  override async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName === "planner_v1") {
      const payload = parsePromptObject(request.userPrompt);
      const userInput =
        typeof payload.userInput === "string" ? payload.userInput.toLowerCase() : request.userPrompt.toLowerCase();

      if (userInput.includes("[integration:core]")) {
        const actions: PlannerModelOutput["actions"] = [
          {
            type: "network_write",
            description: "Attempt unsupported connector update to trigger Stage 6.75 policy block.",
            params: {
              endpoint: "https://example.com/calendar",
              connector: "calendar",
              operation: "update",
              approvalId: "approval_integrated_block"
            }
          },
          {
            type: "memory_mutation",
            description: "Apply Stage 6.86 pulse-state memory mutation with durable receipt linkage.",
            params: {
              store: "pulse_state",
              operation: "upsert",
              mutationPath: ["emittedTodayCount"],
              payload: {
                value: 1
              },
              evidenceRefs: ["trace:integrated:memory_mutation"]
            }
          },
          {
            type: "pulse_emit",
            description: "Emit Stage 6.86 bridge question for deterministic relationship clarification.",
            params: {
              kind: "bridge_question",
              reasonCode: "RELATIONSHIP_CLARIFICATION",
              threadKey: "thread_relationship",
              entityRefs: ["entity_alpha", "entity_beta"],
              evidenceRefs: ["trace:integrated:bridge_emit"]
            }
          },
          {
            type: "pulse_emit",
            description: "Resolve emitted Stage 6.86 bridge question as confirmed friend relation.",
            params: {
              kind: "bridge_question",
              reasonCode: "RELATIONSHIP_CLARIFICATION",
              answerKind: "confirmed",
              relationType: "friend",
              evidenceRefs: ["trace:integrated:bridge_resolve"]
            }
          }
        ];
        return {
          plannerNotes: "integrated runtime wiring core plan",
          actions
        } as T;
      }

      if (userInput.includes("[integration:learning]")) {
        return {
          plannerNotes: "integrated learning signal plan",
          actions: [
            {
              type: "respond",
              description: "Provide a deterministic summary response.",
              params: {
                message: "Integrated learning check response."
              }
            }
          ]
        } as T;
      }
    }

    if (request.schemaName === "governor_v1") {
      const approveVote: GovernorModelOutput = {
        approve: true,
        reason: "allow deterministic integrated runtime wiring coverage",
        confidence: 0.99
      };
      return approveVote as T;
    }

    return super.completeJson<T>(request);
  }
}

interface IntegratedBrainBundle {
  brain: BrainOrchestrator;
  distillerLedgerStore: DistillerMergeLedgerStore;
  workflowStore: WorkflowLearningStore;
  judgmentStore: JudgmentPatternStore;
}

/**
 * Builds one orchestrator bundle wired to production modules for integrated checks.
 */
function createIntegratedBrainBundle(tempDir: string): IntegratedBrainBundle {
  const config = {
    ...DEFAULT_BRAIN_CONFIG,
    permissions: {
      ...DEFAULT_BRAIN_CONFIG.permissions,
      allowNetworkWriteAction: true
    }
  };
  const modelClient = new IntegratedPlannerModelClient();
  const memoryStore = new SemanticMemoryStore(path.join(tempDir, "runtime", "semantic_memory.json"));
  const sqlitePath = path.join(tempDir, "runtime", "integrated_ledgers.sqlite");
  const workflowStore = new WorkflowLearningStore(path.join(tempDir, "runtime", "workflow_learning.json"), {
    backend: "sqlite",
    sqlitePath,
    exportJsonOnWrite: true
  });
  const judgmentStore = new JudgmentPatternStore(path.join(tempDir, "runtime", "judgment_patterns.json"), {
    backend: "sqlite",
    sqlitePath,
    exportJsonOnWrite: true
  });
  const distillerLedgerStore = new DistillerMergeLedgerStore(
    path.join(tempDir, "runtime", "distiller_rejection_ledger.json"),
    {
      backend: "sqlite",
      sqlitePath,
      exportJsonOnWrite: true
    }
  );
  const reflection = new ReflectionOrgan(
    memoryStore,
    modelClient,
    undefined,
    {
      distillerLedgerStore,
      satelliteCloneCoordinator: new SatelliteCloneCoordinator({
        maxClonesPerTask: config.limits.maxSubagentsPerTask,
        maxDepth: config.limits.maxSubagentDepth,
        maxBudgetUsd: 1
      })
    }
  );

  const brain = new BrainOrchestrator(
    config,
    new PlannerOrgan(modelClient, memoryStore),
    new ToolExecutorOrgan(config),
    createDefaultGovernors(),
    new MasterGovernor(config.governance.supermajorityThreshold),
    new StateStore(path.join(tempDir, "runtime", "state.json")),
    modelClient,
    reflection,
    new PersonalityStore(path.join(tempDir, "runtime", "personality.json")),
    new GovernanceMemoryStore(path.join(tempDir, "runtime", "governance_memory.json")),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    workflowStore,
    judgmentStore
  );

  return {
    brain,
    distillerLedgerStore,
    workflowStore,
    judgmentStore
  };
}

/**
 * Creates a deterministic session fixture for Stage 6.86.H pulse UX rendering checks.
 */
function buildPulseUxSession(observedAt: string): ConversationSession {
  const stack = createEmptyConversationStackV1(observedAt);
  return {
    conversationId: "telegram:chat-integrated:user-1",
    userId: "user-1",
    username: "runtime_owner",
    conversationVisibility: "private",
    sessionSchemaVersion: "v2",
    conversationStack: {
      ...stack,
      activeThreadKey: "thread_relationship",
      threads: [
        {
          threadKey: "thread_relationship",
          topicKey: "topic_relationship",
          topicLabel: "Relationship follow-up",
          state: "active",
          resumeHint: "Resume relationship clarification.",
          openLoops: [],
          lastTouchedAt: observedAt
        },
        {
          threadKey: "thread_archive",
          topicKey: "topic_archive",
          topicLabel: "Archive backlog",
          state: "paused",
          resumeHint: "Review archived notes.",
          openLoops: [],
          lastTouchedAt: observedAt
        }
      ]
    },
    updatedAt: observedAt,
    activeProposal: null,
    runningJobId: null,
    queuedJobs: [],
    recentJobs: [],
    conversationTurns: [],
    agentPulse: {
      optIn: true,
      mode: "private",
      routeStrategy: "last_private_used",
      lastPulseSentAt: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: null,
      lastDecisionCode: "NOT_EVALUATED",
      lastEvaluatedAt: null,
      lastContextualLexicalEvidence: null,
      recentEmissions: []
    }
  };
}

/**
 * Runs the integrated live smoke and returns artifact payload.
 */
async function runIntegratedLiveSmoke(): Promise<IntegratedLiveSmokeArtifact> {
  return withTempWorkingDirectory(async (tempDir) => {
    const checks: CheckResult[] = [];

    await withEnvOverrides(
      {
        BRAIN_MODEL_BACKEND: "mock"
      },
      async () => {
        const cliExitCode = await runCliFromArgv(["integrated runtime entrypoint summary"]);
        checks.push({
          id: "runtime_entrypoint_default",
          pass: cliExitCode === 0,
          detail:
            cliExitCode === 0
              ? "runCliFromArgv default task path returned success."
              : `runCliFromArgv default task path returned ${cliExitCode}.`
        });
      }
    );

    const daemonDeniedExitCode = await withEnvOverrides(
      {
        BRAIN_MODEL_BACKEND: "mock",
        BRAIN_ALLOW_DAEMON_MODE: undefined,
        BRAIN_MAX_AUTONOMOUS_ITERATIONS: "1",
        BRAIN_MAX_DAEMON_GOAL_ROLLOVERS: "1"
      },
      async () => runCliFromArgv(["--daemon", "integrated daemon denied"])
    );
    checks.push({
      id: "daemon_latch_denied",
      pass: daemonDeniedExitCode === 1,
      detail:
        daemonDeniedExitCode === 1
          ? "Daemon mode failed closed without explicit latch."
          : `Expected daemon deny exit 1 but observed ${daemonDeniedExitCode}.`
    });

    const daemonAllowedExitCode = await withEnvOverrides(
      {
        BRAIN_MODEL_BACKEND: "mock",
        BRAIN_ALLOW_DAEMON_MODE: "true",
        BRAIN_MAX_AUTONOMOUS_ITERATIONS: "1",
        BRAIN_MAX_DAEMON_GOAL_ROLLOVERS: "1"
      },
      async () => runCliFromArgv(["--daemon", "integrated daemon done"])
    );
    checks.push({
      id: "daemon_latch_allowed_bounded",
      pass: daemonAllowedExitCode === 0,
      detail:
        daemonAllowedExitCode === 0
          ? "Daemon mode succeeded with explicit latch and bounded rollover."
          : `Expected daemon success exit 0 but observed ${daemonAllowedExitCode}.`
    });

    const federationSummary = await withEnvOverrides(
      {
        BRAIN_MODEL_BACKEND: "mock"
      },
      async () => {
        const config = createFederationRuntimeConfigFromEnv({
          BRAIN_ENABLE_FEDERATION_RUNTIME: "true",
          BRAIN_FEDERATION_HOST: "127.0.0.1",
          BRAIN_FEDERATION_PORT: "0",
          BRAIN_FEDERATION_RESULT_STORE_PATH: path.join(tempDir, "runtime", "federated_results.json"),
          BRAIN_FEDERATION_CONTRACTS_JSON: JSON.stringify([
            {
              externalAgentId: FEDERATION_AGENT_ID,
              sharedSecretHash: hashSha256(FEDERATION_SECRET),
              maxQuotedCostUsd: 3
            }
          ])
        });
        const runtime = await startFederationRuntime(config);
        try {
          const address = runtime.getAddress();
          if (!address) {
            return {
              accepted: false,
              terminal: false,
              detail: "Federation runtime address was not available."
            };
          }

          const client = new FederatedHttpClient({
            baseUrl: `http://${address.host}:${address.port}`,
            timeoutMs: 10_000,
            auth: {
              externalAgentId: FEDERATION_AGENT_ID,
              sharedSecret: FEDERATION_SECRET
            }
          });
          const delegated = await client.delegate({
            quoteId: "integrated_runtime_federation_quote_001",
            quotedCostUsd: 1,
            goal: "Return one safe integrated smoke response.",
            userInput: "Say hello from integrated federation path."
          });
          const poll = delegated.taskId
            ? await client.awaitResult(delegated.taskId, {
              pollIntervalMs: 50,
              timeoutMs: 10_000
            })
            : { ok: false, result: null, error: "missing delegated task id" };

          const accepted = delegated.ok && Boolean(delegated.taskId);
          const status = poll.result?.status ?? "unknown";
          return {
            accepted,
            terminal: status === "completed" || status === "failed",
            detail: `delegateStatus=${delegated.httpStatus}; resultStatus=${status}`
          };
        } finally {
          await runtime.stop();
        }
      }
    );
    checks.push({
      id: "federation_inbound_runtime",
      pass: federationSummary.accepted && federationSummary.terminal,
      detail: federationSummary.detail
    });

    const integratedBundle = createIntegratedBrainBundle(tempDir);
    const coreRunResult = await integratedBundle.brain.runTask(
      buildTask(
        "[integration:core] Delete stale endpoint, run network connector update, and execute memory_mutation/pulse_emit bridge flow.",
        "atlas-1001"
      )
    );

    checks.push({
      id: "planner_first_principles_required",
      pass: coreRunResult.plan.firstPrinciples?.required === true,
      detail: coreRunResult.plan.firstPrinciples?.required
        ? `First-principles required with reasons: ${coreRunResult.plan.firstPrinciples.triggerReasons.join(", ")}`
        : "First-principles packet was not required."
    });
    checks.push({
      id: "failure_taxonomy_constraint",
      pass: coreRunResult.failureTaxonomy?.failureCode === "constraint_blocked",
      detail:
        coreRunResult.failureTaxonomy
          ? `failureCategory=${coreRunResult.failureTaxonomy.failureCategory}; failureCode=${coreRunResult.failureTaxonomy.failureCode}`
          : "Failure taxonomy missing."
    });
    checks.push({
      id: "stage6_75_connector_policy",
      pass:
        coreRunResult.actionResults.some((entry) =>
          entry.blockedBy.includes("CONNECTOR_OPERATION_NOT_SUPPORTED_IN_STAGE_6_75")
        ),
      detail: "Expected Stage 6.75 connector policy block for unsupported update operation."
    });
    checks.push({
      id: "stage6_86_memory_mutation_runtime",
      pass:
        coreRunResult.actionResults.some(
          (entry) => entry.approved && typeof entry.executionMetadata?.stage686MutationId === "string"
        ),
      detail: "Expected Stage 6.86 mutation execution metadata with deterministic mutation id."
    });
    checks.push({
      id: "stage6_86_pulse_emit_runtime",
      pass:
        coreRunResult.actionResults.filter(
          (entry) =>
            entry.approved &&
            entry.action.type === "pulse_emit" &&
            entry.executionMetadata?.stage686PulseKind === "bridge_question"
        ).length >= 2,
      detail: "Expected Stage 6.86 bridge-question emit + resolve pulse actions."
    });

    const distillerLedger = await integratedBundle.distillerLedgerStore.load();
    checks.push({
      id: "distiller_ledger_path",
      pass: distillerLedger.entries.some((entry) => entry.cloneId === "atlas-1001"),
      detail: `Distiller entries observed: ${distillerLedger.entries.length}`
    });

    await integratedBundle.brain.runTask(
      buildTask("[integration:learning] Provide concise deterministic release readiness summary.")
    );
    const learningReplayResult = await integratedBundle.brain.runTask(
      buildTask("[integration:learning] Provide concise deterministic release readiness summary.")
    );
    checks.push({
      id: "workflow_judgment_learning_reuse",
      pass:
        (learningReplayResult.plan.learningHints?.workflowHintCount ?? 0) >= 1 &&
        (learningReplayResult.plan.learningHints?.judgmentHintCount ?? 0) >= 1,
      detail:
        `workflowHints=${learningReplayResult.plan.learningHints?.workflowHintCount ?? 0}; ` +
        `judgmentHints=${learningReplayResult.plan.learningHints?.judgmentHintCount ?? 0}`
    });

    const runtimeStatePath = path.resolve(process.cwd(), "runtime/stage6_86_runtime_state.json");
    const entityGraphPath = path.resolve(process.cwd(), "runtime/entity_graph.json");
    const executionReceiptsPath = path.resolve(process.cwd(), "runtime/execution_receipts.json");
    const runtimeStateRaw = await readFile(runtimeStatePath, "utf8");
    const entityGraphRaw = await readFile(entityGraphPath, "utf8");
    const executionReceiptsRaw = await readFile(executionReceiptsPath, "utf8");

    const runtimeState = JSON.parse(runtimeStateRaw) as { lastMemoryMutationReceiptHash?: unknown };
    const entityGraph = JSON.parse(entityGraphRaw) as {
      entities?: unknown[];
      edges?: Array<{
        sourceEntityKey?: unknown;
        targetEntityKey?: unknown;
        relationType?: unknown;
      }>;
    };
    const executionReceipts = JSON.parse(executionReceiptsRaw) as { receipts?: unknown[] };

    checks.push({
      id: "durable_runtime_state_receipt_linkage",
      pass:
        typeof runtimeState.lastMemoryMutationReceiptHash === "string" &&
        runtimeState.lastMemoryMutationReceiptHash.length > 0,
      detail:
        typeof runtimeState.lastMemoryMutationReceiptHash === "string"
          ? `lastMemoryMutationReceiptHash=${runtimeState.lastMemoryMutationReceiptHash}`
          : "Missing lastMemoryMutationReceiptHash."
    });
    checks.push({
      id: "execution_receipt_chain_persisted",
      pass: Array.isArray(executionReceipts.receipts) && executionReceipts.receipts.length > 0,
      detail:
        Array.isArray(executionReceipts.receipts)
          ? `executionReceiptCount=${executionReceipts.receipts.length}`
          : "Execution receipt document did not contain receipts array."
    });
    const hasFriendRelation =
      entityGraph.edges?.some((edge) => {
        if (edge.relationType !== "friend") {
          return false;
        }
        const pair = [edge.sourceEntityKey, edge.targetEntityKey]
          .filter((entry): entry is string => typeof entry === "string")
          .sort((left, right) => left.localeCompare(right));
        return pair.length === 2 && pair[0] === "entity_alpha" && pair[1] === "entity_beta";
      }) ?? false;
    checks.push({
      id: "stage6_86_bridge_relation_persisted",
      pass: hasFriendRelation,
      detail: hasFriendRelation
        ? "Bridge resolution promoted deterministic friend relation in entity graph."
        : "Expected friend relation edge was not found in entity graph."
    });

    const sharedEntityGraphStore = new EntityGraphStore(undefined, {
      backend: DEFAULT_BRAIN_CONFIG.persistence.ledgerBackend,
      sqlitePath: DEFAULT_BRAIN_CONFIG.persistence.ledgerSqlitePath,
      exportJsonOnWrite: DEFAULT_BRAIN_CONFIG.persistence.exportJsonOnWrite
    });
    const beforeGraph = await sharedEntityGraphStore.getGraph();
    const writeResult = await maybeRecordInboundEntityGraphMutation(
      sharedEntityGraphStore,
      true,
      {
        provider: "telegram",
        conversationId: "chat-integrated",
        eventId: "event-integrated-1",
        text: "Alex works at OpenBigBrain and mentors Sam.",
        observedAt: new Date().toISOString()
      }
    );
    const graphGetter = createDynamicPulseEntityGraphGetter(true, sharedEntityGraphStore);
    const afterGraph = graphGetter ? await graphGetter() : beforeGraph;
    checks.push({
      id: "entity_graph_write_read_feedback",
      pass: writeResult && afterGraph.entities.length >= beforeGraph.entities.length,
      detail:
        `writeResult=${writeResult}; beforeEntities=${beforeGraph.entities.length}; ` +
        `afterEntities=${afterGraph.entities.length}`
    });

    const pulseUxRendered = renderPulseUserFacingSummaryV1(
      buildPulseUxSession(new Date().toISOString()),
      "Agent Pulse request\nSignal type: OPEN_LOOP_RESUME",
      "Would you like to continue the relationship thread?",
      new Date().toISOString()
    );
    checks.push({
      id: "stage6_86_ux_rendering_path",
      pass: /Continuity pulse:/i.test(pulseUxRendered) && /Thread context:/i.test(pulseUxRendered),
      detail: pulseUxRendered.slice(0, 240)
    });

    const passedChecks = checks.filter((check) => check.pass).length;
    const failedCheckIds = checks.filter((check) => !check.pass).map((check) => check.id);
    const overallPass = failedCheckIds.length === 0;

    const lastMemoryMutationReceiptHash =
      typeof runtimeState.lastMemoryMutationReceiptHash === "string"
        ? runtimeState.lastMemoryMutationReceiptHash
        : null;
    const executionReceiptCount = Array.isArray(executionReceipts.receipts)
      ? executionReceipts.receipts.length
      : 0;
    const entityCount = Array.isArray(entityGraph.entities) ? entityGraph.entities.length : 0;
    const edgeCount = Array.isArray(entityGraph.edges) ? entityGraph.edges.length : 0;

    return {
      generatedAt: new Date().toISOString(),
      command: COMMAND_NAME,
      status: overallPass ? "PASS" : "FAIL",
      checks,
      summary: {
        totalChecks: checks.length,
        passedChecks,
        failedCheckIds
      },
      runtimeSnapshots: {
        integratedArtifactPath: ARTIFACT_PATH,
        lastMemoryMutationReceiptHash,
        executionReceiptCount,
        entityCount,
        edgeCount
      },
      passCriteria: {
        overallPass
      }
    };
  });
}

/**
 * Script entrypoint that writes integrated artifact and exits non-zero on failed criteria.
 */
async function main(): Promise<void> {
  const artifact = await runIntegratedLiveSmoke();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, JSON.stringify(artifact, null, 2), "utf8");

  console.log(`Integrated runtime wiring live smoke artifact: ${ARTIFACT_PATH}`);
  console.log(`Status: ${artifact.status}`);

  if (!artifact.passCriteria.overallPass) {
    for (const failed of artifact.summary.failedCheckIds) {
      console.error(`- failed check: ${failed}`);
    }
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
