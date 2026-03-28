/**
 * @fileoverview Starts the live messaging interface runtime and routes Telegram/Discord events into the governed brain orchestrator.
 */

import {
  buildBrainRuntimeFromEnvironment,
  createSharedBrainRuntimeDependencies
} from "../core/buildBrain";
import { BrainOrchestrator } from "../core/orchestrator";
import { MediaUnderstandingOrgan } from "../organs/mediaUnderstanding/mediaInterpretation";
import {
  createAutonomyBoundaryInterpretationResolverFromEnv,
  createContinuationInterpretationResolverFromEnv,
  createContextualFollowupInterpretationResolverFromEnv,
  createContextualReferenceInterpretationResolverFromEnv,
  createEntityDomainHintInterpretationResolverFromEnv,
  createEntityReferenceInterpretationResolverFromEnv,
  createEntityTypeInterpretationResolverFromEnv,
  createHandoffControlInterpretationResolverFromEnv,
  createIdentityInterpretationResolverFromEnv,
  createLocalIntentModelResolverFromEnv,
  createProposalReplyInterpretationResolverFromEnv,
  createStatusRecallBoundaryInterpretationResolverFromEnv,
  createTopicKeyInterpretationResolverFromEnv,
  isLocalIntentModelRuntimeReady,
  probeLocalIntentModelFromEnv
} from "../organs/languageUnderstanding/localIntentModelRuntime";
import { createBrainConfigFromEnv } from "../core/config";
import { EntityGraphStore } from "../core/entityGraphStore";
import { ensureEnvLoaded } from "../core/envLoader";
import { DiscordAdapter } from "./discordAdapter";
import { DiscordGateway } from "./discordGateway";
import { acquireInterfaceRuntimeLock } from "./interfaceRuntimeLock";
import {
  createInterfaceRuntimeConfigFromEnv,
  DiscordInterfaceConfig,
  InterfaceRuntimeConfig,
  MultiProviderInterfaceConfig,
  TelegramInterfaceConfig
} from "./runtimeConfig";
import { InterfaceSessionStore } from "./sessionStore";
import { TelegramAdapter } from "./telegramAdapter";
import { TelegramGateway } from "./telegramGateway";
import { InterfaceBrainRegistry } from "./interfaceBrainRegistry";

interface GatewayRuntime {
  start(): Promise<void>;
  stop(): void;
}

interface GatewayRuntimePersistence {
  sessionStore: InterfaceSessionStore;
  entityGraphStore: EntityGraphStore;
  brainRegistry: InterfaceBrainRegistry;
}

interface InterfaceRuntimeOptionalDependencies {
  localIntentModelResolver?: ReturnType<typeof createLocalIntentModelResolverFromEnv>;
  autonomyBoundaryInterpretationResolver?: ReturnType<typeof createAutonomyBoundaryInterpretationResolverFromEnv>;
  statusRecallBoundaryInterpretationResolver?: ReturnType<typeof createStatusRecallBoundaryInterpretationResolverFromEnv>;
  continuationInterpretationResolver?: ReturnType<typeof createContinuationInterpretationResolverFromEnv>;
  contextualFollowupInterpretationResolver?: ReturnType<typeof createContextualFollowupInterpretationResolverFromEnv>;
  contextualReferenceInterpretationResolver?: ReturnType<typeof createContextualReferenceInterpretationResolverFromEnv>;
  entityDomainHintInterpretationResolver?: ReturnType<typeof createEntityDomainHintInterpretationResolverFromEnv>;
  entityReferenceInterpretationResolver?: ReturnType<typeof createEntityReferenceInterpretationResolverFromEnv>;
  entityTypeInterpretationResolver?: ReturnType<typeof createEntityTypeInterpretationResolverFromEnv>;
  handoffControlInterpretationResolver?: ReturnType<typeof createHandoffControlInterpretationResolverFromEnv>;
  identityInterpretationResolver?: ReturnType<typeof createIdentityInterpretationResolverFromEnv>;
  proposalReplyInterpretationResolver?: ReturnType<typeof createProposalReplyInterpretationResolverFromEnv>;
  topicKeyInterpretationResolver?: ReturnType<typeof createTopicKeyInterpretationResolverFromEnv>;
}

