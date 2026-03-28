/**
 * @fileoverview Parses environment-backed local intent-model config and creates the optional bounded resolver.
 */

import { ensureEnvLoaded } from "../../core/envLoader";
import type {
  AutonomyBoundaryInterpretationResolver,
  BridgeQuestionTimingInterpretationResolver,
  ContinuationInterpretationResolver,
  ContextualFollowupInterpretationResolver,
  ContextualReferenceInterpretationResolver,
  EntityDomainHintInterpretationResolver,
  EntityReferenceInterpretationResolver,
  EntityTypeInterpretationResolver,
  HandoffControlInterpretationResolver,
  IdentityInterpretationResolver,
  LocalIntentModelResolver,
  StatusRecallBoundaryInterpretationResolver,
  TopicKeyInterpretationResolver
} from "./localIntentModelContracts";
import type { ProposalReplyInterpretationResolver } from "./localIntentModelProposalReplyContracts";
import {
  createOllamaAutonomyBoundaryInterpretationResolver,
  createOllamaBridgeQuestionTimingInterpretationResolver,
  createOllamaContinuationInterpretationResolver,
  createOllamaContextualFollowupInterpretationResolver,
  createOllamaContextualReferenceInterpretationResolver,
  createOllamaEntityDomainHintInterpretationResolver,
  createOllamaEntityReferenceInterpretationResolver,
  createOllamaEntityTypeInterpretationResolver,
  createOllamaHandoffControlInterpretationResolver,
  createOllamaIdentityInterpretationResolver,
  createOllamaLocalIntentModelResolver,
  createOllamaProposalReplyInterpretationResolver,
  createOllamaStatusRecallBoundaryInterpretationResolver,
  createOllamaTopicKeyInterpretationResolver,
  probeOllamaLocalIntentModel,
  type OllamaLocalIntentModelProbeResult
} from "./ollamaLocalIntentModel";

export type LocalIntentModelProvider = "ollama";

export interface LocalIntentModelRuntimeConfig {
  enabled: boolean;
  provider: LocalIntentModelProvider;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  liveSmokeRequired: boolean;
}

export interface LocalIntentModelRuntimeProbeResult {
  enabled: boolean;
  provider: LocalIntentModelProvider;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  liveSmokeRequired: boolean;
  reachable: boolean;
  modelPresent: boolean;
  availableModels: readonly string[];
}

interface LocalIntentModelRuntimeDependencies {
  fetchImpl?: typeof fetch;
}

/**
 * Parses permissive boolean env values used by the local intent-model runtime.
 *
 * @param value - Raw env value.
 * @param fallback - Default value when the env is unset or invalid.
 * @returns Parsed boolean flag.
 */
function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

/**
 * Parses a positive integer env value used by local intent-model config.
 *
 * @param value - Raw env value.
 * @param fallback - Default value when the env is unset or invalid.
 * @returns Parsed positive integer.
 */
function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * Builds the env-backed local intent-model runtime config.
 *
 * @param env - Environment source used for configuration.
 * @returns Normalized local intent-model runtime config.
 */
export function createLocalIntentModelRuntimeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): LocalIntentModelRuntimeConfig {
  if (env === process.env) {
    ensureEnvLoaded();
  }
  const provider = ((env.BRAIN_LOCAL_INTENT_MODEL_PROVIDER ?? "ollama").trim().toLowerCase()
    || "ollama") as LocalIntentModelProvider;
  if (provider !== "ollama") {
    throw new Error(
      "BRAIN_LOCAL_INTENT_MODEL_PROVIDER must currently be 'ollama'."
    );
  }
  return {
    enabled: parseBoolean(env.BRAIN_LOCAL_INTENT_MODEL_ENABLED, false),
    provider,
    baseUrl: (env.BRAIN_LOCAL_INTENT_MODEL_BASE_URL ?? "http://127.0.0.1:11434").trim(),
    model: (env.BRAIN_LOCAL_INTENT_MODEL_NAME ?? "phi4-mini:latest").trim(),
    timeoutMs: parsePositiveInteger(env.BRAIN_LOCAL_INTENT_MODEL_TIMEOUT_MS, 45000),
    liveSmokeRequired: parseBoolean(env.BRAIN_LOCAL_INTENT_MODEL_LIVE_SMOKE_REQUIRED, false)
  };
}

/**
 * Creates the optional local intent-model resolver from env.
 *
 * @param env - Environment source used for configuration.
 * @param deps - Optional dependency overrides for tests.
 * @returns Configured resolver when enabled, otherwise `undefined`.
 */
export function createLocalIntentModelResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalIntentModelRuntimeDependencies = {}
): LocalIntentModelResolver | undefined {
  const config = createLocalIntentModelRuntimeConfigFromEnv(env);
  if (!config.enabled) {
    return undefined;
  }
  return createOllamaLocalIntentModelResolver(config, deps);
}

