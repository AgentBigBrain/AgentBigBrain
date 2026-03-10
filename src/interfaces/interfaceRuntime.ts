/**
 * @fileoverview Starts the live messaging interface runtime and routes Telegram/Discord events into the governed brain orchestrator.
 */

import { buildDefaultBrain } from "../core/buildBrain";
import { BrainOrchestrator } from "../core/orchestrator";
import { MediaUnderstandingOrgan } from "../organs/mediaUnderstanding/mediaInterpretation";
import { createBrainConfigFromEnv } from "../core/config";
import { EntityGraphStore } from "../core/entityGraphStore";
import { ensureEnvLoaded } from "../core/envLoader";
import { DiscordAdapter } from "./discordAdapter";
import { DiscordGateway } from "./discordGateway";
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

interface GatewayRuntime {
  start(): Promise<void>;
  stop(): void;
}

interface GatewayRuntimePersistence {
  sessionStore: InterfaceSessionStore;
  entityGraphStore: EntityGraphStore;
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
  persistence: GatewayRuntimePersistence
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
    mediaUnderstandingOrgan
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
  persistence: GatewayRuntimePersistence
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
    entityGraphStore: persistence.entityGraphStore
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
  persistence: GatewayRuntimePersistence
): GatewayRuntime[] {
  if (config.provider === "telegram") {
    return [createTelegramGatewayRuntime(brain, config, persistence)];
  }

  return [createDiscordGatewayRuntime(brain, config, persistence)];
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
  persistence: GatewayRuntimePersistence
): GatewayRuntime[] {
  return [
    createTelegramGatewayRuntime(brain, config.telegram, persistence),
    createDiscordGatewayRuntime(brain, config.discord, persistence)
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
  persistence: GatewayRuntimePersistence
): GatewayRuntime[] {
  if (config.provider === "both") {
    return createGatewayRuntimesForBothProviders(brain, config, persistence);
  }
  return createGatewayRuntimesForSingleProvider(brain, config, persistence);
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
  const config = createInterfaceRuntimeConfigFromEnv();
  const brainConfig = createBrainConfigFromEnv();
  logCrossPlatformProfileMemoryWarningIfNeeded(config);
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
  const brain = buildDefaultBrain();
  const gateways = createGatewayRuntimes(brain, config, {
    sessionStore,
    entityGraphStore
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

