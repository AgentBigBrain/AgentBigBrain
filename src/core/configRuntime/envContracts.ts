/**
 * @fileoverview Canonical runtime configuration contracts extracted from the shared config entrypoint.
 */

import type { ActionType, GovernorId, ShellRuntimeProfileV1 } from "../types";

export type OrganRole = "planner" | "executor" | "governor" | "memory" | "synthesizer";
export type RuntimeMode = "isolated" | "full_access";
export type LedgerBackend = "json" | "sqlite";

export interface ModelPolicy {
  primary: string;
  fallback: string;
}

export interface BrainConfig {
  governance: {
    councilSize: number;
    supermajorityThreshold: number;
    fastPathGovernorIds: GovernorId[];
    escalationActionTypes: ActionType[];
  };
  limits: {
    maxEstimatedCostUsd: number;
    maxCumulativeEstimatedCostUsd: number;
    maxCumulativeModelSpendUsd: number;
    maxCumulativeNonApiModelCalls: number;
    maxSubagentsPerTask: number;
    maxSubagentDepth: number;
    maxActionsPerTask: number;
    maxPlanAttemptsPerTask: number;
    maxAutonomousIterations: number;
    maxAutonomousConsecutiveNoProgressIterations: number;
    maxDaemonGoalRollovers: number;
    perGovernorTimeoutMs: number;
    perTurnDeadlineMs: number;
  };
  dna: {
    sandboxPathPrefix: string;
    immutableKeywords: string[];
    protectedPathPrefixes: string[];
  };
  permissions: {
    allowShellCommandAction: boolean;
    allowNetworkWriteAction: boolean;
    allowCreateSkillAction: boolean;
    enforceSandboxDelete: boolean;
    enforceSandboxListDirectory: boolean;
    enforceProtectedPathWrites: boolean;
    allowRealShellExecution: boolean;
    allowRealNetworkWrite: boolean;
  };
  runtime: {
    mode: RuntimeMode;
    requireContainerIsolation: boolean;
    requireDedicatedHost: boolean;
    isDaemonMode: boolean;
  };
  agentPulse: {
    enabled: boolean;
    enableDynamicPulse: boolean;
    timezoneOffsetMinutes: number;
    quietHoursStartHourLocal: number;
    quietHoursEndHourLocal: number;
    minIntervalMinutes: number;
  };
  reflection: {
    reflectOnSuccess: boolean;
  };
  embeddings: {
    enabled: boolean;
    modelDir: string;
    vectorSqlitePath: string;
  };
  persistence: {
    ledgerBackend: LedgerBackend;
    ledgerSqlitePath: string;
    exportJsonOnWrite: boolean;
  };
  observability: {
    traceEnabled: boolean;
    traceLogPath: string;
  };
  browserVerification: {
    headless: boolean;
  };
  shellRuntime: {
    profile: ShellRuntimeProfileV1;
    timeoutBoundsMs: {
      min: number;
      max: number;
    };
    commandMaxCharsBounds: {
      min: number;
      max: number;
    };
  };
  routing: Record<OrganRole, ModelPolicy>;
  governorRouting: Partial<Record<GovernorId, ModelPolicy>>;
}
