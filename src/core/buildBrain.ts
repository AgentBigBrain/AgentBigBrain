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
import { EntityGraphStore } from "./entityGraphStore";
import { MediaArtifactStore } from "./mediaArtifactStore";
import { Stage686RuntimeStateStore } from "./stage6_86/runtimeState";
import { Stage686RuntimeActionEngine } from "./stage6_86/runtimeActions";
import { createProjectionRuntimeConfigFromEnv } from "./projections/config";
import { ProjectionService } from "./projections/service";
import { ProjectionStateStore } from "./projections/projectionStateStore";
import { buildSkillProjectionEntries } from "./projections/skillProjectionPolicy";
import { ObsidianVaultSink } from "./projections/targets/obsidianVaultSink";
import { JsonMirrorSink } from "./projections/targets/jsonMirrorSink";
import { resolveUserOwnedPathHints } from "../organs/plannerPolicy/userOwnedPathHints";
import type { ModelClient } from "../models/types";
import type { ProjectionChangeSet, ProjectionSink, ProjectionSnapshot } from "./projections/contracts";

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
  readonly entityGraphStore: EntityGraphStore;
  readonly stage686RuntimeStateStore: Stage686RuntimeStateStore;
  readonly mediaArtifactStore: MediaArtifactStore;
  readonly projectionService: ProjectionService;
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
 * Resolves the shared runtime state root used for JSON sidecars and sqlite bootstrap imports.
 *
 * @param env - Environment map used for runtime path resolution.
 * @param config - Canonical brain config built from the same environment.
 * @returns Absolute runtime root directory for shared store state.
 */
function resolveSharedRuntimeStateRoot(
  env: NodeJS.ProcessEnv,
  config: BrainConfig
): string {
  const configuredStateJsonPath = env.BRAIN_STATE_JSON_PATH?.trim();
  if (configuredStateJsonPath) {
    return path.dirname(path.resolve(configuredStateJsonPath));
  }
  if (config.persistence.ledgerBackend === "sqlite") {
    return path.dirname(path.resolve(config.persistence.ledgerSqlitePath));
  }
  return path.resolve(process.cwd(), "runtime");
}

/**
 * Builds one absolute shared-runtime store path under the resolved runtime root.
 *
 * @param runtimeRoot - Absolute runtime root directory.
 * @param relativePath - Store-specific relative file or folder path.
 * @returns Absolute path below the shared runtime root.
 */
function resolveSharedRuntimeStorePath(runtimeRoot: string, relativePath: string): string {
  return path.join(runtimeRoot, relativePath);
}

/**
 * Builds the configured projection sinks for the current process.
 *
 * **Why it exists:**
 * Shared runtime boot should be able to swap projection targets without pushing Obsidian-specific
 * branching into the stores that publish mirror updates.
 *
 * **What it talks to:**
 * - Uses `ObsidianVaultSink` from `./projections/targets/obsidianVaultSink`.
 * - Uses `JsonMirrorSink` from `./projections/targets/jsonMirrorSink`.
 * - Uses `NoOpProjectionSink` from `./projections/noopSink`.
 *
 * @param env - Environment map used for projection config resolution.
 * @returns Ordered sink instances for the current process.
 */
function createProjectionSinks(env: NodeJS.ProcessEnv = process.env): readonly ProjectionSink[] {
  const config = createProjectionRuntimeConfigFromEnv(env);
  const sinks: ProjectionSink[] = [];
  if (config.obsidian.enabled) {
    sinks.push(new ObsidianVaultSink({
      vaultPath: config.obsidian.vaultPath,
      rootDirectoryName: config.obsidian.rootDirectoryName,
      mirrorAssets: config.obsidian.mirrorAssets
    }));
  }
  if (config.jsonMirror.enabled) {
    sinks.push(new JsonMirrorSink({
      outputPath: config.jsonMirror.outputPath
    }));
  }
  return sinks;
}

