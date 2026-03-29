/**
 * @fileoverview Parses and evaluates deterministic outbound federation delegation policy and explicit task intent tags.
 */

import { TaskRequest } from "./types";

/**
 * One allowed outbound federation target contract entry.
 */
export interface FederatedOutboundTargetContract {
  externalAgentId: string;
  baseUrl: string;
  sharedSecret: string;
  maxQuotedCostUsd: number;
  awaitTimeoutMs: number;
  pollIntervalMs: number;
}

/**
 * Runtime-level outbound federation policy configuration.
 */
export interface FederatedOutboundRuntimeConfig {
  enabled: boolean;
  targets: readonly FederatedOutboundTargetContract[];
}

/**
 * Explicit task-level delegation intent parsed from user input.
 */
export interface FederatedOutboundIntent {
  targetAgentId: string;
  quotedCostUsd: number;
  delegatedUserInput: string;
}

/**
 * Deterministic policy decision for outbound federation routing.
 */
export interface FederatedOutboundPolicyDecision {
  shouldDelegate: boolean;
  reasonCode:
  | "NO_OUTBOUND_DELEGATION_INTENT"
  | "OUTBOUND_FEDERATION_DISABLED"
  | "OUTBOUND_TARGET_NOT_ALLOWLISTED"
  | "OUTBOUND_QUOTE_EXCEEDED"
  | "OUTBOUND_DELEGATION_ALLOWED";
  reason: string;
  intent: FederatedOutboundIntent | null;
  target: FederatedOutboundTargetContract | null;
}

/**
 * Parses permissive boolean env values.
 *
 * **Why it exists:**
 * Keeps outbound federation flag parsing deterministic and consistent with existing env-gate patterns.
 *
 * **What it talks to:**
 * - Local normalization rules only.
 *
 * @param value - Raw environment variable value.
 * @param fallback - Fallback value when env is missing or malformed.
 * @returns Parsed boolean value.
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
 * Parses and validates bounded integer env values.
 *
 * **Why it exists:**
 * Outbound federation polling/timeout controls must fail closed on malformed numeric inputs.
 *
 * **What it talks to:**
 * - Local integer validation rules.
 *
 * @param value - Raw environment variable value.
 * @param fallback - Default value when env key is missing.
 * @param min - Inclusive lower bound.
 * @param max - Inclusive upper bound.
 * @param envName - Env key label for deterministic error messages.
 * @returns Validated integer value.
 */
function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  envName: string
): number {
  const raw = value?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${envName} must be an integer between ${min} and ${max}.`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${envName} must be between ${min} and ${max} (inclusive).`);
  }
  return parsed;
}

/**
 * Parses and validates one outbound target object.
 *
 * **Why it exists:**
 * Security-sensitive federation targets require deterministic schema checks at startup-time config parse.
 *
 * **What it talks to:**
 * - `FederatedOutboundTargetContract` shape rules.
 *
 * @param candidate - Parsed JSON entry candidate.
 * @returns Validated target contract.
 */
function parseOutboundTargetCandidate(candidate: unknown): FederatedOutboundTargetContract {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Each outbound federation target must be an object.");
  }

  const contract = candidate as Partial<FederatedOutboundTargetContract>;
  const externalAgentId = (contract.externalAgentId ?? "").trim();
  const baseUrl = (contract.baseUrl ?? "").trim();
  const sharedSecret = (contract.sharedSecret ?? "").trim();
  const maxQuotedCostUsd = Number(contract.maxQuotedCostUsd);

  if (!externalAgentId) {
    throw new Error("Outbound federation target requires non-empty externalAgentId.");
  }
  if (!baseUrl) {
    throw new Error(`Outbound target "${externalAgentId}" requires non-empty baseUrl.`);
  }
  if (!sharedSecret) {
    throw new Error(`Outbound target "${externalAgentId}" requires non-empty sharedSecret.`);
  }
  if (!Number.isFinite(maxQuotedCostUsd) || maxQuotedCostUsd < 0) {
    throw new Error(
      `Outbound target "${externalAgentId}" requires non-negative maxQuotedCostUsd.`
    );
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error(`Outbound target "${externalAgentId}" has invalid baseUrl.`);
  }
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new Error(
      `Outbound target "${externalAgentId}" baseUrl must use http:// or https:// protocol.`
    );
  }

  return {
    externalAgentId,
    baseUrl: parsedBaseUrl.toString().replace(/\/+$/, ""),
    sharedSecret,
    maxQuotedCostUsd,
    awaitTimeoutMs: parseBoundedInteger(
      String((contract.awaitTimeoutMs as number | undefined) ?? ""),
      15_000,
      1_000,
      600_000,
      `awaitTimeoutMs(${externalAgentId})`
    ),
    pollIntervalMs: parseBoundedInteger(
      String((contract.pollIntervalMs as number | undefined) ?? ""),
      250,
      25,
      10_000,
      `pollIntervalMs(${externalAgentId})`
    )
  };
}

/**
 * Creates outbound federation runtime config from environment variables.
 *
 * **Why it exists:**
 * Centralizes config parsing so production runtime and tests evaluate the same fail-closed env contract.
 *
 * **What it talks to:**
 * - Env gates `BRAIN_ENABLE_OUTBOUND_FEDERATION` and `BRAIN_FEDERATION_OUTBOUND_TARGETS_JSON`.
 *
 * @param env - Environment dictionary for config resolution.
 * @returns Parsed outbound federation runtime config.
 */
export function createFederatedOutboundRuntimeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): FederatedOutboundRuntimeConfig {
  const enabled = parseBoolean(env.BRAIN_ENABLE_OUTBOUND_FEDERATION, false);
  if (!enabled) {
    return {
      enabled: false,
      targets: []
    };
  }

  const rawTargets = env.BRAIN_FEDERATION_OUTBOUND_TARGETS_JSON?.trim();
  if (!rawTargets) {
    throw new Error(
      "BRAIN_FEDERATION_OUTBOUND_TARGETS_JSON is required when outbound federation is enabled."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawTargets);
  } catch {
    throw new Error("BRAIN_FEDERATION_OUTBOUND_TARGETS_JSON must be valid JSON.");
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      "BRAIN_FEDERATION_OUTBOUND_TARGETS_JSON must be a non-empty JSON array."
    );
  }

  const targets: FederatedOutboundTargetContract[] = [];
  const seen = new Set<string>();
  for (const candidate of parsed) {
    const contract = parseOutboundTargetCandidate(candidate);
    if (seen.has(contract.externalAgentId)) {
      throw new Error(
        `Duplicate outbound federation target for externalAgentId "${contract.externalAgentId}".`
      );
    }
    seen.add(contract.externalAgentId);
    targets.push(contract);
  }

  return {
    enabled: true,
    targets
  };
}

/**
 * Parses explicit outbound federation intent from user input.
 *
 * **Why it exists:**
 * Delegation must be explicit and deterministic; this parser avoids hidden/autonomous routing.
 *
 * **What it talks to:**
 * - Outbound intent tag format: `[federate:<agentId> quote=<usd>] <delegated user input>`.
 *
 * @param userInput - Raw task user input text.
 * @returns Parsed outbound delegation intent or `null` when no intent tag is present.
 */
export function parseFederatedOutboundIntent(
  userInput: string
): FederatedOutboundIntent | null {
  const trimmed = userInput.trim();
  if (!trimmed.toLowerCase().startsWith("[federate:")) {
    return null;
  }
  const closingBracketIndex = trimmed.indexOf("]");
  if (closingBracketIndex < 0) {
    return null;
  }
  const header = trimmed.slice(1, closingBracketIndex).trim();
  const delegatedUserInput = trimmed.slice(closingBracketIndex + 1).trim();
  if (!delegatedUserInput) {
    return null;
  }
  const headerBody = header.slice("federate:".length).trim();
  const quoteIndex = headerBody.toLowerCase().indexOf(" quote=");
  if (quoteIndex <= 0) {
    return null;
  }
  const targetAgentId = headerBody.slice(0, quoteIndex).trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(targetAgentId)) {
    return null;
  }
  const quotedCostUsd = Number(headerBody.slice(quoteIndex + " quote=".length).trim());
  if (!Number.isFinite(quotedCostUsd) || quotedCostUsd < 0) {
    return null;
  }

  return {
    targetAgentId,
    quotedCostUsd,
    delegatedUserInput
  };
}

/**
 * Evaluates whether a task should route through outbound federated delegation.
 *
 * **Why it exists:**
 * Keeps all routing checks (explicit intent, enable latch, target allowlist, quote limits) in one place.
 *
 * **What it talks to:**
 * - Task input payload.
 * - Outbound runtime config and target contracts.
 *
 * @param task - Incoming task request.
 * @param config - Outbound federation runtime config.
 * @returns Deterministic policy decision with reason code and matched target.
 */
export function evaluateFederatedOutboundPolicy(
  task: TaskRequest,
  config: FederatedOutboundRuntimeConfig
): FederatedOutboundPolicyDecision {
  const intent = parseFederatedOutboundIntent(task.userInput);
  if (!intent) {
    return {
      shouldDelegate: false,
      reasonCode: "NO_OUTBOUND_DELEGATION_INTENT",
      reason: "Task did not include explicit outbound federation intent tag.",
      intent: null,
      target: null
    };
  }

  if (!config.enabled) {
    return {
      shouldDelegate: false,
      reasonCode: "OUTBOUND_FEDERATION_DISABLED",
      reason: "Outbound federation runtime mode is disabled by config.",
      intent,
      target: null
    };
  }

  const target = config.targets.find(
    (candidate) => candidate.externalAgentId === intent.targetAgentId
  );
  if (!target) {
    return {
      shouldDelegate: false,
      reasonCode: "OUTBOUND_TARGET_NOT_ALLOWLISTED",
      reason: `No allowlisted outbound federation target matched "${intent.targetAgentId}".`,
      intent,
      target: null
    };
  }

  if (intent.quotedCostUsd > target.maxQuotedCostUsd) {
    return {
      shouldDelegate: false,
      reasonCode: "OUTBOUND_QUOTE_EXCEEDED",
      reason:
        `Delegation quote ${intent.quotedCostUsd.toFixed(2)} exceeds target cap ` +
        `${target.maxQuotedCostUsd.toFixed(2)}.`,
      intent,
      target
    };
  }

  return {
    shouldDelegate: true,
    reasonCode: "OUTBOUND_DELEGATION_ALLOWED",
    reason: "Task includes explicit federated delegation intent and passes target/quote policy.",
    intent,
    target
  };
}

