/**
 * @fileoverview Parses owner/operator principal configuration separate from interface ingress allowlists.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type ConfiguredPrincipalProvider = "telegram" | "discord";
export type PrincipalConfigSource = "env" | "config_file" | "test_override";
export type ResolvedOwnerOperatorRole = "owner" | "operator";

export interface ConfiguredPrincipal {
  provider: ConfiguredPrincipalProvider;
  providerUserId: string;
  providerUserIdHash: string;
  label?: string;
}

export interface OwnerOperatorPrincipalConfig {
  ownerPrincipals: readonly ConfiguredPrincipal[];
  operatorPrincipals: readonly ConfiguredPrincipal[];
  localOperatorTrustedMode: boolean;
  hmacKeyConfigured: boolean;
  redactProviderUserId: (
    provider: ConfiguredPrincipalProvider,
    providerUserId: string
  ) => string | null;
  source: PrincipalConfigSource;
}

export interface OwnerOperatorPrincipalEnv {
  [key: string]: string | undefined;
  BRAIN_OWNER_TELEGRAM_USER_IDS?: string;
  BRAIN_OWNER_DISCORD_USER_IDS?: string;
  BRAIN_OPERATOR_TELEGRAM_USER_IDS?: string;
  BRAIN_OPERATOR_DISCORD_USER_IDS?: string;
  BRAIN_LOCAL_OPERATOR_TRUSTED_MODE?: string;
  BRAIN_PRINCIPAL_HMAC_KEY?: string;
}

export interface ResolvedOwnerOperatorPrincipal {
  role: ResolvedOwnerOperatorRole;
  principal: ConfiguredPrincipal;
}

/**
 * Parses owner/operator principal config from environment values.
 */
export function createOwnerOperatorPrincipalConfigFromEnv(
  env: OwnerOperatorPrincipalEnv,
  source: PrincipalConfigSource = "env"
): OwnerOperatorPrincipalConfig {
  const hmacKey = normalizeHmacKey(env.BRAIN_PRINCIPAL_HMAC_KEY);
  const ownerSources = [
    parseConfiguredPrincipalList("telegram", env.BRAIN_OWNER_TELEGRAM_USER_IDS, hmacKey),
    parseConfiguredPrincipalList("discord", env.BRAIN_OWNER_DISCORD_USER_IDS, hmacKey)
  ].flat();
  const operatorSources = [
    parseConfiguredPrincipalList("telegram", env.BRAIN_OPERATOR_TELEGRAM_USER_IDS, hmacKey),
    parseConfiguredPrincipalList("discord", env.BRAIN_OPERATOR_DISCORD_USER_IDS, hmacKey)
  ].flat();

  return {
    ownerPrincipals: dedupePrincipals(ownerSources),
    operatorPrincipals: dedupePrincipals(operatorSources),
    localOperatorTrustedMode: parseStrictBoolean(env.BRAIN_LOCAL_OPERATOR_TRUSTED_MODE),
    hmacKeyConfigured: hmacKey !== null,
    redactProviderUserId: (provider, providerUserId) =>
      hmacKey ? hmacProviderUserId(hmacKey, provider, providerUserId) : null,
    source
  };
}

/**
 * Resolves an exact configured provider principal role.
 */
export function resolveOwnerOperatorPrincipalRole(
  config: OwnerOperatorPrincipalConfig | null | undefined,
  provider: ConfiguredPrincipalProvider,
  providerUserId: string | null | undefined
): ResolvedOwnerOperatorPrincipal | null {
  const normalizedId = normalizeProviderUserId(providerUserId);
  if (!config || !normalizedId) {
    return null;
  }

  const owner = findConfiguredPrincipal(config.ownerPrincipals, provider, normalizedId);
  if (owner) {
    return { role: "owner", principal: owner };
  }

  const operator = findConfiguredPrincipal(config.operatorPrincipals, provider, normalizedId);
  return operator ? { role: "operator", principal: operator } : null;
}

/**
 * Redacts a provider user id for audit/log surfaces.
 */