/**
 * Creates the Telegram runtime stack (adapter + gateway) used by the interface process.
 *
 * **Why it exists:**
 * Keeps Telegram wiring in one place so all call sites get the same auth, allowlist,
 * rate-limit, replay, and shared-session-store behavior.
 *
 * **What it talks to:**
 * - `BrainOrchestrator` for governed task execution.
 * - `TelegramAdapter` for ingress auth/rate/replay checks and request shaping.
 * - `TelegramGateway` for transport lifecycle (`start`/`stop`).
 *
 * @param brain - Shared orchestrator instance that handles governed task runs.
 * @param config - Telegram runtime/security settings loaded from env-backed config.
 * @param persistence - Shared runtime persistence dependencies (currently session store).
 * @returns Gateway runtime object with `start` and `stop` lifecycle methods.
 */
function createTelegramGatewayRuntime(
  brain: BrainOrchestrator,
  config: TelegramInterfaceConfig,
  persistence: GatewayRuntimePersistence,
  optionalDependencies: InterfaceRuntimeOptionalDependencies = {}
): GatewayRuntime {
  const mediaUnderstandingOrgan = new MediaUnderstandingOrgan();

  const adapter = new TelegramAdapter(brain, {
    auth: {
      requiredToken: config.security.sharedSecret
    },
    allowlist: {
      allowedUsernames: config.security.allowedUsernames,
      allowedUserIds: config.security.allowedUserIds,
      allowedChatIds: config.allowedChatIds
    },
    rateLimit: {
      windowMs: config.security.rateLimitWindowMs,
      maxEventsPerWindow: config.security.maxEventsPerWindow
    },
    replay: {
      maxTrackedUpdateIds: config.security.replayCacheSize
    }
  });

  return new TelegramGateway(adapter, config, {
    sessionStore: persistence.sessionStore,
    entityGraphStore: persistence.entityGraphStore,
    brainRegistry: persistence.brainRegistry,
    mediaUnderstandingOrgan,
    localIntentModelResolver: optionalDependencies.localIntentModelResolver,
    autonomyBoundaryInterpretationResolver: optionalDependencies.autonomyBoundaryInterpretationResolver,
    statusRecallBoundaryInterpretationResolver: optionalDependencies.statusRecallBoundaryInterpretationResolver,
    continuationInterpretationResolver: optionalDependencies.continuationInterpretationResolver,
    contextualFollowupInterpretationResolver: optionalDependencies.contextualFollowupInterpretationResolver,
    contextualReferenceInterpretationResolver: optionalDependencies.contextualReferenceInterpretationResolver,
    entityDomainHintInterpretationResolver: optionalDependencies.entityDomainHintInterpretationResolver,
    entityReferenceInterpretationResolver: optionalDependencies.entityReferenceInterpretationResolver,
    entityTypeInterpretationResolver: optionalDependencies.entityTypeInterpretationResolver,
    handoffControlInterpretationResolver: optionalDependencies.handoffControlInterpretationResolver,
    identityInterpretationResolver: optionalDependencies.identityInterpretationResolver,
    proposalReplyInterpretationResolver: optionalDependencies.proposalReplyInterpretationResolver,
    topicKeyInterpretationResolver: optionalDependencies.topicKeyInterpretationResolver
  });
}

/**
 * Creates the Discord runtime stack (adapter + gateway) used by the interface process.
 *
 * **Why it exists:**
 * Mirrors Telegram runtime construction while preserving Discord-specific allowlist/replay rules.
 *
 * **What it talks to:**
 * - `BrainOrchestrator` for governed task execution.
 * - `DiscordAdapter` for ingress auth/rate/replay checks and request shaping.
 * - `DiscordGateway` for transport lifecycle (`start`/`stop`).
 *
 * @param brain - Shared orchestrator instance that handles governed task runs.
 * @param config - Discord runtime/security settings loaded from env-backed config.
 * @param persistence - Shared runtime persistence dependencies (currently session store).
 * @returns Gateway runtime object with `start` and `stop` lifecycle methods.
 */
