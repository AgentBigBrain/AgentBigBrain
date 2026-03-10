/**
 * @fileoverview Parses interface-runtime environment configuration for provider selection and username-scoped ingress controls.
 */

import { ensureEnvLoaded } from "../core/envLoader";

export type InterfaceProvider = "telegram" | "discord";
export type InterfaceProviderSelection = InterfaceProvider | "both";
export type TelegramStreamingTransportMode = "edit" | "native_draft";

export interface SharedInterfaceSecurityConfig {
  sharedSecret: string;
  allowedUsernames: string[];
  allowedUserIds: string[];
  rateLimitWindowMs: number;
  maxEventsPerWindow: number;
  replayCacheSize: number;
  agentPulseTickIntervalMs: number;
  ackDelayMs: number;
  showTechnicalSummary: boolean;
  showSafetyCodes: boolean;
  showCompletionPrefix: boolean;
  followUpOverridePath: string | null;
  pulseLexicalOverridePath: string | null;
  allowAutonomousViaInterface: boolean;
  enableDynamicPulse: boolean;
  invocation: {
    requireNameCall: boolean;
    aliases: string[];
  };
}

export interface TelegramMediaInterfaceConfig {
  enabled: boolean;
  maxAttachments: number;
  maxAttachmentBytes: number;
  maxDownloadBytes: number;
  maxVoiceSeconds: number;
  maxVideoSeconds: number;
  allowImages: boolean;
  allowVoiceNotes: boolean;
  allowVideos: boolean;
  allowDocuments: boolean;
}

export interface TelegramInterfaceConfig {
  provider: "telegram";
  security: SharedInterfaceSecurityConfig;
  botToken: string;
  apiBaseUrl: string;
  pollTimeoutSeconds: number;
  pollIntervalMs: number;
  streamingTransportMode: TelegramStreamingTransportMode;
  nativeDraftStreaming: boolean;
  allowedChatIds: string[];
  media: TelegramMediaInterfaceConfig;
}

export interface DiscordInterfaceConfig {
  provider: "discord";
  security: SharedInterfaceSecurityConfig;
  botToken: string;
  apiBaseUrl: string;
  gatewayUrl: string;
  intents: number;
  allowedChannelIds: string[];
}

export interface MultiProviderInterfaceConfig {
  provider: "both";
  security: SharedInterfaceSecurityConfig;
  telegram: TelegramInterfaceConfig;
  discord: DiscordInterfaceConfig;
}

export type InterfaceRuntimeConfig =
  | TelegramInterfaceConfig
  | DiscordInterfaceConfig
  | MultiProviderInterfaceConfig;

/**
 * Parses csv and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for csv so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Ordered collection produced by this step.
 */
function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Parses positive int and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for positive int so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

/**
 * Parses bounded int or throw and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for bounded int or throw so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @param bounds - Value for bounds.
 * @param envName - Value for env name.
 * @returns Computed numeric value.
 */
