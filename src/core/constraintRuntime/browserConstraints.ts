import { BrainConfig } from "../config";
import { getNumberParam, getStringParam } from "../hardConstraintParamUtils";
import { ConstraintViolation } from "../types";
import { isLocalProbeHost, isValidProbeTimeoutMs } from "./loopbackConstraints";

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
  if (!urlValue) {
    violations.push({
      code: "BROWSER_VERIFY_MISSING_URL",
      message: "Browser verification requires params.url."
    });
    return violations;
  }

  try {
    const parsedUrl = new URL(urlValue);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      violations.push({
        code: "BROWSER_VERIFY_URL_INVALID",
        message: "Browser verification url must use http or https."
      });
    }
    if (!isLocalProbeHost(parsedUrl.hostname)) {
      violations.push({
        code: "BROWSER_VERIFY_URL_NOT_LOCAL",
        message: "Browser verification url must target localhost, 127.0.0.1, or ::1."
      });
    }
  } catch {
    violations.push({
      code: "BROWSER_VERIFY_URL_INVALID",
      message: "Browser verification url must be a valid absolute URL."
    });
  }

  return violations;
}