function createDiscordGatewayRuntime(
  brain: BrainOrchestrator,
  config: DiscordInterfaceConfig,
  persistence: GatewayRuntimePersistence,
  optionalDependencies: InterfaceRuntimeOptionalDependencies = {}
): GatewayRuntime {
  const adapter = new DiscordAdapter(brain, {
    auth: {
      requiredToken: config.security.sharedSecret
    },
    allowlist: {
      allowedUsernames: config.security.allowedUsernames,
      allowedUserIds: config.security.allowedUserIds,
      allowedChannelIds: config.allowedChannelIds
    },
    rateLimit: {
      windowMs: config.security.rateLimitWindowMs,
      maxEventsPerWindow: config.security.maxEventsPerWindow
    },
    replay: {
      maxTrackedMessageIds: config.security.replayCacheSize
    }
  });

  return new DiscordGateway(adapter, config, {
    sessionStore: persistence.sessionStore,
    entityGraphStore: persistence.entityGraphStore,
    brainRegistry: persistence.brainRegistry,
    localIntentModelResolver: optionalDependencies.localIntentModelResolver,
    autonomyBoundaryInterpretationResolver: optionalDependencies.autonomyBoundaryInterpretationResolver,
    statusRecallBoundaryInterpretationResolver: optionalDependencies.statusRecallBoundaryInterpretationResolver,
    continuationInterpretationResolver: optionalDependencies.continuationInterpretationResolver,
    contextualFollowupInterpretationResolver: optionalDependencies.contextualFollowupInterpretationResolver,
    contextualReferenceInterpretationResolver: optionalDependencies.contextualReferenceInterpretationResolver,
    entityDomainHintInterpretationResolver: optionalDependencies.entityDomainHintInterpretationResolver,
    entityReferenceInterpretationResolver: optionalDependencies.entityReferenceInterpretationResolver,
    entityTypeInterpretationResolver: optionalDependencies.entityTypeInterpretationResolver,
    handoffControlInterpretationResolver: optionalDependencies.handoffControlInterpretationResolver,
    identityInterpretationResolver: optionalDependencies.identityInterpretationResolver,
    proposalReplyInterpretationResolver: optionalDependencies.proposalReplyInterpretationResolver,
    topicKeyInterpretationResolver: optionalDependencies.topicKeyInterpretationResolver
  });
}

/**
 * Builds runtime gateways when interface mode is pinned to a single provider.
 *
 * **Why it exists:**
 * Normalizes provider branching so callers do not duplicate telegram-vs-discord selection logic.
 *
 * **What it talks to:**
 * - `createTelegramGatewayRuntime` and `createDiscordGatewayRuntime`.
 * - Provider-specific runtime config variants from `runtimeConfig`.
 *
 * @param brain - Shared orchestrator instance used by all gateways.
 * @param config - Single-provider runtime config (`telegram` or `discord`).
 * @param persistence - Shared runtime persistence dependencies.
 * @returns One-element gateway array for the selected provider.
 */
function createGatewayRuntimesForSingleProvider(
  brain: BrainOrchestrator,
  config: TelegramInterfaceConfig | DiscordInterfaceConfig,
  persistence: GatewayRuntimePersistence,
  optionalDependencies: InterfaceRuntimeOptionalDependencies = {}
): GatewayRuntime[] {
  if (config.provider === "telegram") {
    return [createTelegramGatewayRuntime(brain, config, persistence, optionalDependencies)];
  }

  return [createDiscordGatewayRuntime(brain, config, persistence, optionalDependencies)];
}

/**
 * Builds runtime gateways when both Telegram and Discord are enabled together.
 *
 * **Why it exists:**
 * Ensures multi-provider mode uses one shared orchestrator/session store while keeping provider
 * startup order deterministic.
 *
 * **What it talks to:**
 * - `createTelegramGatewayRuntime`.
 * - `createDiscordGatewayRuntime`.
 * - `MultiProviderInterfaceConfig` split config (`telegram` + `discord`).
 *
 * @param brain - Shared orchestrator instance used by both providers.
 * @param config - Combined runtime config for Telegram and Discord.
 * @param persistence - Shared runtime persistence dependencies.
 * @returns Two gateway runtimes in stable order: Telegram first, then Discord.
 */
function createGatewayRuntimesForBothProviders(
  brain: BrainOrchestrator,
  config: MultiProviderInterfaceConfig,
  persistence: GatewayRuntimePersistence,
  optionalDependencies: InterfaceRuntimeOptionalDependencies = {}
): GatewayRuntime[] {
  return [
    createTelegramGatewayRuntime(brain, config.telegram, persistence, optionalDependencies),
    createDiscordGatewayRuntime(brain, config.discord, persistence, optionalDependencies)
  ];
}