export function redactProviderUserIdForPrincipalAudit(
  hmacKey: string,
  provider: ConfiguredPrincipalProvider,
  providerUserId: string
): string {
  const normalizedKey = normalizeHmacKey(hmacKey);
  if (!normalizedKey) {
    throw new Error("BRAIN_PRINCIPAL_HMAC_KEY is required for principal id redaction.");
  }
  return hmacProviderUserId(normalizedKey, provider, providerUserId);
}

/**
 * Implements `parseConfiguredPrincipalList` behavior within this module.
 */
function parseConfiguredPrincipalList(
  provider: ConfiguredPrincipalProvider,
  rawValue: string | undefined,
  hmacKey: string | null
): ConfiguredPrincipal[] {
  const ids = parseCsv(rawValue);
  if (ids.length === 0) {
    return [];
  }
  if (!hmacKey) {
    throw new Error(
      "BRAIN_PRINCIPAL_HMAC_KEY is required when owner/operator principal ids are configured."
    );
  }
  return ids.map((id) => {
    const normalizedId = normalizeProviderUserId(id);
    if (!normalizedId || !isSafeProviderUserId(normalizedId)) {
      throw new Error("Owner/operator provider user ids must be non-empty safe identifier tokens.");
    }
    return {
      provider,
      providerUserId: normalizedId,
      providerUserIdHash: hmacProviderUserId(hmacKey, provider, normalizedId)
    };
  });
}

/**
 * Implements `parseCsv` behavior within this module.
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
 * Implements `parseStrictBoolean` behavior within this module.
 */
function parseStrictBoolean(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

/**
 * Implements `normalizeHmacKey` behavior within this module.
 */
function normalizeHmacKey(value: string | undefined): string | null {
  const normalized = (value ?? "").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length < 16) {
    throw new Error("BRAIN_PRINCIPAL_HMAC_KEY must be at least 16 characters.");
  }
  return normalized;
}

/**
 * Implements `normalizeProviderUserId` behavior within this module.
 */
function normalizeProviderUserId(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Implements `isSafeProviderUserId` behavior within this module.
 */
function isSafeProviderUserId(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isUpperAlpha = code >= 65 && code <= 90;
    const isLowerAlpha = code >= 97 && code <= 122;
    const isAllowedPunctuation =
      char === "_" || char === "." || char === ":" || char === "-";
    if (!isDigit && !isUpperAlpha && !isLowerAlpha && !isAllowedPunctuation) {
      return false;
    }
  }
  return true;
}

/**
 * Implements `hmacProviderUserId` behavior within this module.
 */
function hmacProviderUserId(
  hmacKey: string,
  provider: ConfiguredPrincipalProvider,
  providerUserId: string
): string {
  const digest = createHmac("sha256", hmacKey)
    .update(`${provider}:${providerUserId}`)
    .digest("base64url");
  return `${provider}:${digest.slice(0, 32)}`;
}

/**
 * Implements `dedupePrincipals` behavior within this module.
 */
function dedupePrincipals(principals: readonly ConfiguredPrincipal[]): ConfiguredPrincipal[] {
  const byKey = new Map<string, ConfiguredPrincipal>();
  for (const principal of principals) {
    byKey.set(`${principal.provider}:${principal.providerUserId}`, principal);
  }
  return [...byKey.values()];
}

/**
 * Implements `findConfiguredPrincipal` behavior within this module.
 */
function findConfiguredPrincipal(
  principals: readonly ConfiguredPrincipal[],
  provider: ConfiguredPrincipalProvider,
  providerUserId: string
): ConfiguredPrincipal | null {
  const normalizedId = normalizeProviderUserId(providerUserId);
  if (!normalizedId) {
    return null;
  }
  for (const principal of principals) {
    if (principal.provider !== provider) {
      continue;
    }
    const candidate = Buffer.from(principal.providerUserId);
    const input = Buffer.from(normalizedId);
    if (candidate.length === input.length && timingSafeEqual(candidate, input)) {
      return principal;
    }
  }
  return null;
}
