/**
 * @fileoverview Rewrites same-plan live-run proof actions onto the actual managed preview target.
 */

import type { ActionRunResult, PlannedAction } from "../types";

export interface LoopbackTargetOverride {
  originalHost: string;
  originalPort: number;
  originalUrl: string | null;
  actualHost: string;
  actualPort: number;
  actualUrl: string | null;
  previewProcessLeaseId: string | null;
  workspaceRoot: string | null;
}

interface ParsedLoopbackUrlTarget {
  readonly host: string;
  readonly port: number;
  readonly pathAndSearch: string;
}

export interface RuntimeInspectionTargetOverride {
  rootPath: string | null;
  previewUrl: string | null;
  previewProcessLeaseId: string | null;
}

const AUTONOMOUS_RUNTIME_INSPECTION_TARGET_PREFIX =
  "AUTONOMOUS_RUNTIME_INSPECTION_TARGET ";

/**
 * Normalizes loopback host.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param host - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function normalizeLoopbackHost(host: string | null): string | null {
  if (!host) {
    return null;
  }
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  ) {
    return normalized;
  }
  return null;
}

/**
 * Loopbacks hosts are equivalent.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param left - Input consumed by this helper.
 * @param right - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function loopbackHostsAreEquivalent(left: string, right: string): boolean {
  const normalizedLeft = normalizeLoopbackHost(left);
  const normalizedRight = normalizeLoopbackHost(right);
  return normalizedLeft !== null && normalizedRight !== null;
}

/**
 * Parses loopback url target.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param urlValue - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function parseLoopbackUrlTarget(urlValue: unknown): ParsedLoopbackUrlTarget | null {
  if (typeof urlValue !== "string" || urlValue.trim().length === 0) {
    return null;
  }
  try {
    const parsedUrl = new URL(urlValue);
    const normalizedHost = normalizeLoopbackHost(parsedUrl.hostname);
    if (!normalizedHost) {
      return null;
    }
    const port =
      parsedUrl.port.trim().length > 0
        ? Number.parseInt(parsedUrl.port, 10)
        : parsedUrl.protocol === "https:"
          ? 443
          : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return null;
    }
    const pathname = parsedUrl.pathname && parsedUrl.pathname.length > 0 ? parsedUrl.pathname : "/";
    return {
      host: normalizedHost,
      port,
      pathAndSearch: `${pathname}${parsedUrl.search ?? ""}`
    };
  } catch {
    return null;
  }
}

/**
 * Builds loopback url.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param host - Input consumed by this helper.
 * @param port - Input consumed by this helper.
 * @param pathAndSearch - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function buildLoopbackUrl(host: string, port: number, pathAndSearch: string): string {
  const printableHost = host === "::1" ? "[::1]" : host;
  const normalizedPathAndSearch =
    pathAndSearch.trim().length > 0 ? pathAndSearch : "/";
  return `http://${printableHost}:${port}${normalizedPathAndSearch}`;
}

/**
 * Normalizes optional string.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Parses the machine-authored autonomous runtime inspection target carried in task input.
 *
 * @param userInput - Task-level user input text.
 * @returns Parsed inspection target override, or `null` when absent or invalid.
 */
export function readRuntimeInspectionTargetOverride(
  userInput: string | null | undefined
): RuntimeInspectionTargetOverride | null {
  if (typeof userInput !== "string" || userInput.trim().length === 0) {
    return null;
  }
  let parsedOverride: RuntimeInspectionTargetOverride | null = null;
  for (const rawLine of userInput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith(AUTONOMOUS_RUNTIME_INSPECTION_TARGET_PREFIX)) {
      continue;
    }
    const payload = line.slice(AUTONOMOUS_RUNTIME_INSPECTION_TARGET_PREFIX.length).trim();
    if (payload.length === 0) {
      continue;
    }
    try {
      const decoded = JSON.parse(payload) as Record<string, unknown>;
      parsedOverride = {
        rootPath: normalizeOptionalString(decoded.rootPath),
        previewUrl: normalizeOptionalString(decoded.previewUrl),
        previewProcessLeaseId: normalizeOptionalString(decoded.previewProcessLeaseId)
      };
    } catch {
      continue;
    }
  }
  return parsedOverride;
}

/**
 * Evaluates whether missing preview process lease id.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function isMissingPreviewProcessLeaseId(value: unknown): boolean {
  const normalized = normalizeOptionalString(value);
  return normalized === null || normalized.toLowerCase() === "none";
}

/**
 * Finds matching loopback target override.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `PlannedAction` (import `PlannedAction`) from `../types`.
 * @param action - Input consumed by this helper.
 * @param overrides - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function findMatchingLoopbackTargetOverride(
  action: PlannedAction,
  overrides: readonly LoopbackTargetOverride[]
): LoopbackTargetOverride | null {
  switch (action.type) {
    case "probe_port": {
      const host = normalizeLoopbackHost(
        typeof action.params.host === "string" ? action.params.host : null
      );
      const port =
        typeof action.params.port === "number" && Number.isInteger(action.params.port)
          ? action.params.port
          : null;
      if (!host || port === null) {
        return null;
      }
      return (
        overrides.find(
          (override) =>
            override.originalPort === port &&
            loopbackHostsAreEquivalent(override.originalHost, host)
        ) ?? null
      );
    }
    case "probe_http":
    case "verify_browser":
    case "open_browser": {
      const parsedTarget = parseLoopbackUrlTarget(action.params.url);
      if (!parsedTarget) {
        return null;
      }
      return (
        overrides.find(
          (override) =>
            override.originalPort === parsedTarget.port &&
            loopbackHostsAreEquivalent(override.originalHost, parsedTarget.host)
        ) ?? null
      );
    }
    default:
      return null;
  }
}

/**
 * Applies any known managed-preview target override to the current same-plan live-run action.
 *
 * @param action - Planned action to evaluate.
 * @param overrides - Active same-plan target overrides remembered from earlier approved starts.
 * @returns Effective action with updated loopback target metadata when an override applies.
 */
