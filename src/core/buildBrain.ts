/**
 * @fileoverview Composes the default brain instance by wiring config, organs, governors, model client, and state store.
 */

import path from "node:path";

import { createBrainConfigFromEnv } from "./config";
import { BrainOrchestrator } from "./orchestrator";
import { StateStore } from "./stateStore";
import { createDefaultGovernors } from "../governors/defaultGovernors";
import { MasterGovernor } from "../governors/masterGovernor";
import { createModelClientFromEnv } from "../models/createModelClient";
import { PlannerOrgan } from "../organs/planner";
import { ReflectionOrgan } from "../organs/reflection";
import { ToolExecutorOrgan } from "../organs/executor";
import { MemoryBrokerOrgan } from "../organs/memoryBroker";
import { LanguageUnderstandingOrgan } from "../organs/languageUnderstanding/episodeExtraction";
import { BrowserSessionRegistry } from "../organs/liveRun/browserSessionRegistry";
import { ManagedProcessRegistry } from "../organs/liveRun/managedProcessRegistry";
import { SkillRegistryStore } from "../organs/skillRegistry/skillRegistryStore";
import { ExecutionReceiptStore } from "./advancedAutonomyRuntime";
import { SemanticMemoryStore } from "./semanticMemory";
import { PersonalityStore } from "./personalityStore";
import { GovernanceMemoryStore } from "./governanceMemory";
import { ProfileMemoryStore } from "./profileMemoryStore";
import { JudgmentPatternStore } from "./judgmentPatterns";
import { SqlitePlannerFailureStore } from "./plannerFailureStore";
import { DistillerMergeLedgerStore } from "./distillerLedger";
import { EmbeddingProvider, NoOpEmbeddingProvider } from "./embeddingProvider";
import { OnnxEmbeddingProvider } from "./onnxEmbeddingProvider";
import { SatelliteCloneCoordinator } from "./satelliteClone";
import { SqliteVectorStore } from "./vectorStore";
import { WorkflowLearningStore } from "./workflowLearningStore";
import { BrainConfig } from "./config";
import { resolveUserOwnedPathHints } from "../organs/plannerPolicy/userOwnedPathHints";
import type { ModelClient } from "../models/types";

export interface SharedBrainRuntimeDependencies {
  readonly baseConfig: BrainConfig;
  readonly memoryStore: SemanticMemoryStore;
  readonly plannerFailureStore: SqlitePlannerFailureStore;
  readonly executor: ToolExecutorOrgan;
  readonly governors: ReturnType<typeof createDefaultGovernors>;
  readonly masterGovernor: MasterGovernor;
  readonly stateStore: StateStore;
  readonly personalityStore: PersonalityStore;
  readonly governanceMemoryStore: GovernanceMemoryStore;
  readonly executionReceiptStore: ExecutionReceiptStore;
  readonly workflowLearningStore: WorkflowLearningStore;
  readonly judgmentPatternStore: JudgmentPatternStore;
  readonly profileMemoryStore: ProfileMemoryStore | undefined;
  readonly skillRegistryStore: SkillRegistryStore;
  readonly distillerLedgerStore: DistillerMergeLedgerStore;
  readonly satelliteCloneCoordinator: SatelliteCloneCoordinator;
}

export interface BuiltBrainRuntime {
  readonly config: BrainConfig;
  readonly modelClient: ModelClient;
  readonly brain: BrainOrchestrator;
}

/**
 * Builds embedding stack for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of embedding stack consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `BrainConfig` (import `BrainConfig`) from `./config`.
 * - Uses `EmbeddingProvider` (import `EmbeddingProvider`) from `./embeddingProvider`.
 * - Uses `NoOpEmbeddingProvider` (import `NoOpEmbeddingProvider`) from `./embeddingProvider`.
 * - Uses `OnnxEmbeddingProvider` (import `OnnxEmbeddingProvider`) from `./onnxEmbeddingProvider`.
 * - Uses `SqliteVectorStore` (import `SqliteVectorStore`) from `./vectorStore`.
 *
 * @param config - Configuration or policy settings applied here.
 * @returns Computed `{
  embeddingProvider: EmbeddingProvider;
  vectorStore: SqliteVectorStore | null;
}` result.
 */