/**
 * Selects and builds gateway runtime instances from the resolved interface provider mode.
 *
 * **Why it exists:**
 * Gives `runInterfaceRuntime` a single entrypoint for provider fan-out.
 *
 * **What it talks to:**
 * - `createGatewayRuntimesForBothProviders` for `provider=both`.
 * - `createGatewayRuntimesForSingleProvider` for single-provider configs.
 *
 * @param brain - Shared orchestrator instance used by gateway adapters.
 * @param config - Fully resolved interface runtime config.
 * @param persistence - Shared runtime persistence dependencies.
 * @returns Gateway runtimes to start for the selected provider mode.
 */
function createGatewayRuntimes(
  brain: BrainOrchestrator,
  config: InterfaceRuntimeConfig,
  persistence: GatewayRuntimePersistence,
  optionalDependencies: InterfaceRuntimeOptionalDependencies = {}
): GatewayRuntime[] {
  if (config.provider === "both") {
    return createGatewayRuntimesForBothProviders(brain, config, persistence, optionalDependencies);
  }
  return createGatewayRuntimesForSingleProvider(brain, config, persistence, optionalDependencies);
}

/**
 * Starts every configured gateway concurrently.
 *
 * **Why it exists:**
 * Interface runtime only becomes operational after all enabled providers are listening.
 *
 * **What it talks to:**
 * - Each gateway runtime's `start()` lifecycle method.
 *
 * @param gateways - Runtime gateways selected for this process instance.
 * @returns Resolves when all gateway `start()` calls complete.
 */
async function startAllGateways(gateways: GatewayRuntime[]): Promise<void> {
  await Promise.all(gateways.map((gateway) => gateway.start()));
}

/**
 * Stops every configured gateway.
 *
 * **Why it exists:**
 * Centralizes teardown so normal shutdown and error cleanup use the same path.
 *
 * **What it talks to:**
 * - Each gateway runtime's `stop()` lifecycle method.
 *
 * @param gateways - Runtime gateways that were created for this process instance.
 */
function stopAllGateways(gateways: GatewayRuntime[]): void {
  for (const gateway of gateways) {
    gateway.stop();
  }
}

/**
 * Produces a human-readable provider label for startup logs.
 *
 * **Why it exists:**
 * Keeps log phrasing consistent across runtime paths.
 *
 * **What it talks to:**
 * - `InterfaceRuntimeConfig.provider`.
 *
 * @param config - Active interface runtime configuration.
 * @returns Provider label (`telegram`, `discord`, or `telegram + discord`).
 */
function describeProviderSelection(config: InterfaceRuntimeConfig): string {
  if (config.provider === "both") {
    return "telegram + discord";
  }
  return config.provider;
}

/**
 * Produces a human-readable summary of name-call invocation gating.
 *
 * **Why it exists:**
 * Startup logs should show whether inbound messages require explicit alias invocation.
 *
 * **What it talks to:**
 * - `InterfaceRuntimeConfig.security.invocation`.
 *
 * @param config - Active interface runtime configuration.
 * @returns Invocation policy label used in runtime startup output.
 */
function describeInvocationPolicy(config: InterfaceRuntimeConfig): string {
  if (!config.security.invocation.requireNameCall) {
    return "name-call gate disabled";
  }
  return `name-call gate enabled (${config.security.invocation.aliases.join(", ")})`;
}

/**
 * Parses permissive boolean-like env values (`1`, `true`, `yes`, `on`).
 *
 * **Why it exists:**
 * Environment-driven feature flags are often entered in different textual forms.
 *
 * **What it talks to:**
 * - Local normalization rules only.
 *
 * @param value - Raw environment variable value.
 * @returns `true` when value is a recognized enabled literal.
 */
function parseEnabledFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

/**
 * Warns when dual-provider mode is enabled without shared profile memory support.
 *
 * **Why it exists:**
 * Without `BRAIN_PROFILE_MEMORY_ENABLED`, Telegram and Discord sessions cannot share
 * long-lived profile facts, which can surprise operators in cross-platform mode.
 *
 * **What it talks to:**
 * - `InterfaceRuntimeConfig.provider`.
 * - `BRAIN_PROFILE_MEMORY_ENABLED` from process environment.
 *
 * @param config - Active interface runtime configuration.
 * @param env - Environment source (injectable for tests).
 */