export function applyLiveRunTargetOverrides(
  action: PlannedAction,
  overrides: readonly LoopbackTargetOverride[]
): PlannedAction {
  const override = findMatchingLoopbackTargetOverride(action, overrides);
  if (!override) {
    return action;
  }

  switch (action.type) {
    case "probe_port":
      return {
        ...action,
        params: {
          ...action.params,
          host: override.actualHost,
          port: override.actualPort
        }
      };
    case "probe_http":
    case "verify_browser": {
      const parsedTarget = parseLoopbackUrlTarget(action.params.url);
      if (!parsedTarget) {
        return action;
      }
      return {
        ...action,
        params: {
          ...action.params,
          url: buildLoopbackUrl(
            override.actualHost,
            override.actualPort,
            parsedTarget.pathAndSearch
          )
        }
      };
    }
    case "open_browser": {
      const parsedTarget = parseLoopbackUrlTarget(action.params.url);
      const nextUrl = parsedTarget
        ? buildLoopbackUrl(
            override.actualHost,
            override.actualPort,
            parsedTarget.pathAndSearch
          )
        : action.params.url;
      return {
        ...action,
        params: {
          ...action.params,
          url: nextUrl,
          previewProcessLeaseId:
            override.previewProcessLeaseId ??
            (
              isMissingPreviewProcessLeaseId(action.params.previewProcessLeaseId)
                ? undefined
                : action.params.previewProcessLeaseId
            ),
          rootPath: override.workspaceRoot ?? action.params.rootPath
        }
      };
    }
    default:
      return action;
  }
}

/**
 * Applies the exact runtime-owned inspection target hint generated by autonomous recovery.
 *
 * @param action - Planned action to evaluate.
 * @param userInput - Task-level user input text that may include a machine-authored hint.
 * @returns Effective action with exact inspection params when a hint applies.
 */
export function applyRuntimeInspectionTargetOverrides(
  action: PlannedAction,
  userInput: string | null | undefined
): PlannedAction {
  if (action.type !== "inspect_workspace_resources") {
    return action;
  }
  const override = readRuntimeInspectionTargetOverride(userInput);
  if (!override) {
    return action;
  }
  return {
    ...action,
    params: {
      ...action.params,
      rootPath: override.rootPath ?? action.params.rootPath,
      previewUrl: override.previewUrl ?? action.params.previewUrl,
      previewProcessLeaseId:
        override.previewProcessLeaseId ?? action.params.previewProcessLeaseId
    }
  };
}

/**
 * Remembers one approved same-plan loopback target override emitted by `start_process`.
 *
 * @param overrides - Existing active overrides.
 * @param actionResult - Latest approved or blocked action result.
 * @returns Updated overrides.
 */
export function rememberLiveRunTargetOverride(
  overrides: readonly LoopbackTargetOverride[],
  actionResult: ActionRunResult
): readonly LoopbackTargetOverride[] {
  if (actionResult.action.type !== "start_process" || !actionResult.approved) {
    return overrides;
  }
  const metadata = actionResult.executionMetadata ?? {};
  const actualHost = normalizeLoopbackHost(
    typeof metadata.processRequestedHost === "string"
      ? metadata.processRequestedHost
      : null
  );
  const actualPort =
    typeof metadata.processRequestedPort === "number" &&
    Number.isInteger(metadata.processRequestedPort)
      ? metadata.processRequestedPort
      : null;
  const originalHost =
    normalizeLoopbackHost(
      typeof metadata.processOriginalRequestedHost === "string"
        ? metadata.processOriginalRequestedHost
        : null
    ) ?? actualHost;
  const originalPort =
    (
      typeof metadata.processOriginalRequestedPort === "number" &&
      Number.isInteger(metadata.processOriginalRequestedPort)
    )
      ? metadata.processOriginalRequestedPort
      : actualPort;
  if (!originalHost || originalPort === null || !actualHost || actualPort === null) {
    return overrides;
  }
  const resolvedOverride: LoopbackTargetOverride = {
    originalHost,
    originalPort,
    originalUrl:
      typeof metadata.processOriginalRequestedUrl === "string"
        ? metadata.processOriginalRequestedUrl
        : null,
    actualHost,
    actualPort,
    actualUrl:
      typeof metadata.processRequestedUrl === "string"
        ? metadata.processRequestedUrl
        : null,
    previewProcessLeaseId:
      typeof metadata.processLeaseId === "string" ? metadata.processLeaseId : null,
    workspaceRoot:
      typeof metadata.processCwd === "string" ? metadata.processCwd : null
  };
  const deduped = overrides.filter(
    (candidate) =>
      !(
        loopbackHostsAreEquivalent(candidate.originalHost, resolvedOverride.originalHost) &&
        candidate.originalPort === resolvedOverride.originalPort
      )
  );
  return [resolvedOverride, ...deduped];
}
