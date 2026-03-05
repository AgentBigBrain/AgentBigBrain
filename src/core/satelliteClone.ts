/**
 * @fileoverview Satellite clone lifecycle management: spawn policy enforcement, persona overlays, governed merge decisions, and isolation brokering.
 */

import { MAIN_AGENT_ID } from "./agentIdentity";
import { hashSha256, toSortedUnique, clampNonNegative } from "./cryptoUtils";
import { makeId } from "./ids";
import { TaskRequest } from "./types";

export type SatellitePersonaRole = "creative" | "researcher" | "critic" | "builder";
export type SatelliteCloneStatus = "active" | "merged" | "retired";

export interface SatellitePersonaOverlay {
    role: SatellitePersonaRole;
    traitDeltas: Readonly<Record<string, number>>;
}

export interface SatelliteCloneRecord {
    cloneId: string;
    rootTaskId: string;
    depth: number;
    budgetUsd: number;
    role: SatellitePersonaRole;
    personaOverlay: SatellitePersonaOverlay;
    status: SatelliteCloneStatus;
    createdAt: string;
    mergedAt: string | null;
}

export interface SatelliteSpawnPolicy {
    maxClonesPerTask: number;
    maxDepth: number;
    maxBudgetUsd: number;
}

export interface SatelliteSpawnRequest {
    rootTaskId: string;
    requestedCloneCount: number;
    requestedDepth: number;
    requestedBudgetUsd: number;
    existingCloneCount: number;
    role: SatellitePersonaRole;
}

export interface SatelliteSpawnDecision {
    allowed: boolean;
    blockedBy: readonly string[];
    reasons: readonly string[];
    clones: readonly SatelliteCloneRecord[];
}

export interface SatelliteMergeDecisionInput {
    clone: SatelliteCloneRecord;
    governanceApproved: boolean;
    rejectingGovernorIds: readonly string[];
    lessonText: string;
    reason?: string;
}

export interface SatelliteMergeDecision {
    merged: boolean;
    blockedBy: readonly string[];
    committedByAgentId: string | null;
    rejectionReason: string | null;
    lessonFingerprint: string;
}

export interface SatelliteRelayRequest {
    fromAgentId: string;
    toAgentId: string;
    payload: string;
    channel: "direct" | "brokered";
}

export interface SatelliteRelayDecision {
    allowed: boolean;
    blockedBy: readonly string[];
    route: "denied" | "orchestrator_task_request";
    relayTaskRequest: TaskRequest | null;
}

const CLONE_NAME_PREFIXES = ["atlas", "milkyway", "astro"] as const;

/**
 * Maps a satellite role to a deterministic persona overlay profile.
 *
 * **Why it exists:**
 * Spawned satellites must stay inside an allowlisted trait envelope so role behavior is
 * predictable and auditable across runs.
 *
 * **What it talks to:**
 * - Uses `SatellitePersonaRole` and `SatellitePersonaOverlay` local contracts.
 *
 * @param role - Requested satellite role.
 * @returns Trait-weight profile applied to newly spawned clones.
 */
function defaultPersonaOverlay(role: SatellitePersonaRole): SatellitePersonaOverlay {
    if (role === "creative") {
        return {
            role,
            traitDeltas: {
                creativity: 0.8,
                precision: 0.2,
                skepticism: 0.1,
                execution_bias: 0.4
            }
        };
    }

    if (role === "researcher") {
        return {
            role,
            traitDeltas: {
                creativity: 0.2,
                precision: 0.8,
                skepticism: 0.7,
                execution_bias: 0.4
            }
        };
    }

    if (role === "critic") {
        return {
            role,
            traitDeltas: {
                creativity: 0.1,
                precision: 0.7,
                skepticism: 0.9,
                execution_bias: 0.2
            }
        };
    }

    return {
        role,
        traitDeltas: {
            creativity: 0.3,
            precision: 0.7,
            skepticism: 0.4,
            execution_bias: 0.9
        }
    };
}

export class SatelliteCloneCoordinator {
    private cloneSequence = 0;

    /**
     * Creates a clone coordinator with deterministic spawn limits and naming policy.
     *
     * **Why it exists:**
     * Clone creation must respect explicit governance bounds (count, depth, budget) and produce
     * reproducible IDs for evidence and replay.
     *
     * **What it talks to:**
     * - Stores `SatelliteSpawnPolicy`.
     * - Uses prefix list for deterministic clone IDs.
     */
    constructor(
        private readonly policy: SatelliteSpawnPolicy,
        private readonly clonePrefixes: readonly string[] = CLONE_NAME_PREFIXES
    ) { }

    /**
     * Allocates the next deterministic clone identifier.
     *
     * **Why it exists:**
     * Generated IDs must be stable, collision-resistant within one coordinator instance, and human
     * scannable in logs.
     *
     * **What it talks to:**
     * - Reads/writes `cloneSequence`.
     * - Reads `clonePrefixes`.
     *
     * @returns Deterministic clone id (for example `atlas-1001`).
     */
    private nextCloneId(): string {
        this.cloneSequence += 1;
        const prefix = this.clonePrefixes[(this.cloneSequence - 1) % this.clonePrefixes.length];
        return `${prefix}-${1000 + this.cloneSequence}`;
    }