function logCrossPlatformProfileMemoryWarningIfNeeded(
  config: InterfaceRuntimeConfig,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (config.provider !== "both") {
    return;
  }

  if (parseEnabledFlag(env.BRAIN_PROFILE_MEMORY_ENABLED)) {
    return;
  }

  console.warn(
    "[InterfaceRuntime] Cross-platform profile continuity is disabled because " +
    "BRAIN_PROFILE_MEMORY_ENABLED is not enabled. " +
    "Telegram and Discord will not share identity/profile facts until profile memory is enabled."
  );
}

/**
 * Logs whether the optional local intent-model runtime is available for the interface front door.
 *
 * **Why it exists:**
 * Operators need a startup-visible signal that clarifies whether the bounded local Phi path will
 * participate in natural intent routing or whether the runtime will stay on deterministic-only
 * routing for this process.
 *
 * **What it talks to:**
 * - Uses `probeLocalIntentModelFromEnv` (import `probeLocalIntentModelFromEnv`) from
 *   `../organs/languageUnderstanding/localIntentModelRuntime`.
 * - Uses `isLocalIntentModelRuntimeReady` (import `isLocalIntentModelRuntimeReady`) from
 *   `../organs/languageUnderstanding/localIntentModelRuntime`.
 *
 * @param env - Environment source used for local intent-model config.
 * @returns Promise resolving after the status log is emitted.
 */
async function logLocalIntentModelStatus(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const probe = await probeLocalIntentModelFromEnv(env);
  if (!probe.enabled) {
    return;
  }
  if (isLocalIntentModelRuntimeReady(probe)) {
    console.log(
      `[InterfaceRuntime] Local intent model enabled via ${probe.provider}: ${probe.model} at ${probe.baseUrl}.`
    );
    return;
  }
  const availabilityLabel = probe.reachable
    ? "reachable, but the configured model is missing"
    : "not reachable";
  console.warn(
    `[InterfaceRuntime] Local intent model is enabled but ${availabilityLabel}. ` +
    `Front-door intent routing will fail closed to deterministic behavior until ${probe.model} is available at ${probe.baseUrl}.`
  );
}

/**
 * Registers SIGINT/SIGTERM handlers and returns a detach callback.
 *
 * **Why it exists:**
 * Runtime startup and teardown should be symmetric: attach once, clean up once.
 *
 * **What it talks to:**
 * - Node.js process signal listeners.
 * - Caller-provided `onShutdown` callback.
 *
 * @param onShutdown - Teardown callback executed when termination signals arrive.
 * @returns Detacher that removes the installed signal handlers.
 */
function registerShutdownHandlers(onShutdown: () => void): () => void {
  /**
   * Executes one shared shutdown path for termination signals.
   *
   * **Why it exists:**
   * Both SIGINT and SIGTERM should run identical teardown behavior, and this local callback keeps
   * registration and cleanup symmetric.
   *
   * **What it talks to:**
   * - Calls the injected `onShutdown` callback.
   */
  const stopRuntime = (): void => {
    onShutdown();
  };

  process.once("SIGINT", stopRuntime);
  process.once("SIGTERM", stopRuntime);

  return () => {
    process.off("SIGINT", stopRuntime);
    process.off("SIGTERM", stopRuntime);
  };
}

/**
 * Boots the interface process and starts configured Telegram/Discord gateways.
 *
 * **Why it exists:**
 * Serves as the runtime entrypoint that wires env config, orchestrator, persistence,
 * lifecycle handlers, and provider startup into one deterministic flow.
 *
 * **What it talks to:**
 * - Core boot/config (`ensureEnvLoaded`, `createBrainConfigFromEnv`, `buildDefaultBrain`).
 * - Interface config/session persistence (`createInterfaceRuntimeConfigFromEnv`, `InterfaceSessionStore`).
 * - Provider gateways via `createGatewayRuntimes`, `startAllGateways`, and `stopAllGateways`.
 *
 * @returns Resolves when all gateways have exited (or teardown completes after failure).
 */