/**
 * Builds the full projection snapshot provider backed by shared canonical stores.
 *
 * **Why it exists:**
 * Rebuilds and real-time projection syncs should read from the same canonical runtime stores so
 * the mirror reflects true shared state instead of ad hoc transport-local caches.
 *
 * **What it talks to:**
 * - Uses the shared runtime stores created in this module.
 *
 * @param mode - Active projection mode.
 * @param entityGraphStore - Shared Stage 6.86 entity-graph store.
 * @param runtimeStateStore - Shared Stage 6.86 runtime-state store.
 * @param governanceMemoryStore - Governance memory store.
 * @param executionReceiptStore - Execution receipt store.
 * @param workflowLearningStore - Workflow learning store.
 * @param mediaArtifactStore - Media artifact store.
 * @param skillRegistryStore - Skill registry store.
 * @param profileMemoryStore - Optional profile-memory store.
 * @returns Snapshot provider closure.
 */
function createProjectionSnapshotProvider(
  mode: ProjectionSnapshot["mode"],
  entityGraphStore: EntityGraphStore,
  runtimeStateStore: Stage686RuntimeStateStore,
  governanceMemoryStore: GovernanceMemoryStore,
  executionReceiptStore: ExecutionReceiptStore,
  workflowLearningStore: WorkflowLearningStore,
  mediaArtifactStore: MediaArtifactStore,
  skillRegistryStore: SkillRegistryStore,
  profileMemoryStore?: ProfileMemoryStore
): () => Promise<ProjectionSnapshot> {
  return async () => {
    const [
      entityGraph,
      runtimeState,
      governanceReadView,
      executionReceiptDocument,
      workflowDocument,
      mediaArtifactDocument,
      skillManifests,
      profileMemory
    ] = await Promise.all([
      entityGraphStore.getGraph(),
      runtimeStateStore.load(),
      governanceMemoryStore.getReadView(),
      executionReceiptStore.load(),
      workflowLearningStore.load(),
      mediaArtifactStore.load(),
      skillRegistryStore.listActiveManifests(),
      profileMemoryStore ? profileMemoryStore.load() : Promise.resolve(null)
    ]);
    const skillProjectionEntries = await buildSkillProjectionEntries(mode, skillManifests);

    return {
      generatedAt: new Date().toISOString(),
      mode,
      profileMemory,
      currentSurfaceClaims: profileMemoryStore
        ? await profileMemoryStore.queryCurrentSurfaceGraphClaims()
        : [],
      resolvedCurrentClaims: profileMemoryStore
        ? await profileMemoryStore.queryResolvedCurrentGraphClaims()
        : [],
      runtimeState,
      entityGraph,
      governanceReadView,
      executionReceipts: executionReceiptDocument.receipts,
      workflowPatterns: workflowDocument.patterns,
      mediaArtifacts: mediaArtifactDocument.artifacts,
      skillProjectionEntries
    };
  };
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
  const runtimeStateRoot = resolveSharedRuntimeStateRoot(env, baseConfig);
  const projectionConfig = createProjectionRuntimeConfigFromEnv(env);
  let projectionService: ProjectionService | undefined;
  const publishProjectionChange = async (changeSet: ProjectionChangeSet): Promise<void> => {
    await projectionService?.notifyChange(changeSet);
  };
  const embeddingStack = buildEmbeddingStack(baseConfig);
  const memoryStore = new SemanticMemoryStore(
    resolveSharedRuntimeStorePath(runtimeStateRoot, "semantic_memory.json"),
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
  const personalityStore = new PersonalityStore(
    resolveSharedRuntimeStorePath(runtimeStateRoot, "personality_profile.json")
  );
  const entityGraphStore = new EntityGraphStore(
    resolveSharedRuntimeStorePath(runtimeStateRoot, "entity_graph.json"),
    {
      backend: baseConfig.persistence.ledgerBackend,
      sqlitePath: baseConfig.persistence.ledgerSqlitePath,
      exportJsonOnWrite: baseConfig.persistence.exportJsonOnWrite,
      onChange: publishProjectionChange
    }
  );
  const stage686RuntimeStateStore = new Stage686RuntimeStateStore(
    resolveSharedRuntimeStorePath(runtimeStateRoot, "stage6_86_runtime_state.json"),
    {
      backend: baseConfig.persistence.ledgerBackend,
      sqlitePath: baseConfig.persistence.ledgerSqlitePath,
      exportJsonOnWrite: baseConfig.persistence.exportJsonOnWrite,
      onChange: publishProjectionChange
    }
  );
  const governanceMemoryStore = new GovernanceMemoryStore(
    resolveSharedRuntimeStorePath(runtimeStateRoot, "governance_memory.json"),
    {
      backend: baseConfig.persistence.ledgerBackend,
      sqlitePath: baseConfig.persistence.ledgerSqlitePath,
      exportJsonOnWrite: baseConfig.persistence.exportJsonOnWrite,
      onChange: publishProjectionChange
    }
  );
  const executionReceiptStore = new ExecutionReceiptStore(
    resolveSharedRuntimeStorePath(runtimeStateRoot, "execution_receipts.json"),
    {
      backend: baseConfig.persistence.ledgerBackend,
      sqlitePath: baseConfig.persistence.ledgerSqlitePath,
      exportJsonOnWrite: baseConfig.persistence.exportJsonOnWrite,
      onChange: publishProjectionChange
    }
  );
  const workflowLearningStore = new WorkflowLearningStore(
    resolveSharedRuntimeStorePath(runtimeStateRoot, "workflow_learning.json"),
    {
      backend: baseConfig.persistence.ledgerBackend,
      sqlitePath: baseConfig.persistence.ledgerSqlitePath,
      exportJsonOnWrite: baseConfig.persistence.exportJsonOnWrite,
      onChange: publishProjectionChange
    }
  );
  const mediaArtifactStore = new MediaArtifactStore(
    resolveSharedRuntimeStorePath(runtimeStateRoot, "media_artifacts.json"),
    {
      backend: baseConfig.persistence.ledgerBackend,
      sqlitePath: baseConfig.persistence.ledgerSqlitePath,
      exportJsonOnWrite: baseConfig.persistence.exportJsonOnWrite,
      assetDirectory: resolveSharedRuntimeStorePath(
        runtimeStateRoot,
        path.join("media_artifacts", "assets")
      ),
      onChange: publishProjectionChange
    }
  );
  const skillRegistryStore = new SkillRegistryStore(
    resolveSharedRuntimeStorePath(runtimeStateRoot, "skills")
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
  const judgmentPatternStore = new JudgmentPatternStore(
    resolveSharedRuntimeStorePath(runtimeStateRoot, "judgment_patterns.json"),
    {
      backend: baseConfig.persistence.ledgerBackend,
      sqlitePath: baseConfig.persistence.ledgerSqlitePath,
      exportJsonOnWrite: baseConfig.persistence.exportJsonOnWrite
    }
  );
  const profileMemoryStore = ProfileMemoryStore.fromEnv(env, {
    onChange: publishProjectionChange,
    onCurrentSurfaceGraphClaimsChanged: async (claims, updatedAt) => {
      try {
        await entityGraphStore.syncCurrentSurfaceProfileClaims(claims, updatedAt);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[Stage6.86 continuity sync] ${message}`);
      }
    }
  });
  const projectionStateStore = new ProjectionStateStore(
    resolveSharedRuntimeStorePath(runtimeStateRoot, "projection_state.json"),
    {
      backend: baseConfig.persistence.ledgerBackend,
      sqlitePath: baseConfig.persistence.ledgerSqlitePath,
      exportJsonOnWrite: baseConfig.persistence.exportJsonOnWrite
    }
  );
  projectionService = new ProjectionService(projectionConfig, {
    stateStore: projectionStateStore,
    snapshotProvider: createProjectionSnapshotProvider(
      projectionConfig.mode,
      entityGraphStore,
      stage686RuntimeStateStore,
      governanceMemoryStore,
      executionReceiptStore,
      workflowLearningStore,
      mediaArtifactStore,
      skillRegistryStore,
      profileMemoryStore
    ),
    sinks: createProjectionSinks(env),
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Projection] ${message}`);
    }
  });
  if (projectionService.isEnabled()) {
    void projectionService.rebuild("process_startup");
  }

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
    satelliteCloneCoordinator,
    entityGraphStore,
    stage686RuntimeStateStore,
    mediaArtifactStore,
    projectionService
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
  const userOwnedPathHints = resolveUserOwnedPathHints(env);
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
  const stage686RuntimeActionEngine = new Stage686RuntimeActionEngine({
    backend: config.persistence.ledgerBackend,
    sqlitePath: config.persistence.ledgerSqlitePath,
    exportJsonOnWrite: config.persistence.exportJsonOnWrite,
    entityGraphStore: shared.entityGraphStore,
    runtimeStateStore: shared.stage686RuntimeStateStore
  });

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
    shared.skillRegistryStore,
    undefined,
    stage686RuntimeActionEngine
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
