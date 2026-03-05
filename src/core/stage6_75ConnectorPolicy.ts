/**
 * @fileoverview Deterministic Stage 6.75 connector-operation policy and receipt helper contracts for Gmail/Calendar.
 */

import {
  ConnectorReceiptV1,
  Stage675BlockCode
} from "./types";
import { canonicalJson, sha256Hex } from "./normalizers/canonicalizationRules";

export type Stage675ConnectorOperation =
  | "read"
  | "watch"
  | "draft"
  | "propose"
  | "write"
  | "update"
  | "delete";

export interface ConnectorPolicyDecision {
  ok: boolean;
  blockCode: Stage675BlockCode | null;
  reason: string;
}

/**
 * Applies deterministic validity checks for stage675 connector operation.
 *
 * **Why it exists:**
 * Fails fast when stage675 connector operation is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param operation - Value for operation.
 * @returns Computed `ConnectorPolicyDecision` result.
 */
export function validateStage675ConnectorOperation(
  operation: Stage675ConnectorOperation
): ConnectorPolicyDecision {
  if (operation === "update" || operation === "delete") {
    return {
      ok: false,
      blockCode: "CONNECTOR_OPERATION_NOT_SUPPORTED_IN_STAGE_6_75",
      reason: `Connector operation '${operation}' is out of scope for Stage 6.75.`
    };
  }
  return {
    ok: true,
    blockCode: null,
    reason: "Connector operation is in Stage 6.75 scope."
  };
}

/**
 * Builds connector receipt v1 for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of connector receipt v1 consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `canonicalJson` (import `canonicalJson`) from `./normalizers/canonicalizationRules`.
 * - Uses `sha256Hex` (import `sha256Hex`) from `./normalizers/canonicalizationRules`.
 * - Uses `ConnectorReceiptV1` (import `ConnectorReceiptV1`) from `./types`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `ConnectorReceiptV1` result.
 */
export function createConnectorReceiptV1(input: {
  connector: ConnectorReceiptV1["connector"];
  operation: ConnectorReceiptV1["operation"];
  requestPayload: unknown;
  responseMetadata: unknown;
  externalIds: readonly string[];
  observedAt: string;
}): ConnectorReceiptV1 {
  return {
    connector: input.connector,
    operation: input.operation,
    requestFingerprint: sha256Hex(canonicalJson(input.requestPayload)),
    responseFingerprint: sha256Hex(canonicalJson(input.responseMetadata)),
    externalIds: [...input.externalIds],
    observedAt: input.observedAt
  };
}