export async function runInterfaceRuntime(): Promise<void> {
  ensureEnvLoaded();
  const runtimeLock = await acquireInterfaceRuntimeLock();
  const config = createInterfaceRuntimeConfigFromEnv();
  const brainConfig = createBrainConfigFromEnv();
  const localIntentModelResolver = createLocalIntentModelResolverFromEnv();
  const autonomyBoundaryInterpretationResolver = createAutonomyBoundaryInterpretationResolverFromEnv();
  const statusRecallBoundaryInterpretationResolver = createStatusRecallBoundaryInterpretationResolverFromEnv();
  const continuationInterpretationResolver = createContinuationInterpretationResolverFromEnv();
  const contextualFollowupInterpretationResolver = createContextualFollowupInterpretationResolverFromEnv();
  const contextualReferenceInterpretationResolver = createContextualReferenceInterpretationResolverFromEnv();
  const entityReferenceInterpretationResolver = createEntityReferenceInterpretationResolverFromEnv();
  const entityDomainHintInterpretationResolver =
    createEntityDomainHintInterpretationResolverFromEnv();
  const entityTypeInterpretationResolver = createEntityTypeInterpretationResolverFromEnv();
  const handoffControlInterpretationResolver = createHandoffControlInterpretationResolverFromEnv();
  const identityInterpretationResolver = createIdentityInterpretationResolverFromEnv();
  const proposalReplyInterpretationResolver = createProposalReplyInterpretationResolverFromEnv();
  const topicKeyInterpretationResolver = createTopicKeyInterpretationResolverFromEnv();
  logCrossPlatformProfileMemoryWarningIfNeeded(config);
  await logLocalIntentModelStatus();
  const sessionStore = new InterfaceSessionStore(undefined, {
    backend: brainConfig.persistence.ledgerBackend,
    sqlitePath: brainConfig.persistence.ledgerSqlitePath,
    exportJsonOnWrite: brainConfig.persistence.exportJsonOnWrite
  });
  const entityGraphStore = new EntityGraphStore(undefined, {
    backend: brainConfig.persistence.ledgerBackend,
    sqlitePath: brainConfig.persistence.ledgerSqlitePath,
    exportJsonOnWrite: brainConfig.persistence.exportJsonOnWrite
  });
  const sharedBrainRuntime = createSharedBrainRuntimeDependencies(process.env);
  const brainRegistry = new InterfaceBrainRegistry(process.env, sharedBrainRuntime);
  const brain = buildBrainRuntimeFromEnvironment(sharedBrainRuntime, process.env).brain;
  const gateways = createGatewayRuntimes(brain, config, {
    sessionStore,
    entityGraphStore,
    brainRegistry
  }, {
    localIntentModelResolver,
    autonomyBoundaryInterpretationResolver,
    statusRecallBoundaryInterpretationResolver,
    continuationInterpretationResolver,
    contextualFollowupInterpretationResolver,
    contextualReferenceInterpretationResolver,
    entityDomainHintInterpretationResolver,
    entityReferenceInterpretationResolver,
    entityTypeInterpretationResolver,
    handoffControlInterpretationResolver,
    identityInterpretationResolver,
    proposalReplyInterpretationResolver,
    topicKeyInterpretationResolver
  });
  const detachHandlers = registerShutdownHandlers(() => {
    stopAllGateways(gateways);
  });
  const providerLabel = describeProviderSelection(config);
  const invocationLabel = describeInvocationPolicy(config);

  try {
    console.log(
      `[InterfaceRuntime] Starting ${providerLabel} gateway runtime with username allowlist: ${config.security.allowedUsernames.join(", ")} (${invocationLabel})`
    );
    await startAllGateways(gateways);
  } finally {
    stopAllGateways(gateways);
    detachHandlers();
    await runtimeLock.release();
  }
}

/**
 * Module CLI entrypoint wrapper for interface runtime startup.
 *
 * **Why it exists:**
 * Keeps top-level `require.main` handling minimal and test-friendly.
 *
 * **What it talks to:**
 * - `runInterfaceRuntime`.
 *
 * @returns Resolves after interface runtime lifecycle completes.
 */
async function main(): Promise<void> {
  await runInterfaceRuntime();
}

if (require.main === module) {
  void main();
}

