/**
 * @fileoverview Federated delegation gateway for authenticated, contract-validated inbound task routing from external agents.
 */

import { clampNonNegative, hashSha256, toIso } from "./cryptoUtils";
import { makeId } from "./ids";
import { TaskRequest } from "./types";

export interface FederatedAgentContract {
    externalAgentId: string;
    sharedSecretHash: string;
    maxQuotedCostUsd: number;
}

export interface FederatedInboundTask {
    quoteId: string;
    quotedCostUsd: number;
    goal: string;
    userInput: string;
    requestedAt?: string;
}

export interface FederatedDelegationDecision {
    accepted: boolean;
    blockedBy: readonly string[];
    reasons: readonly string[];
    contractId: string;
    taskRequest: TaskRequest | null;
}

export interface FederatedAuthenticationDecision {
    authenticated: boolean;
    blockedBy: readonly string[];
    reasons: readonly string[];
    contractId: string;
}

export class FederatedDelegationGateway {
    private readonly contractByAgentId: Map<string, FederatedAgentContract>;

    /**
     * Initializes `FederatedDelegationGateway` with deterministic runtime dependencies.
     *
     * **Why it exists:**
     * Captures required dependencies at initialization time so runtime behavior remains explicit.
     *
     * **What it talks to:**
     * - Uses local constants/helpers within this module.
     *
     * @param contracts - Value for contracts.
     */
    constructor(contracts: readonly FederatedAgentContract[]) {
        this.contractByAgentId = new Map(
            contracts.map((contract) => [contract.externalAgentId.trim(), contract])
        );
    }

    /**
     * Implements authenticate inbound agent behavior used by `federatedDelegation`.
     *
     * **Why it exists:**
     * Keeps `authenticate inbound agent` behavior centralized so collaborating call sites stay consistent.
     *
     * **What it talks to:**
     * - Uses `hashSha256` (import `hashSha256`) from `./cryptoUtils`.
     *
     * @param externalAgentId - Stable identifier used to reference an entity or record.
     * @param sharedSecret - Value for shared secret.
     * @returns Computed `FederatedAuthenticationDecision` result.
     */
    authenticateInboundAgent(externalAgentId: string, sharedSecret: string): FederatedAuthenticationDecision {
        const normalizedAgentId = externalAgentId.trim();
        const contractId = `${normalizedAgentId}:auth`;
        const contract = this.contractByAgentId.get(normalizedAgentId);

        if (!contract) {
            return {
                authenticated: false,
                blockedBy: ["FEDERATED_AGENT_NOT_ALLOWLISTED"],
                reasons: ["Inbound federated request agent is not in the allowlist."],
                contractId
            };
        }

        if (hashSha256(sharedSecret) !== contract.sharedSecretHash) {
            return {
                authenticated: false,
                blockedBy: ["FEDERATED_AUTH_FAILED"],
                reasons: ["Inbound federated request failed authentication."],
                contractId
            };
        }

        return {
            authenticated: true,
            blockedBy: [],
            reasons: ["Inbound federated request authenticated."],
            contractId
        };
    }

    /**
     * Executes inbound request as part of this module's control flow.
     *
     * **Why it exists:**
     * Isolates the inbound request runtime step so higher-level orchestration stays readable.
     *
     * **What it talks to:**
     * - Uses `clampNonNegative` (import `clampNonNegative`) from `./cryptoUtils`.
     * - Uses `toIso` (import `toIso`) from `./cryptoUtils`.
     * - Uses `makeId` (import `makeId`) from `./ids`.
     * - Uses `TaskRequest` (import `TaskRequest`) from `./types`.
     *
     * @param input - Structured input object for this operation.
     * @param externalAgentId - Stable identifier used to reference an entity or record.
     * @param sharedSecret - Value for shared secret.
     * @returns Computed `FederatedDelegationDecision` result.
     */
    routeInboundRequest(
        input: FederatedInboundTask,
        externalAgentId: string,
        sharedSecret: string
    ): FederatedDelegationDecision {
        const normalizedAgentId = externalAgentId.trim();
        const contractId = `${normalizedAgentId}:${input.quoteId.trim()}`;
        const authentication = this.authenticateInboundAgent(normalizedAgentId, sharedSecret);
        if (!authentication.authenticated) {
            return {
                accepted: false,
                blockedBy: authentication.blockedBy,
                reasons: authentication.reasons,
                contractId,
                taskRequest: null
            };
        }
        const contract = this.contractByAgentId.get(normalizedAgentId);
        if (!contract) {
            return {
                accepted: false,
                blockedBy: ["FEDERATED_AGENT_NOT_ALLOWLISTED"],
                reasons: ["Inbound federated request agent is not in the allowlist."],
                contractId,
                taskRequest: null
            };
        }

        if (clampNonNegative(input.quotedCostUsd) > clampNonNegative(contract.maxQuotedCostUsd)) {
            return {
                accepted: false,
                blockedBy: ["FEDERATED_QUOTE_EXCEEDED"],
                reasons: ["Inbound federated request exceeded contract quote budget."],
                contractId,
                taskRequest: null
            };
        }

        const goal = input.goal.trim();
        const userInput = input.userInput.trim();
        if (!goal || !userInput) {
            return {
                accepted: false,
                blockedBy: ["FEDERATED_REQUEST_INVALID"],
                reasons: ["Inbound federated request requires both goal and userInput."],
                contractId,
                taskRequest: null
            };
        }

        const taskRequest: TaskRequest = {
            id: makeId("federated_task"),
            agentId: normalizedAgentId,
            goal: `[FederatedContract ${contractId}] ${goal}`,
            userInput,
            createdAt: toIso(input.requestedAt)
        };

        return {
            accepted: true,
            blockedBy: [],
            reasons: [
                "Inbound federated request authenticated and contract-validated.",
                "Task is ready for standard orchestrator hard-constraint and governor flow."
            ],
            contractId,
            taskRequest
        };
    }
}