    /**
     * Evaluates a spawn request against policy and materializes clone records when allowed.
     *
     * **Why it exists:**
     * Satellite spawning is a high-impact autonomy operation. This method enforces hard limits
     * before creation and returns typed deny reasons when any guard is violated.
     *
     * **What it talks to:**
     * - Uses `clampNonNegative` for budget normalization.
     * - Uses `toSortedUnique` for stable reason ordering.
     * - Calls `defaultPersonaOverlay` and `nextCloneId` for clone construction.
     *
     * @param request - Requested clone count/depth/budget and role metadata.
     * @returns Allow/deny decision plus spawned clone records when approved.
     */
    spawnSatellites(request: SatelliteSpawnRequest): SatelliteSpawnDecision {
        const blockedBy: string[] = [];
        const requestedCloneCount = Math.max(0, Math.floor(request.requestedCloneCount));
        const requestedDepth = Math.max(0, Math.floor(request.requestedDepth));
        const requestedBudgetUsd = clampNonNegative(request.requestedBudgetUsd);

        if (requestedCloneCount <= 0) {
            blockedBy.push("CLONE_COUNT_INVALID");
        }
        if (request.existingCloneCount + requestedCloneCount > this.policy.maxClonesPerTask) {
            blockedBy.push("CLONE_LIMIT_REACHED");
        }
        if (requestedDepth > this.policy.maxDepth) {
            blockedBy.push("CLONE_DEPTH_EXCEEDED");
        }
        if (requestedBudgetUsd > this.policy.maxBudgetUsd) {
            blockedBy.push("CLONE_BUDGET_EXCEEDED");
        }

        if (blockedBy.length > 0) {
            return {
                allowed: false,
                blockedBy: toSortedUnique(blockedBy),
                reasons: toSortedUnique(blockedBy.map((code) => `Satellite spawn blocked by ${code}.`)),
                clones: []
            };
        }

        const perCloneBudget = Number((requestedBudgetUsd / requestedCloneCount).toFixed(4));
        const clones: SatelliteCloneRecord[] = [];
        for (let index = 0; index < requestedCloneCount; index += 1) {
            clones.push({
                cloneId: this.nextCloneId(),
                rootTaskId: request.rootTaskId,
                depth: requestedDepth,
                budgetUsd: perCloneBudget,
                role: request.role,
                personaOverlay: defaultPersonaOverlay(request.role),
                status: "active",
                createdAt: new Date().toISOString(),
                mergedAt: null
            });
        }

        return {
            allowed: true,
            blockedBy: [],
            reasons: [
                `Spawn policy accepted ${requestedCloneCount} clone(s) within depth/budget limits.`,
                "Role persona overlay applied from deterministic allowlisted profiles."
            ],
            clones
        };
    }

    /**
     * Converts governed merge approval into a deterministic merge/reject outcome record.
     *
     * **Why it exists:**
     * Distiller merge outcomes must keep provenance: who attempted the merge, whether governance
     * approved, and a stable fingerprint of the lesson content.
     *
     * **What it talks to:**
     * - Calls `hashSha256` to fingerprint lesson text.
     * - Uses `toSortedUnique` for rejecting-governor attribution.
     *
     * @param input - Clone merge decision input from governance + reflection flow.
     * @returns Merge decision payload with typed rejection metadata when blocked.
     */
    evaluateMergeDecision(input: SatelliteMergeDecisionInput): SatelliteMergeDecision {
        const lessonFingerprint = hashSha256(input.lessonText.trim());
        if (!input.governanceApproved) {
            const rejectingGovernorIds = toSortedUnique(input.rejectingGovernorIds);
            return {
                merged: false,
                blockedBy: rejectingGovernorIds.length > 0 ? rejectingGovernorIds : ["governance"],
                committedByAgentId: null,
                rejectionReason:
                    input.reason?.trim() ||
                    "Governed Distiller merge rejected; lesson retained in rejection ledger.",
                lessonFingerprint
            };
        }

        return {
            merged: true,
            blockedBy: [],
            committedByAgentId: input.clone.cloneId,
            rejectionReason: null,
            lessonFingerprint
        };
    }
}

export class SatelliteIsolationBroker {
    /**
     * Creates an isolation broker anchored to the root orchestrator agent id.
     *
     * **Why it exists:**
     * Satellite-to-satellite direct channels are intentionally restricted; the broker enforces
     * that policy and reroutes allowed traffic through governed orchestrator tasks.
     *
     * **What it talks to:**
     * - Stores root agent identity for relay policy checks.
     */
    constructor(private readonly rootAgentId: string = MAIN_AGENT_ID) { }

    /**
     * Applies isolation routing policy to a proposed inter-agent relay message.
     *
     * **Why it exists:**
     * Prevents unauthorized direct satellite channels while still permitting brokered relay
     * through the main orchestrator control path.
     *
     * **What it talks to:**
     * - Calls `makeId` to create broker task request IDs.
     * - Emits `TaskRequest` payloads for orchestrator-handled relay.
     *
     * @param request - Relay attempt metadata (source, destination, payload, channel).
     * @returns Routing decision with deny reason or brokered relay task.
     */
    routeMessage(request: SatelliteRelayRequest): SatelliteRelayDecision {
        const fromSatellite = request.fromAgentId !== this.rootAgentId;
        const toSatellite = request.toAgentId !== this.rootAgentId;

        if (fromSatellite && toSatellite && request.channel === "direct") {
            return {
                allowed: false,
                blockedBy: ["DIRECT_SATELLITE_CHANNEL_DENIED"],
                route: "denied",
                relayTaskRequest: null
            };
        }

        const relayTaskRequest: TaskRequest = {
            id: makeId("satellite_relay"),
            agentId: this.rootAgentId,
            goal: `Brokered relay ${request.fromAgentId} -> ${request.toAgentId}`,
            userInput: request.payload,
            createdAt: new Date().toISOString()
        };

        return {
            allowed: true,
            blockedBy: [],
            route: "orchestrator_task_request",
            relayTaskRequest
        };
    }
}
