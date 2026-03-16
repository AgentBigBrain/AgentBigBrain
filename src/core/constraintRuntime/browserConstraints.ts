/**
 * @fileoverview Validates governed browser-verification and browser-session control actions.
 */

import { BrainConfig } from "../config";
import { getNumberParam, getStringParam } from "../hardConstraintParamUtils";
import { ConstraintViolation } from "../types";
import { isLocalProbeHost, isValidProbeTimeoutMs } from "./loopbackConstraints";

/**
 * Evaluates whether a parsed `file://` browser target points to a local absolute path rather than a
 * remote file share.
 *
 * @param parsedUrl - Parsed browser target URL.
 * @returns `true` when the file URL is local-machine only and absolute.
 */
function isAllowedLocalFileBrowserUrl(parsedUrl: URL): boolean {
  if (parsedUrl.protocol !== "file:") {
    return false;
  }

  const normalizedHostname = parsedUrl.hostname.trim().toLowerCase();
  if (normalizedHostname.length > 0 && normalizedHostname !== "localhost") {
    return false;
  }

  return parsedUrl.pathname.startsWith("/");
}

/**
 * Evaluates whether a browser target is allowed for visible browser open/close control.
 *
 * @param parsedUrl - Parsed browser target URL.
 * @returns `true` when the URL is an allowed local browser target.
 */
export function isAllowedBrowserSessionControlUrl(parsedUrl: URL): boolean {
  return (
    ((parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") &&
      isLocalProbeHost(parsedUrl.hostname)) ||
    isAllowedLocalFileBrowserUrl(parsedUrl)
  );
}

/**
 * Validates one browser-target URL against local-only browser action policy.
 *
 * **Why it exists:**
 * `verify_browser` and `open_browser` share the same local-only target surface. Centralizing the
 * URL validation prevents policy drift between proof and persistent-open browser actions.
 *
 * **What it talks to:**
 * - Uses `ConstraintViolation` from `../types`.
 * - Uses `isLocalProbeHost` from `./loopbackConstraints`.
 *
 * @param urlValue - Candidate browser target URL from action params.
 * @param missingCode - Violation code used when the URL is missing.
 * @param invalidCode - Violation code used when the URL is malformed or uses a wrong protocol.
 * @param notLocalCode - Violation code used when the URL is not loopback-local.
 * @param actionLabel - Human-readable browser action label used in violation messages.
 * @returns Constraint violations describing rejected browser targets.
 */
function evaluateBrowserActionUrlConstraints(
  urlValue: string | null,
  missingCode: ConstraintViolation["code"],
  invalidCode: ConstraintViolation["code"],
  notLocalCode: ConstraintViolation["code"],
  actionLabel: string
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  if (!urlValue) {
    violations.push({
      code: missingCode,
      message: `${actionLabel} requires params.url.`
    });
    return violations;
  }

  try {
    const parsedUrl = new URL(urlValue);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      violations.push({
        code: invalidCode,
        message: `${actionLabel} url must use http or https.`
      });
    }
    if (!isLocalProbeHost(parsedUrl.hostname)) {
      violations.push({
        code: notLocalCode,
        message: `${actionLabel} url must target localhost, 127.0.0.1, or ::1.`
      });
    }
  } catch {
    violations.push({
      code: invalidCode,
      message: `${actionLabel} url must be a valid absolute URL.`
    });
  }

  return violations;
}

/**
 * Validates browser-verification requests against bounded timeout and loopback-only URL rules.
 *
 * @param params - Planned action params for `verify_browser`.
 * @param config - Active brain config with timeout bounds.
 * @returns Constraint violations describing any rejected browser-verification inputs.
 */
export function evaluateBrowserVerifyActionConstraints(
  params: Record<string, unknown>,
  config: BrainConfig
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const timeoutMs = getNumberParam(params, "timeoutMs");
  if (
    Object.prototype.hasOwnProperty.call(params, "timeoutMs") &&
    !isValidProbeTimeoutMs(timeoutMs, config)
  ) {
    violations.push({
      code: "BROWSER_VERIFY_TIMEOUT_INVALID",
      message:
        "Browser verification timeoutMs must be an integer " +
        `within ${config.shellRuntime.timeoutBoundsMs.min}..` +
        `${config.shellRuntime.timeoutBoundsMs.max}.`
    });
  }

  const urlValue = getStringParam(params, "url");
  violations.push(
    ...evaluateBrowserActionUrlConstraints(
      urlValue ?? null,
      "BROWSER_VERIFY_MISSING_URL",
      "BROWSER_VERIFY_URL_INVALID",
      "BROWSER_VERIFY_URL_NOT_LOCAL",
      "Browser verification"
    )
  );

  return violations;
}

