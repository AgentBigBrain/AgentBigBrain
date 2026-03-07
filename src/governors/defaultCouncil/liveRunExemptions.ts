/**
 * @fileoverview Detects bounded localhost live-run actions that should bypass generic model-advisory drift.
 */

import { getParamString, normalize } from "./common";
import { DefaultGovernanceProposal } from "./contracts";

/**
 * Evaluates whether a hostname is loopback-local and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps loopback host checks centralized so governor exemptions for localhost proof actions stay
 * narrow, explicit, and consistent across action shapes.
 *
 * **What it talks to:**
 * - Uses shared normalization helpers from this subsystem.
 *
 * @param host - Raw hostname candidate.
 * @returns `true` when the host is localhost, 127.0.0.1, or ::1.
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  const normalized = normalize((host ?? "").trim());
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * Reads loopback hostname from a URL-like action param.
 *
 * **Why it exists:**
 * Local proof actions encode loopback targets as URLs, so governors need one parsing helper that
 * fails closed without scattering URL parsing logic.
 *
 * **What it talks to:**
 * - Uses the built-in `URL` parser and local helpers only.
 *
 * @param rawUrl - Raw URL candidate from action params.
 * @returns Parsed hostname when the URL is valid, otherwise `null`.
 */
export function parseLoopbackHostnameFromUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) {
    return null;
  }
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
}

/**
 * Evaluates command text and returns whether it looks like a bounded local server/dev-session start.
 *
 * **Why it exists:**
 * Managed-process advisory exemptions must stay narrow, so this helper limits them to commands that
 * clearly start a local server or dev session rather than any arbitrary long-running process.
 *
 * **What it talks to:**
 * - Uses shared normalization helpers from this subsystem.
 *
 * @param command - Raw command candidate from action params.
 * @returns `true` when the command matches a bounded local live-run pattern.
 */
export function isLocalServerStartCommand(command: string | undefined): boolean {
  const normalized = normalize((command ?? "").trim());
  if (!normalized) {
    return false;
  }
  return (
    /\bpython\s+-m\s+http\.server\b/.test(normalized) ||
    /\bpython(?:3)?\b[\s\S]{0,40}\b(?:serve|server|preview|dev)[^\\/\s]*\.py\b/.test(normalized) ||
    /\bnpm\s+(?:start|run\s+dev)\b/.test(normalized) ||
    /\b(?:pnpm|yarn)\s+(?:start|dev)\b/.test(normalized) ||
    /\b(?:next|vite)\s+dev\b/.test(normalized) ||
    /\bnode\b[\s\S]{0,40}\bserver\.(?:js|cjs|mjs)\b/.test(normalized)
  );
}

/**
 * Evaluates proposal and returns whether it is a bounded managed-process live-run action.
 *
 * **Why it exists:**
 * Start/check/stop actions for local live verification already run behind deterministic shell and
 * lease constraints, so generic advisory model drift should not re-ban them as local-machine
 * execution during legitimate localhost verification flows.
 *
 * **What it talks to:**
 * - Uses default governor contracts within this subsystem.
 * - Uses shared param parsing helpers within this subsystem.
 *
 * @param proposal - Proposal under governor review.
 * @returns `true` when the proposal is a bounded managed-process live-run action.
 */
export function isManagedProcessLiveRunAction(
  proposal: DefaultGovernanceProposal
): boolean {
  const action = proposal.action;
  if (action.type === "check_process" || action.type === "stop_process") {
    return true;
  }
  if (action.type !== "start_process") {
    return false;
  }
  return isLocalServerStartCommand(getParamString(action.params, "command"));
}

/**
 * Evaluates proposal and returns whether it is a loopback-local proof action.
 *
 * **Why it exists:**
 * Loopback readiness and browser proof actions already pass deterministic localhost hard
 * constraints, so conservative model-advisory vetoes from non-safety governors should not block
 * them due to language drift.
 *
 * **What it talks to:**
 * - Uses default governor contracts within this subsystem.
 * - Uses shared param parsing helpers within this subsystem.
 *
 * @param proposal - Proposal under governor review.
 * @returns `true` when the proposal is a loopback proof action.
 */
export function isLoopbackProofAction(proposal: DefaultGovernanceProposal): boolean {
  const action = proposal.action;
  if (action.type === "probe_port") {
    return isLoopbackHost(getParamString(action.params, "host") ?? "127.0.0.1");
  }
  if (action.type === "probe_http" || action.type === "verify_browser") {
    return isLoopbackHost(parseLoopbackHostnameFromUrl(getParamString(action.params, "url")));
  }
  return false;
}