function buildEmbeddingStack(config: BrainConfig): {
  embeddingProvider: EmbeddingProvider;
  vectorStore: SqliteVectorStore | null;
} {
  if (!config.embeddings.enabled) {
    return {
      embeddingProvider: new NoOpEmbeddingProvider(),
      vectorStore: null
    };
  }

  const embeddingProvider = new OnnxEmbeddingProvider(config.embeddings.modelDir);
  embeddingProvider.initialize().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[Embeddings] Failed to initialize ONNX provider at "${config.embeddings.modelDir}". ` +
      `Falling back to keyword-only retrieval for this process. Reason: ${message}`
    );
  });

  return {
    embeddingProvider,
    vectorStore: new SqliteVectorStore(config.embeddings.vectorSqlitePath)
  };
}

/**
 * Resolves the live-run runtime directory for browser/process snapshot persistence.
 *
 * **Why it exists:**
 * Live-smoke proofs need to isolate browser and managed-process snapshots so one restart or
 * timeout cannot poison another governed run.
 *
 * **What it talks to:**
 * - Reads `process.env.BRAIN_LIVE_RUN_RUNTIME_PATH` from the current Node.js environment.
 * - Uses `path.resolve` (import `default`) from `node:path`.
 *
 * @returns Absolute runtime directory path for live-run snapshot storage.
 */
function resolveLiveRunRuntimePathFromEnv(): string {
  const configuredRuntimePath = process.env.BRAIN_LIVE_RUN_RUNTIME_PATH?.trim();
  return configuredRuntimePath && configuredRuntimePath.length > 0
    ? path.resolve(configuredRuntimePath)
    : path.resolve(process.cwd(), "runtime/live_run");
}

/**
 * Builds default brain for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of default brain consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `createDefaultGovernors` (import `createDefaultGovernors`) from `../governors/defaultGovernors`.
 * - Uses `MasterGovernor` (import `MasterGovernor`) from `../governors/masterGovernor`.
 * - Uses `createModelClientFromEnv` (import `createModelClientFromEnv`) from `../models/createModelClient`.
 * - Uses `ToolExecutorOrgan` (import `ToolExecutorOrgan`) from `../organs/executor`.
 * - Uses `MemoryBrokerOrgan` (import `MemoryBrokerOrgan`) from `../organs/memoryBroker`.
 * - Uses `PlannerOrgan` (import `PlannerOrgan`) from `../organs/planner`.
 * - Additional imported collaborators are also used in this function body.
 * @returns Computed `BrainOrchestrator` result.
 */
/**
 * Builds the shared runtime dependencies reused across backend-specific brain instances.
 *
 * **Why it exists:**
 * Interface per-session backend overrides still need one shared live-run core so browser/process
 * registries, ledgers, and executor state stay coherent across conversations.
 *
 * **What it talks to:**
 * - Uses `createBrainConfigFromEnv` from `./config`.
 * - Uses `ToolExecutorOrgan` from `../organs/executor`.
 * - Uses the stable persistence stores in `src/core/`.
 *
 * @param env - Environment map used for baseline runtime construction.
 * @returns Shared runtime dependencies that can be paired with multiple backend/model clients.
 */
export function createSharedBrainRuntimeDependencies(
  env: NodeJS.ProcessEnv = process.env
): SharedBrainRuntimeDependencies {
  const baseConfig = createBrainConfigFromEnv(env);
  const embeddingStack = buildEmbeddingStack(baseConfig);
  const memoryStore = new SemanticMemoryStore(
    undefined,
    embeddingStack.embeddingProvider,
    embeddingStack.vectorStore ?? undefined
  );
  const plannerFailureStore = new SqlitePlannerFailureStore(
    baseConfig.persistence.ledgerSqlitePath
  );
  const liveRunRuntimePath = resolveLiveRunRuntimePathFromEnv();
  const executor = new ToolExecutorOrgan(
    baseConfig,
    undefined,
    new ManagedProcessRegistry({
      snapshotPath: path.join(liveRunRuntimePath, "managed_processes.json")
    }),
    undefined,
    new BrowserSessionRegistry({
      snapshotPath: path.join(liveRunRuntimePath, "browser_sessions.json")
    })
  );
  const governors = createDefaultGovernors();
  const masterGovernor = new MasterGovernor(baseConfig.governance.supermajorityThreshold);
  const stateStore = new StateStore();
  const personalityStore = new PersonalityStore();
  const governanceMemoryStore = new GovernanceMemoryStore(undefined, {
    backend: baseConfig.persistence.ledgerBackend,
    sqlitePath: baseConfig.persistence.ledgerSqlitePath,
    exportJsonOnWrite: baseConfig.persistence.exportJsonOnWrite
  });
  const executionReceiptStore = new ExecutionReceiptStore(undefined, {
    backend: baseConfig.persistence.ledgerBackend,
    sqlitePath: baseConfig.persistence.ledgerSqlitePath,
    exportJsonOnWrite: baseConfig.persistence.exportJsonOnWrite
  });
  const workflowLearningStore = new WorkflowLearningStore(undefined, {
    backend: baseConfig.persistence.ledgerBackend,
    sqlitePath: baseConfig.persistence.ledgerSqlitePath,
    exportJsonOnWrite: baseConfig.persistence.exportJsonOnWrite
  });
  const skillRegistryStore = new SkillRegistryStore(
    path.resolve(process.cwd(), "runtime/skills")
  );
  const distillerLedgerStore = new DistillerMergeLedgerStore(undefined, {
    backend: baseConfig.persistence.ledgerBackend,
    sqlitePath: baseConfig.persistence.ledgerSqlitePath,
    exportJsonOnWrite: baseConfig.persistence.exportJsonOnWrite
  });
  const satelliteCloneCoordinator = new SatelliteCloneCoordinator({
    maxClonesPerTask: baseConfig.limits.maxSubagentsPerTask,
    maxDepth: baseConfig.limits.maxSubagentDepth,
    maxBudgetUsd: 1
  });
  const judgmentPatternStore = new JudgmentPatternStore(undefined, {
    backend: baseConfig.persistence.ledgerBackend,
    sqlitePath: baseConfig.persistence.ledgerSqlitePath,
    exportJsonOnWrite: baseConfig.persistence.exportJsonOnWrite
  });
  const profileMemoryStore = ProfileMemoryStore.fromEnv();

  return {
    baseConfig,
    memoryStore,
    plannerFailureStore,
    executor,
    governors,
    masterGovernor,
    stateStore,
    personalityStore,
    governanceMemoryStore,
    executionReceiptStore,
    workflowLearningStore,
    judgmentPatternStore,
    profileMemoryStore,
    skillRegistryStore,
    distillerLedgerStore,
    satelliteCloneCoordinator
  };
}

/**
 * Builds one backend-specific brain runtime on top of the shared executor and store dependencies.
 *
 * **Why it exists:**
 * Session-aware backend overrides need a way to rebuild only the model-bound layers while
 * preserving the same managed-process, browser-session, and ledger runtime core.
 *
 * **What it talks to:**
 * - Uses `createBrainConfigFromEnv` from `./config`.
 * - Uses `createModelClientFromEnv` from `../models/createModelClient`.
 * - Uses planner, reflection, and memory broker organs that depend on the selected model client.
 *
 * @param shared - Shared runtime dependencies created once for the process.
 * @param env - Environment map carrying the selected backend/profile configuration.
 * @returns Backend-specific config, model client, and orchestrator tuple.
 */
export function buildBrainRuntimeFromEnvironment(
  shared: SharedBrainRuntimeDependencies,
  env: NodeJS.ProcessEnv = process.env
): BuiltBrainRuntime {
  const config = createBrainConfigFromEnv(env);
  const modelClient = createModelClientFromEnv(env);
  const userOwnedPathHints = resolveUserOwnedPathHints();
  const planner = new PlannerOrgan(modelClient, shared.memoryStore, shared.plannerFailureStore, {
    platform: config.shellRuntime.profile.platform,
    shellKind: config.shellRuntime.profile.shellKind,
    invocationMode: config.shellRuntime.profile.invocationMode,
    commandMaxChars: config.shellRuntime.profile.commandMaxChars,
    desktopPath: userOwnedPathHints.desktopPath,
    documentsPath: userOwnedPathHints.documentsPath,
    downloadsPath: userOwnedPathHints.downloadsPath
  });
  const reflection = new ReflectionOrgan(
    shared.memoryStore,
    modelClient,
    {
      reflectOnSuccess: config.reflection.reflectOnSuccess
    },
    {
      distillerLedgerStore: shared.distillerLedgerStore,
      satelliteCloneCoordinator: shared.satelliteCloneCoordinator
    }
  );
  const memoryBroker = new MemoryBrokerOrgan(
    shared.profileMemoryStore,
    undefined,
    undefined,
    new LanguageUnderstandingOrgan(modelClient)
  );

  const brain = new BrainOrchestrator(
    config,
    planner,
    shared.executor,
    shared.governors,
    shared.masterGovernor,
    shared.stateStore,
    modelClient,
    reflection,
    shared.personalityStore,
    shared.governanceMemoryStore,
    shared.profileMemoryStore,
    memoryBroker,
    shared.executionReceiptStore,
    undefined,
    undefined,
    undefined,
    shared.workflowLearningStore,
    shared.judgmentPatternStore,
    shared.skillRegistryStore
  );

  return {
    config,
    modelClient,
    brain
  };
}

/**
 * Builds the default process-wide brain used by CLI and legacy single-backend entrypoints.
 *
 * **Why it exists:**
 * Preserves the old `buildDefaultBrain()` surface for callers that do not need session-aware
 * backend overrides while reusing the shared/runtime split internally.
 *
 * **What it talks to:**
 * - Uses `createSharedBrainRuntimeDependencies` and `buildBrainRuntimeFromEnvironment` in this
 *   module.
 *
 * @returns Process-default orchestrator instance.
 */
export function buildDefaultBrain(): BrainOrchestrator {
  return buildBrainRuntimeFromEnvironment(
    createSharedBrainRuntimeDependencies()
  ).brain;
}