/**
 * Validates browser-open requests against local-only URL rules.
 *
 * **Why it exists:**
 * Persistent browser opens should keep the same local-only boundary as verification while still
 * allowing the assistant to leave a real local page open when the user asked for it.
 *
 * **What it talks to:**
 * - Uses `getStringParam` from `../hardConstraintParamUtils`.
 * - Uses `evaluateBrowserActionUrlConstraints` within this module.
 *
 * @param params - Planned action params for `open_browser`.
 * @returns Constraint violations describing any rejected browser-open inputs.
 */
export function evaluateOpenBrowserActionConstraints(
  params: Record<string, unknown>
): ConstraintViolation[] {
  const urlValue = getStringParam(params, "url");
  if (!urlValue) {
    return [
      {
        code: "BROWSER_VERIFY_MISSING_URL",
        message: "Open browser requires params.url."
      }
    ];
  }

  try {
    const parsedUrl = new URL(urlValue);
    if (
      parsedUrl.protocol !== "http:" &&
      parsedUrl.protocol !== "https:" &&
      parsedUrl.protocol !== "file:"
    ) {
      return [
        {
          code: "BROWSER_VERIFY_URL_INVALID",
          message: "Open browser url must use http, https, or file."
        }
      ];
    }
    if (!isAllowedBrowserSessionControlUrl(parsedUrl)) {
      return [
        {
          code:
            parsedUrl.protocol === "file:"
              ? "BROWSER_VERIFY_URL_INVALID"
              : "BROWSER_VERIFY_URL_NOT_LOCAL",
          message:
            parsedUrl.protocol === "file:"
              ? "Open browser file URL must point to a local absolute path."
              : "Open browser url must target localhost, 127.0.0.1, ::1, or a local file URL."
        }
      ];
    }
  } catch {
    return [
      {
        code: "BROWSER_VERIFY_URL_INVALID",
        message: "Open browser url must be a valid absolute URL."
      }
    ];
  }

  return [];
}

/**
 * Validates browser-close requests against tracked-session and local-url rules.
 *
 * **Why it exists:**
 * Browser-session control should fail closed when the planner omitted both the tracked session id
 * and a concrete local URL to resolve that session from conversation context.
 *
 * **What it talks to:**
 * - Uses `getStringParam` from `../hardConstraintParamUtils`.
 * - Uses `evaluateBrowserActionUrlConstraints` within this module.
 *
 * @param params - Planned action params for `close_browser`.
 * @returns Constraint violations describing any rejected browser-close inputs.
 */
export function evaluateCloseBrowserActionConstraints(
  params: Record<string, unknown>
): ConstraintViolation[] {
  const sessionId = getStringParam(params, "sessionId");
  const urlValue = getStringParam(params, "url");
  if (!sessionId && !urlValue) {
    return [
      {
        code: "BROWSER_SESSION_MISSING_ID",
        message: "Close browser requires params.sessionId or params.url."
      }
    ];
  }
  if (!urlValue) {
    return [];
  }
  try {
    const parsedUrl = new URL(urlValue);
    if (
      parsedUrl.protocol !== "http:" &&
      parsedUrl.protocol !== "https:" &&
      parsedUrl.protocol !== "file:"
    ) {
      return [
        {
          code: "BROWSER_VERIFY_URL_INVALID",
          message: "Close browser url must use http, https, or file."
        }
      ];
    }
    if (!isAllowedBrowserSessionControlUrl(parsedUrl)) {
      return [
        {
          code:
            parsedUrl.protocol === "file:"
              ? "BROWSER_VERIFY_URL_INVALID"
              : "BROWSER_VERIFY_URL_NOT_LOCAL",
          message:
            parsedUrl.protocol === "file:"
              ? "Close browser file URL must point to a local absolute path."
              : "Close browser url must target localhost, 127.0.0.1, ::1, or a local file URL."
        }
      ];
    }
  } catch {
    return [
      {
        code: "BROWSER_VERIFY_URL_INVALID",
        message: "Close browser url must be a valid absolute URL."
      }
    ];
  }

  return [];
}
