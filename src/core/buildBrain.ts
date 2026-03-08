/**
 * @fileoverview Composes the default brain instance by wiring config, organs, governors, model client, and state store.
 */

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
export function buildDefaultBrain(): BrainOrchestrator {
  const config = createBrainConfigFromEnv();
  const modelClient = createModelClientFromEnv();
  const embeddingStack = buildEmbeddingStack(config);
  const memoryStore = new SemanticMemoryStore(
    undefined,
    embeddingStack.embeddingProvider,
    embeddingStack.vectorStore ?? undefined
  );
  const plannerFailureStore = new SqlitePlannerFailureStore(
    config.persistence.ledgerSqlitePath
  );
  const planner = new PlannerOrgan(modelClient, memoryStore, plannerFailureStore, {
    platform: config.shellRuntime.profile.platform,
    shellKind: config.shellRuntime.profile.shellKind,
    invocationMode: config.shellRuntime.profile.invocationMode,
    commandMaxChars: config.shellRuntime.profile.commandMaxChars
  });
  const executor = new ToolExecutorOrgan(config);
  const governors = createDefaultGovernors();
  const masterGovernor = new MasterGovernor(config.governance.supermajorityThreshold);
  const stateStore = new StateStore();
  const personalityStore = new PersonalityStore();
  const governanceMemoryStore = new GovernanceMemoryStore(undefined, {
    backend: config.persistence.ledgerBackend,
    sqlitePath: config.persistence.ledgerSqlitePath,
    exportJsonOnWrite: config.persistence.exportJsonOnWrite
  });
  const executionReceiptStore = new ExecutionReceiptStore(undefined, {
    backend: config.persistence.ledgerBackend,
    sqlitePath: config.persistence.ledgerSqlitePath,
    exportJsonOnWrite: config.persistence.exportJsonOnWrite
  });
  const workflowLearningStore = new WorkflowLearningStore(undefined, {
    backend: config.persistence.ledgerBackend,
    sqlitePath: config.persistence.ledgerSqlitePath,
    exportJsonOnWrite: config.persistence.exportJsonOnWrite
  });
  const distillerLedgerStore = new DistillerMergeLedgerStore(undefined, {
    backend: config.persistence.ledgerBackend,
    sqlitePath: config.persistence.ledgerSqlitePath,
    exportJsonOnWrite: config.persistence.exportJsonOnWrite
  });
  const satelliteCloneCoordinator = new SatelliteCloneCoordinator({
    maxClonesPerTask: config.limits.maxSubagentsPerTask,
    maxDepth: config.limits.maxSubagentDepth,
    maxBudgetUsd: 1
  });
  const reflection = new ReflectionOrgan(
    memoryStore,
    modelClient,
    {
      reflectOnSuccess: config.reflection.reflectOnSuccess
    },
    {
      distillerLedgerStore,
      satelliteCloneCoordinator
    }
  );
  const judgmentPatternStore = new JudgmentPatternStore(undefined, {
    backend: config.persistence.ledgerBackend,
    sqlitePath: config.persistence.ledgerSqlitePath,
    exportJsonOnWrite: config.persistence.exportJsonOnWrite
  });
  const profileMemoryStore = ProfileMemoryStore.fromEnv();
  const memoryBroker = new MemoryBrokerOrgan(
    profileMemoryStore,
    undefined,
    undefined,
    new LanguageUnderstandingOrgan(modelClient)
  );

  return new BrainOrchestrator(
    config,
    planner,
    executor,
    governors,
    masterGovernor,
    stateStore,
    modelClient,
    reflection,
    personalityStore,
    governanceMemoryStore,
    profileMemoryStore,
    memoryBroker,
    executionReceiptStore,
    undefined,
    undefined,
    undefined,
    workflowLearningStore,
    judgmentPatternStore
  );
}