function parseBoundedIntOrThrow(
  value: string | undefined,
  fallback: number,
  bounds: { min: number; max: number },
  envName: string
): number {
  const raw = value?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${envName} must be an integer between ${bounds.min} and ${bounds.max}.`);
  }
  if (parsed < bounds.min || parsed > bounds.max) {
    throw new Error(`${envName} must be between ${bounds.min} and ${bounds.max} (inclusive).`);
  }
  return parsed;
}

/**
 * Parses boolean and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for boolean so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns `true` when this check passes.
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
 * Parses Telegram streaming transport mode and validates expected structure.
 *
 * **Why it exists:**
 * Native draft transport can surface client-specific artifacts in some Telegram builds.
 * This parser gives operators deterministic control over transport strategy while preserving
 * backward compatibility with the legacy boolean native-streaming toggle.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Optional transport-mode env value.
 * @param legacyNativeDraftStreaming - Legacy boolean toggle fallback.
 * @returns Normalized Telegram streaming transport mode.
 */
function parseTelegramStreamingTransportMode(
  value: string | undefined,
  legacyNativeDraftStreaming: boolean
): TelegramStreamingTransportMode {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) {
    return legacyNativeDraftStreaming ? "native_draft" : "edit";
  }
  if (normalized === "edit" || normalized === "native_draft") {
    return normalized;
  }
  throw new Error(
    "TELEGRAM_STREAMING_TRANSPORT_MODE must be 'edit' or 'native_draft'."
  );
}

/**
 * Parses provider selection and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for provider selection so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `InterfaceProviderSelection` result.
 */
function parseProviderSelection(value: string | undefined): InterfaceProviderSelection {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "telegram" || normalized === "discord" || normalized === "both") {
    return normalized;
  }

  const list = parseCsv(normalized).map((entry) => entry.toLowerCase());
  const unique = new Set(list);
  if (unique.size === 1 && unique.has("telegram")) {
    return "telegram";
  }
  if (unique.size === 1 && unique.has("discord")) {
    return "discord";
  }
  if (unique.size === 2 && unique.has("telegram") && unique.has("discord")) {
    return "both";
  }

  throw new Error(
    "BRAIN_INTERFACE_PROVIDER must be set to 'telegram', 'discord', or 'both' " +
    "(comma list 'telegram,discord' is also supported)."
  );
}

/**
 * Builds shared security config for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of shared security config consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param env - Value for env.
 * @returns Computed `SharedInterfaceSecurityConfig` result.
 */
function buildSharedSecurityConfig(env: NodeJS.ProcessEnv): SharedInterfaceSecurityConfig {
  const sharedSecret = (env.BRAIN_INTERFACE_SHARED_SECRET ?? "").trim();
  if (!sharedSecret) {
    throw new Error("BRAIN_INTERFACE_SHARED_SECRET is required for interface ingress auth.");
  }

  const allowedUsernames = parseCsv(env.BRAIN_INTERFACE_ALLOWED_USERNAMES);
  if (allowedUsernames.length === 0) {
    throw new Error(
      "BRAIN_INTERFACE_ALLOWED_USERNAMES must include at least one username."
    );
  }

  const requireNameCall = parseBoolean(env.BRAIN_INTERFACE_REQUIRE_NAME_CALL, false);
  const aliases = parseCsv(env.BRAIN_INTERFACE_NAME_ALIASES);
  const invocationAliases = aliases.length > 0 ? aliases : ["BigBrain"];

  const showTechnicalSummary = parseBoolean(
    env.BRAIN_INTERFACE_SHOW_TECHNICAL_SUMMARY,
    false
  );
  const ackDelayMs = parseBoundedIntOrThrow(
    env.BRAIN_INTERFACE_ACK_DELAY_MS,
    1_200,
    { min: 250, max: 3_000 },
    "BRAIN_INTERFACE_ACK_DELAY_MS"
  );
  const followUpOverridePath = (env.BRAIN_INTERFACE_FOLLOW_UP_OVERRIDE_PATH ?? "").trim() || null;
  const pulseLexicalOverridePath =
    (env.BRAIN_INTERFACE_PULSE_LEXICAL_OVERRIDE_PATH ?? "").trim() || null;
  return {
    sharedSecret,
    allowedUsernames,
    allowedUserIds: parseCsv(env.BRAIN_INTERFACE_ALLOWED_USER_IDS),
    rateLimitWindowMs: parsePositiveInt(env.BRAIN_INTERFACE_RATE_LIMIT_WINDOW_MS, 60_000),
    maxEventsPerWindow: parsePositiveInt(env.BRAIN_INTERFACE_RATE_LIMIT_MAX_EVENTS, 20),
    replayCacheSize: parsePositiveInt(env.BRAIN_INTERFACE_REPLAY_CACHE_SIZE, 500),
    agentPulseTickIntervalMs: parsePositiveInt(env.BRAIN_AGENT_PULSE_TICK_INTERVAL_MS, 120_000),
    ackDelayMs,
    showTechnicalSummary,
    showSafetyCodes: parseBoolean(
      env.BRAIN_INTERFACE_SHOW_SAFETY_CODES,
      showTechnicalSummary
    ),
    showCompletionPrefix: parseBoolean(
      env.BRAIN_INTERFACE_SHOW_COMPLETION_PREFIX,
      false
    ),
    followUpOverridePath,
    pulseLexicalOverridePath,
    allowAutonomousViaInterface: parseBoolean(env.BRAIN_ALLOW_AUTONOMOUS_VIA_INTERFACE, false),
    enableDynamicPulse: parseBoolean(env.BRAIN_ENABLE_DYNAMIC_PULSE, false),
    invocation: {
      requireNameCall,
      aliases: invocationAliases
    }
  };
}

/**
 * Builds telegram config for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of telegram config consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param env - Value for env.
 * @param security - Value for security.
 * @returns Computed `TelegramInterfaceConfig` result.
 */
function buildTelegramConfig(
  env: NodeJS.ProcessEnv,
  security: SharedInterfaceSecurityConfig
): TelegramInterfaceConfig {
  const botToken = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required when Telegram interface runtime is enabled.");
  }

  const nativeDraftStreaming = parseBoolean(env.TELEGRAM_NATIVE_DRAFT_STREAMING, false);
  const streamingTransportMode = parseTelegramStreamingTransportMode(
    env.TELEGRAM_STREAMING_TRANSPORT_MODE,
    nativeDraftStreaming
  );

  return {
    provider: "telegram",
    security,
    botToken,
    apiBaseUrl: (env.TELEGRAM_API_BASE_URL ?? "https://api.telegram.org").trim(),
    pollTimeoutSeconds: parsePositiveInt(env.TELEGRAM_POLL_TIMEOUT_SECONDS, 25),
    pollIntervalMs: parsePositiveInt(env.TELEGRAM_POLL_INTERVAL_MS, 500),
    streamingTransportMode,
    nativeDraftStreaming: streamingTransportMode === "native_draft",
    allowedChatIds: parseCsv(env.TELEGRAM_ALLOWED_CHAT_IDS),
    media: {
      enabled: parseBoolean(env.TELEGRAM_MEDIA_ENABLED, true),
      maxAttachments: parsePositiveInt(env.TELEGRAM_MAX_MEDIA_ATTACHMENTS, 4),
      maxAttachmentBytes: parsePositiveInt(env.TELEGRAM_MAX_MEDIA_ATTACHMENT_BYTES, 12000000),
      maxDownloadBytes: parsePositiveInt(env.TELEGRAM_MAX_MEDIA_DOWNLOAD_BYTES, 20000000),
      maxVoiceSeconds: parsePositiveInt(env.TELEGRAM_MAX_VOICE_SECONDS, 180),
      maxVideoSeconds: parsePositiveInt(env.TELEGRAM_MAX_VIDEO_SECONDS, 90),
      allowImages: parseBoolean(env.TELEGRAM_ALLOW_IMAGES, true),
      allowVoiceNotes: parseBoolean(env.TELEGRAM_ALLOW_VOICE_NOTES, true),
      allowVideos: parseBoolean(env.TELEGRAM_ALLOW_VIDEOS, true),
      allowDocuments: parseBoolean(env.TELEGRAM_ALLOW_DOCUMENTS, false)
    }
  };
}

/**
 * Builds discord config for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of discord config consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param env - Value for env.
 * @param security - Value for security.
 * @returns Computed `DiscordInterfaceConfig` result.
 */
function buildDiscordConfig(
  env: NodeJS.ProcessEnv,
  security: SharedInterfaceSecurityConfig
): DiscordInterfaceConfig {
  const botToken = (env.DISCORD_BOT_TOKEN ?? "").trim();
  if (!botToken) {
    throw new Error("DISCORD_BOT_TOKEN is required when Discord interface runtime is enabled.");
  }

  return {
    provider: "discord",
    security,
    botToken,
    apiBaseUrl: (env.DISCORD_API_BASE_URL ?? "https://discord.com/api/v10").trim(),
    gatewayUrl: (env.DISCORD_GATEWAY_URL ?? "https://discord.com/api/v10/gateway/bot").trim(),
    intents: parsePositiveInt(env.DISCORD_GATEWAY_INTENTS, 37377),
    allowedChannelIds: parseCsv(env.DISCORD_ALLOWED_CHANNEL_IDS)
  };
}

/**
 * Builds interface runtime config from env for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of interface runtime config from env consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ensureEnvLoaded` (import `ensureEnvLoaded`) from `../core/envLoader`.
 *
 * @param env - Value for env.
 * @returns Computed `InterfaceRuntimeConfig` result.
 */
export function createInterfaceRuntimeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): InterfaceRuntimeConfig {
  if (env === process.env) {
    ensureEnvLoaded();
  }

  const provider = parseProviderSelection(env.BRAIN_INTERFACE_PROVIDER);
  const security = buildSharedSecurityConfig(env);

  if (provider === "telegram") {
    return buildTelegramConfig(env, security);
  }

  if (provider === "discord") {
    return buildDiscordConfig(env, security);
  }

  return {
    provider: "both",
    security,
    telegram: buildTelegramConfig(env, security),
    discord: buildDiscordConfig(env, security),
  };
}





