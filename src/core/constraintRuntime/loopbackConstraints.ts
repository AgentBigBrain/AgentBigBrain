import { BrainConfig } from "../config";
import { getNumberParam, getStringParam } from "../hardConstraintParamUtils";
import { ConstraintViolation } from "../types";

/**
 * Checks whether a host value is one of the supported local loopback targets.
 *
 * @param host - Hostname or IP extracted from the planned action.
 * @returns `true` when the host points to localhost or loopback.
 */
export function isLocalProbeHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalizedHost === "localhost" || normalizedHost === "127.0.0.1" || normalizedHost === "::1";
}

/**
 * Validates an optional probe timeout against the configured shell-runtime timeout bounds.
 *
 * @param timeoutMs - Optional timeout supplied by the planner.
 * @param config - Active brain config with timeout bounds.
 * @returns `true` when the timeout is absent or within configured bounds.
 */
export function isValidProbeTimeoutMs(
  timeoutMs: number | undefined,
  config: BrainConfig
): boolean {
  if (timeoutMs === undefined) {
    return true;
  }

  return (
    Number.isInteger(timeoutMs) &&
    timeoutMs >= config.shellRuntime.timeoutBoundsMs.min &&
    timeoutMs <= config.shellRuntime.timeoutBoundsMs.max
  );
}

/**
 * Validates localhost readiness-probe requests for both port and HTTP probe actions.
 *
 * @param actionType - Probe action type being validated.
 * @param params - Planned action params.
 * @param config - Active brain config with timeout bounds.
 * @returns Constraint violations for invalid loopback probe requests.
 */
export function evaluateProbeActionConstraints(
  actionType: "probe_port" | "probe_http",
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
      code: "PROBE_TIMEOUT_INVALID",
      message:
        "Readiness probe timeoutMs must be an integer " +
        `within ${config.shellRuntime.timeoutBoundsMs.min}..` +
        `${config.shellRuntime.timeoutBoundsMs.max}.`
    });
  }

  if (actionType === "probe_port") {
    const host = getStringParam(params, "host");
    const port = getNumberParam(params, "port");
    if (port === undefined) {
      violations.push({
        code: "PROBE_MISSING_PORT",
        message: "Port probe requires params.port."
      });
    } else if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      violations.push({
        code: "PROBE_PORT_INVALID",
        message: "Port probe params.port must be an integer within 1..65535."
      });
    }

    if (host && !isLocalProbeHost(host)) {
      violations.push({
        code: "PROBE_HOST_NOT_LOCAL",
        message: "Port probe host must be localhost, 127.0.0.1, or ::1."
      });
    }
    return violations;
  }

  const urlValue = getStringParam(params, "url");
  if (!urlValue) {
    violations.push({
      code: "PROBE_MISSING_URL",
      message: "HTTP probe requires params.url."
    });
    return violations;
  }

  try {
    const parsedUrl = new URL(urlValue);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      violations.push({
        code: "PROBE_URL_INVALID",
        message: "HTTP probe url must use http or https."
      });
    }
    if (!isLocalProbeHost(parsedUrl.hostname)) {
      violations.push({
        code: "PROBE_URL_NOT_LOCAL",
        message: "HTTP probe url must target localhost, 127.0.0.1, or ::1."
      });
    }
  } catch {
    violations.push({
      code: "PROBE_URL_INVALID",
      message: "HTTP probe url must be a valid absolute URL."
    });
  }

  return violations;
}