/**
 * Creates the optional identity-interpretation resolver from env.
 *
 * @param env - Environment source used for configuration.
 * @param deps - Optional dependency overrides for tests.
 * @returns Configured identity interpreter when enabled, otherwise `undefined`.
 */
export function createIdentityInterpretationResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalIntentModelRuntimeDependencies = {}
): IdentityInterpretationResolver | undefined {
  const config = createLocalIntentModelRuntimeConfigFromEnv(env);
  if (!config.enabled) {
    return undefined;
  }
  return createOllamaIdentityInterpretationResolver(config, deps);
}

/**
 * Creates the optional proposal-reply-interpretation resolver from env.
 *
 * @param env - Environment source used for configuration.
 * @param deps - Optional dependency overrides for tests.
 * @returns Configured proposal-reply interpreter when enabled, otherwise `undefined`.
 */
export function createProposalReplyInterpretationResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalIntentModelRuntimeDependencies = {}
): ProposalReplyInterpretationResolver | undefined {
  const config = createLocalIntentModelRuntimeConfigFromEnv(env);
  if (!config.enabled) {
    return undefined;
  }
  return createOllamaProposalReplyInterpretationResolver(config, deps);
}

/**
 * Creates the optional continuation-interpretation resolver from env.
 *
 * @param env - Environment source used for configuration.
 * @param deps - Optional dependency overrides for tests.
 * @returns Configured continuation interpreter when enabled, otherwise `undefined`.
 */
export function createContinuationInterpretationResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalIntentModelRuntimeDependencies = {}
): ContinuationInterpretationResolver | undefined {
  const config = createLocalIntentModelRuntimeConfigFromEnv(env);
  if (!config.enabled) {
    return undefined;
  }
  return createOllamaContinuationInterpretationResolver(config, deps);
}

/**
 * Creates the optional contextual-reference-interpretation resolver from env.
 *
 * @param env - Environment source used for configuration.
 * @param deps - Optional dependency overrides for tests.
 * @returns Configured contextual-reference interpreter when enabled, otherwise `undefined`.
 */
export function createContextualReferenceInterpretationResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalIntentModelRuntimeDependencies = {}
): ContextualReferenceInterpretationResolver | undefined {
  const config = createLocalIntentModelRuntimeConfigFromEnv(env);
  if (!config.enabled) {
    return undefined;
  }
  return createOllamaContextualReferenceInterpretationResolver(config, deps);
}

/**
 * Creates the optional topic-key-interpretation resolver from env.
 *
 * @param env - Environment source used for configuration.
 * @param deps - Optional dependency overrides for tests.
 * @returns Configured topic-key interpreter when enabled, otherwise `undefined`.
 */
export function createTopicKeyInterpretationResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalIntentModelRuntimeDependencies = {}
): TopicKeyInterpretationResolver | undefined {
  const config = createLocalIntentModelRuntimeConfigFromEnv(env);
  if (!config.enabled) {
    return undefined;
  }
  return createOllamaTopicKeyInterpretationResolver(config, deps);
}

/**
 * Creates the optional entity-reference-interpretation resolver from env.
 *
 * @param env - Environment source used for configuration.
 * @param deps - Optional dependency overrides for tests.
 * @returns Configured entity-reference interpreter when enabled, otherwise `undefined`.
 */
export function createEntityReferenceInterpretationResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalIntentModelRuntimeDependencies = {}
): EntityReferenceInterpretationResolver | undefined {
  const config = createLocalIntentModelRuntimeConfigFromEnv(env);
  if (!config.enabled) {
    return undefined;
  }
  return createOllamaEntityReferenceInterpretationResolver(config, deps);
}

/**
 * Creates the optional entity-type-interpretation resolver from env.
 *
 * @param env - Environment source used for configuration.
 * @param deps - Optional dependency overrides for tests.
 * @returns Configured entity-type interpreter when enabled, otherwise `undefined`.
 */
export function createEntityTypeInterpretationResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalIntentModelRuntimeDependencies = {}
): EntityTypeInterpretationResolver | undefined {
  const config = createLocalIntentModelRuntimeConfigFromEnv(env);
  if (!config.enabled) {
    return undefined;
  }
  return createOllamaEntityTypeInterpretationResolver(config, deps);
}

/**
 * Creates the optional entity-domain-hint-interpretation resolver from env.
 *
 * @param env - Environment source used for configuration.
 * @param deps - Optional dependency overrides for tests.
 * @returns Configured entity-domain-hint interpreter when enabled, otherwise `undefined`.
 */
export function createEntityDomainHintInterpretationResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalIntentModelRuntimeDependencies = {}
): EntityDomainHintInterpretationResolver | undefined {
  const config = createLocalIntentModelRuntimeConfigFromEnv(env);
  if (!config.enabled) {
    return undefined;
  }
  return createOllamaEntityDomainHintInterpretationResolver(config, deps);
}

/**
 * Creates the optional handoff-control-interpretation resolver from env.
 *
 * @param env - Environment source used for configuration.
 * @param deps - Optional dependency overrides for tests.
 * @returns Configured handoff-control interpreter when enabled, otherwise `undefined`.
 */
export function createHandoffControlInterpretationResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalIntentModelRuntimeDependencies = {}
): HandoffControlInterpretationResolver | undefined {
  const config = createLocalIntentModelRuntimeConfigFromEnv(env);
  if (!config.enabled) {
    return undefined;
  }
  return createOllamaHandoffControlInterpretationResolver(config, deps);
}

/**
 * Creates the optional contextual-followup-interpretation resolver from env.
 *
 * @param env - Environment source used for configuration.
 * @param deps - Optional dependency overrides for tests.
 * @returns Configured contextual-followup interpreter when enabled, otherwise `undefined`.
 */
export function createContextualFollowupInterpretationResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalIntentModelRuntimeDependencies = {}
): ContextualFollowupInterpretationResolver | undefined {
  const config = createLocalIntentModelRuntimeConfigFromEnv(env);
  if (!config.enabled) {
    return undefined;
  }
  return createOllamaContextualFollowupInterpretationResolver(config, deps);
}

/**
 * Creates the optional bridge-question-timing-interpretation resolver from env.
 *
 * @param env - Environment source used for configuration.
 * @param deps - Optional dependency overrides for tests.
 * @returns Configured bridge-question-timing interpreter when enabled, otherwise `undefined`.
 */
export function createBridgeQuestionTimingInterpretationResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalIntentModelRuntimeDependencies = {}
): BridgeQuestionTimingInterpretationResolver | undefined {
  const config = createLocalIntentModelRuntimeConfigFromEnv(env);
  if (!config.enabled) {
    return undefined;
  }
  return createOllamaBridgeQuestionTimingInterpretationResolver(config, deps);
}

/**
 * Creates the optional autonomy-boundary-interpretation resolver from env.
 *
 * @param env - Environment source used for configuration.
 * @param deps - Optional dependency overrides for tests.
 * @returns Configured autonomy-boundary interpreter when enabled, otherwise `undefined`.
 */
export function createAutonomyBoundaryInterpretationResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalIntentModelRuntimeDependencies = {}
): AutonomyBoundaryInterpretationResolver | undefined {
  const config = createLocalIntentModelRuntimeConfigFromEnv(env);
  if (!config.enabled) {
    return undefined;
  }
  return createOllamaAutonomyBoundaryInterpretationResolver(config, deps);
}

/**
 * Creates the optional status-recall-boundary-interpretation resolver from env.
 *
 * @param env - Environment source used for configuration.
 * @param deps - Optional dependency overrides for tests.
 * @returns Configured status/recall boundary interpreter when enabled, otherwise `undefined`.
 */
export function createStatusRecallBoundaryInterpretationResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalIntentModelRuntimeDependencies = {}
): StatusRecallBoundaryInterpretationResolver | undefined {
  const config = createLocalIntentModelRuntimeConfigFromEnv(env);
  if (!config.enabled) {
    return undefined;
  }
  return createOllamaStatusRecallBoundaryInterpretationResolver(config, deps);
}

/**
 * Probes the local intent-model runtime from env without routing any user input.
 *
 * @param env - Environment source used for configuration.
 * @param deps - Optional dependency overrides for tests.
 * @returns Local intent-model readiness probe result.
 */
export async function probeLocalIntentModelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalIntentModelRuntimeDependencies = {}
): Promise<LocalIntentModelRuntimeProbeResult> {
  const config = createLocalIntentModelRuntimeConfigFromEnv(env);
  if (!config.enabled) {
    return {
      ...config,
      reachable: false,
      modelPresent: false,
      availableModels: []
    };
  }
  const probe = await probeOllamaLocalIntentModel(config, deps);
  return {
    ...config,
    ...probe
  };
}

/**
 * Returns `true` when the probed local intent-model runtime is ready for live routing.
 *
 * @param probe - Probe result subset describing transport reachability and model presence.
 * @returns `true` when the local runtime can safely serve intent requests.
 */
export function isLocalIntentModelRuntimeReady(
  probe: Pick<OllamaLocalIntentModelProbeResult, "reachable" | "modelPresent">
): boolean {
  return probe.reachable && probe.modelPresent;
}
