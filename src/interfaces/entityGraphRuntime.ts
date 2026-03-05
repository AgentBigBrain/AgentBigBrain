/**
 * @fileoverview Shared interface-runtime helpers for Stage 6.86 entity-graph reads/writes across Telegram and Discord gateways.
 */

import type { Stage686EntityExtractionInput } from "../core/stage6_86EntityGraph";
import type { EntityGraphV1 } from "../core/types";

export interface EntityGraphStoreLike {
  getGraph(): Promise<EntityGraphV1>;
  upsertFromExtractionInput(input: Stage686EntityExtractionInput): Promise<unknown>;
}

export type InterfaceProviderId = "telegram" | "discord";

export interface InboundEntityGraphMutationInput {
  provider: InterfaceProviderId;
  conversationId: string;
  eventId: string;
  text: string;
  observedAt: string;
}

/**
 * Resolves a dynamic-pulse graph getter bound to one shared store lifecycle.
 *
 * **Why it exists:**
 * Gateways should not create ad-hoc `EntityGraphStore` instances per read. This helper binds
 * dynamic-pulse reads to one dependency-injected store instance.
 *
 * **What it talks to:**
 * - Calls `EntityGraphStoreLike.getGraph()` when dynamic pulse is enabled.
 *
 * @param dynamicPulseEnabled - Runtime flag controlling Stage 6.86 dynamic pulse behavior.
 * @param entityGraphStore - Shared entity-graph store instance for this runtime process.
 * @returns Bound getter for scheduler reads, or undefined when dynamic pulse is disabled.
 */
export function createDynamicPulseEntityGraphGetter(
  dynamicPulseEnabled: boolean,
  entityGraphStore: EntityGraphStoreLike
): (() => Promise<EntityGraphV1>) | undefined {
  if (!dynamicPulseEnabled) {
    return undefined;
  }
  return async () => entityGraphStore.getGraph();
}

/**
 * Builds a deterministic Stage 6.86 evidence reference for interface-ingress entity mutations.
 *
 * **Why it exists:**
 * Entity-graph writes need stable, provider-scoped evidence refs so pulse/readback can be
 * audited by turn identity.
 *
 * **What it talks to:**
 * - Uses local normalization helpers in this module.
 *
 * @param provider - Interface provider that accepted the inbound message.
 * @param conversationId - Provider conversation/channel/chat identifier.
 * @param eventId - Provider update/message event identifier.
 * @returns Canonical evidence reference string.
 */
export function buildInboundEntityGraphEvidenceRef(
  provider: InterfaceProviderId,
  conversationId: string,
  eventId: string
): string {
  return [
    "interface",
    normalizeEvidenceRefSegment(provider),
    normalizeEvidenceRefSegment(conversationId),
    normalizeEvidenceRefSegment(eventId)
  ].join(":");
}

/**
 * Applies an ingress-driven entity-graph mutation when dynamic pulse mode is enabled.
 *
 * **Why it exists:**
 * Stage 6.86 graph state must be populated from real runtime traffic, not only tests/evidence
 * scripts. This helper gives both gateways one deterministic write path.
 *
 * **What it talks to:**
 * - Uses `buildInboundEntityGraphEvidenceRef(...)` for evidence linkage.
 * - Calls `EntityGraphStoreLike.upsertFromExtractionInput(...)` for persistence.
 *
 * @param entityGraphStore - Shared entity-graph store instance for this runtime process.
 * @param dynamicPulseEnabled - Runtime flag controlling whether graph mutation should run.
 * @param input - Provider-scoped ingress payload used for entity extraction/upsert.
 * @param onFailure - Optional error callback for gateway warning logs.
 * @returns `true` when mutation was attempted and succeeded; `false` when skipped or failed.
 */
export async function maybeRecordInboundEntityGraphMutation(
  entityGraphStore: EntityGraphStoreLike,
  dynamicPulseEnabled: boolean,
  input: InboundEntityGraphMutationInput,
  onFailure?: (error: Error) => void
): Promise<boolean> {
  if (!dynamicPulseEnabled) {
    return false;
  }
  try {
    await entityGraphStore.upsertFromExtractionInput({
      text: input.text,
      observedAt: input.observedAt,
      evidenceRef: buildInboundEntityGraphEvidenceRef(
        input.provider,
        input.conversationId,
        input.eventId
      )
    });
    return true;
  } catch (error) {
    if (onFailure) {
      onFailure(asError(error));
    }
    return false;
  }
}

/**
 * Converts unknown throwables into stable `Error` objects for logging.
 *
 * **Why it exists:**
 * Gateway warning logs should always receive `Error.message` without duplicate type guards.
 *
 * **What it talks to:**
 * - Uses local fallback conversion logic only.
 *
 * @param error - Unknown throwable captured from mutation execution.
 * @returns Normalized `Error` object.
 */
function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : "Unknown entity-graph mutation failure");
}

/**
 * Normalizes one evidence-reference segment to an ASCII-safe deterministic token.
 *
 * **Why it exists:**
 * Interface ids can contain separators or whitespace that should not alter evidence-ref shape.
 *
 * **What it talks to:**
 * - Uses local string normalization logic only.
 *
 * @param value - Raw segment value from provider/event context.
 * @returns Sanitized evidence-reference segment.
 */
function normalizeEvidenceRefSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}
