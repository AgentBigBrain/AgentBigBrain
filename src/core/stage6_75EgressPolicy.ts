/**
 * @fileoverview Deterministic Stage 6.75 secrets-redaction and network-egress policy helpers for private-range and token-leak prevention.
 */

import { Stage675BlockCode } from "./types";

export interface EgressDecision {
  ok: boolean;
  blockCode: Stage675BlockCode | null;
  reason: string;
}

export interface RedactionResult {
  redactedText: string;
  redactionCount: number;
  redactionTypes: readonly string[];
}

const TOKEN_PATTERNS: readonly { type: string; pattern: RegExp }[] = [
  {
    type: "bearer_token",
    pattern: /Bearer\s+[A-Za-z0-9._-]{8,}/g
  },
  {
    type: "api_key_assignment",
    pattern: /(api[_-]?key|token|secret)\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}/gi
  },
  {
    type: "cookie_header",
    pattern: /cookie:\s*[^;\n]+/gi
  }
] as const;

/**
 * Evaluates stage675 egress policy and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the stage675 egress policy policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param targetUrl - Value for target url.
 * @returns Computed `EgressDecision` result.
 */
export function evaluateStage675EgressPolicy(targetUrl: string): EgressDecision {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return {
      ok: false,
      blockCode: "NETWORK_EGRESS_POLICY_BLOCKED",
      reason: "Target URL is invalid."
    };
  }

  const host = parsedUrl.hostname.toLowerCase();
  if (host === "localhost" || host === "::1") {
    return {
      ok: false,
      blockCode: "NETWORK_EGRESS_POLICY_BLOCKED",
      reason: "Localhost egress is denied."
    };
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host)) {
    return {
      ok: false,
      blockCode: "NETWORK_EGRESS_POLICY_BLOCKED",
      reason: "Private-range IPv4 egress is denied."
    };
  }
  if (host.endsWith(".local")) {
    return {
      ok: false,
      blockCode: "NETWORK_EGRESS_POLICY_BLOCKED",
      reason: ".local egress is denied by default."
    };
  }
  if (host.includes("metadata")) {
    return {
      ok: false,
      blockCode: "NETWORK_EGRESS_POLICY_BLOCKED",
      reason: "Metadata endpoint egress is denied."
    };
  }
  return {
    ok: true,
    blockCode: null,
    reason: "Egress target passed deterministic policy."
  };
}

/**
 * Implements redact sensitive egress text behavior used by `stage6_75EgressPolicy`.
 *
 * **Why it exists:**
 * Defines public behavior from `stage6_75EgressPolicy.ts` for other modules/tests.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @returns Computed `RedactionResult` result.
 */
export function redactSensitiveEgressText(text: string): RedactionResult {
  let redactedText = text;
  let redactionCount = 0;
  const redactionTypes = new Set<string>();

  for (const { type, pattern } of TOKEN_PATTERNS) {
    redactedText = redactedText.replace(pattern, (match) => {
      redactionCount += 1;
      redactionTypes.add(type);
      return `[REDACTED_${type.toUpperCase()}]`;
    });
  }

  return {
    redactedText,
    redactionCount,
    redactionTypes: [...redactionTypes].sort((left, right) => left.localeCompare(right))
  };
}
