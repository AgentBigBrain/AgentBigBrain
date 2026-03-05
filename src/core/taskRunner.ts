/**
 * @fileoverview Executes per-action governance and execution loop phases for a task plan.
 */

import { MasterGovernor } from "../governors/masterGovernor";
import { runCouncilVote } from "../governors/voteGate";
import { Governor } from "../governors/types";
import { ModelClient, ModelUsageSnapshot } from "../models/types";
import { BrainConfig } from "./config";
import { estimateActionCostUsd } from "./actionCostPolicy";
import { resolveExecutionMode } from "./executionMode";
import { evaluateHardConstraints } from "./hardConstraints";
import {
  ActionRunResult,
  BrainState,
  ConflictObjectV1,
  FULL_COUNCIL_GOVERNOR_IDS,
  GovernorVote,
  isConstraintViolationCode,
  MasterDecision,
  ProfileMemoryStatus,
  STAGE_6_75_BLOCK_CODES,
  TaskRunResult
} from "./types";
import { GovernanceMemoryStore } from "./governanceMemory";
import { ExecutionReceiptStore } from "./advancedAutonomyRuntime";
import { AppendRuntimeTraceEventInput } from "./runtimeTraceLogger";
import { evaluateVerificationGate } from "./stage6_85QualityGatePolicy";
import { evaluateStage675EgressPolicy } from "./stage6_75EgressPolicy";
import { evaluateStage685RuntimeGuard } from "./stage6_85RuntimeGuards";
import {
  createApprovalGrantV1,
  createApprovalRequestV1,
  registerApprovalGrantUse,
  validateApprovalGrantUse
} from "./stage6_75ApprovalPolicy";
import {
  createConnectorReceiptV1,
  Stage675ConnectorOperation,
  validateStage675ConnectorOperation
} from "./stage6_75ConnectorPolicy";
import { evaluateConsistencyPreflight } from "./stage6_75ConsistencyPolicy";
import {
  advanceMissionPhase,
  buildInitialMissionState,
  createMissionCheckpoint,
  evaluateMissionStopDecision,
  MissionStopLimitsV1,
  registerMissionActionOutcome
} from "./stage6_75MissionStateMachine";
import { canonicalJson } from "./normalizers/canonicalizationRules";
import { ToolExecutorOrgan } from "../organs/executor";
import {
  appendExecutionReceipt,
  appendGovernanceEvent,
  buildGovernorContext,
  buildProposal,
  diffUsageSnapshot,
  evaluateCodeReview,
  normalizeOptionalString,
  prepareActionOutput,
  readModelUsageSnapshot,
  resolveExecutionFailureViolation,
  resolveVerificationCategoryForPrompt,
  shouldEnforceVerificationGateForRespond
} from "./taskRunnerSupport";
import { Stage686RuntimeActionEngine } from "./stage6_86RuntimeActions";

export interface TaskRunnerDependencies {
  config: BrainConfig;
  governors: Governor[];
  masterGovernor: MasterGovernor;
  modelClient: ModelClient;
  executor: ToolExecutorOrgan;
  governanceMemoryStore: GovernanceMemoryStore;
  executionReceiptStore: ExecutionReceiptStore;
  appendTraceEvent: (input: AppendRuntimeTraceEventInput) => Promise<void>;
  stage686RuntimeActionEngine?: Stage686RuntimeActionEngine;
}

export interface RunPlanActionsInput {
  task: TaskRunResult["task"];
  state: BrainState;
  plan: TaskRunResult["plan"];
  missionAttemptId: number;
  startedAtMs: number;
  cumulativeApprovedEstimatedCostUsd: number;
  modelUsageStart: ModelUsageSnapshot;
  profileMemoryStatus: ProfileMemoryStatus;
}

export class TaskRunner {
  private readonly stage686RuntimeActionEngine: Stage686RuntimeActionEngine;

  /**
   * Initializes `TaskRunner` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Stores collaborators injected by `buildBrain`/orchestration wiring for later runtime use.
   *
   * @param deps - Runtime dependencies for governance, execution, receipts, and tracing.
   */
  constructor(private readonly deps: TaskRunnerDependencies) {
    this.stage686RuntimeActionEngine =
      deps.stage686RuntimeActionEngine ??
      new Stage686RuntimeActionEngine({
        backend: deps.config.persistence.ledgerBackend,
        sqlitePath: deps.config.persistence.ledgerSqlitePath,
        exportJsonOnWrite: deps.config.persistence.exportJsonOnWrite
      });
  }

  /**
   * Executes one planner action list through constraints, council voting, and executor/runtime receipts.
   *
   * **Why it exists:**
   * This is the core governed action loop. Keeping it in one method preserves the exact order of
   * fail-closed checks (deadline, spend, hard constraints, stage guards, governance, verification
   * gate, execution, and ledger writes).
   *
   * **What it talks to:**
   * - Uses `MasterGovernor` (import `MasterGovernor`) from `../governors/masterGovernor`.
   * - Uses `runCouncilVote` (import `runCouncilVote`) from `../governors/voteGate`.
   * - Uses `estimateActionCostUsd` (import `estimateActionCostUsd`) from `./actionCostPolicy`.
   * - Uses `resolveExecutionMode` (import `resolveExecutionMode`) from `./executionMode`.
   * - Uses `evaluateHardConstraints` (import `evaluateHardConstraints`) from `./hardConstraints`.
   * - Uses `evaluateStage675EgressPolicy` (import `evaluateStage675EgressPolicy`) from `./stage6_75EgressPolicy`.
   * - Additional imported collaborators are also used in this function body.
   *
   * @param input - Task/plan context and execution limits for this run.
   * @returns Per-action outcomes plus approved deterministic-cost delta for this plan attempt.
   */
  async runPlanActions(
    input: RunPlanActionsInput
  ): Promise<{ results: ActionRunResult[]; approvedEstimatedCostDeltaUsd: number }> {
    const {
      task,
      state,
      plan,
      missionAttemptId,
      startedAtMs,
      cumulativeApprovedEstimatedCostUsd,
      modelUsageStart,
      profileMemoryStatus
    } = input;
    const attemptResults: ActionRunResult[] = [];
    let approvedEstimatedCostDeltaUsd = 0;
    let missionState = buildInitialMissionState(task.id, missionAttemptId);
    const deterministicActionIds = new Set<string>();
    const approvalGrantById = new Map<string, ReturnType<typeof createApprovalGrantV1>>();
    const connectorReceiptByActionId = new Map<
      string,
      {
        connector: "gmail" | "calendar";
        operation: "read" | "watch" | "draft" | "propose" | "write";
        requestPayload: unknown;
        responseMetadata: unknown;
        externalIds: readonly string[];
      }
    >();
    const missionStopLimits: MissionStopLimitsV1 = {
      maxActions: Math.max(1, this.deps.config.limits.maxActionsPerTask),
      maxDenies: Math.max(1, this.deps.config.limits.maxPlanAttemptsPerTask * 2),
      maxBytes: 1_048_576
    };

    for (const action of plan.actions) {
      const mode = resolveExecutionMode(action, this.deps.config);
      const usageDelta = diffUsageSnapshot(
        modelUsageStart,
        readModelUsageSnapshot(this.deps.modelClient)
      );
      const nowIso = new Date().toISOString();
      const idempotencyKey =
        normalizeOptionalString(action.params.idempotencyKey) ??
        `${task.id}:${missionAttemptId}:${action.id}`;
      const missionCheckpoint = createMissionCheckpoint(
        missionState,
        missionState.currentPhase,
        action.type,
        idempotencyKey,
        action.params,
        nowIso
      );
      const missionStopDecision = evaluateMissionStopDecision(missionState, missionStopLimits);
      if (missionStopDecision.shouldStop && missionStopDecision.blockCode) {
        const normalizedMissionStopCode = isConstraintViolationCode(missionStopDecision.blockCode)
          ? missionStopDecision.blockCode
          : "MISSION_STOP_LIMIT_REACHED";
        const blockedResult: ActionRunResult = {
          action,
          mode,
          approved: false,
          blockedBy: [normalizedMissionStopCode],
          violations: [
            {
              code: normalizedMissionStopCode,
              message: missionStopDecision.reason
            }
          ],
          votes: []
        };
        attemptResults.push(blockedResult);
        await this.deps.appendTraceEvent({
          eventType: "constraint_blocked",
          taskId: task.id,
          actionId: action.id,
          mode,
          details: {
            blockCode: normalizedMissionStopCode,
            blockCategory: "runtime",
            missionAttemptId,
            missionPhase: missionState.currentPhase
          }
        });
        await appendGovernanceEvent({
          taskId: task.id,
          proposalId: null,
          actionResult: blockedResult,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          appendTraceEvent: this.deps.appendTraceEvent
        });
        const missionRegistration = registerMissionActionOutcome(
          missionState,
          idempotencyKey,
          0,
          true
        );
        missionState = advanceMissionPhase(missionRegistration.nextState);
        continue;
      }
      if (missionState.seenIdempotencyKeys[idempotencyKey] === true) {
        const blockedResult: ActionRunResult = {
          action,
          mode,
          approved: false,
          blockedBy: ["IDEMPOTENCY_KEY_REPLAY_DETECTED"],
          violations: [
            {
              code: "IDEMPOTENCY_KEY_REPLAY_DETECTED",
              message: "Action idempotency key replay detected; execution denied."
            }
          ],
          votes: []
        };
        attemptResults.push(blockedResult);
        await this.deps.appendTraceEvent({
          eventType: "constraint_blocked",
          taskId: task.id,
          actionId: action.id,
          mode,
          details: {
            blockCode: "IDEMPOTENCY_KEY_REPLAY_DETECTED",
            blockCategory: "runtime",
            idempotencyKey
          }
        });
        await appendGovernanceEvent({
          taskId: task.id,
          proposalId: null,
          actionResult: blockedResult,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          appendTraceEvent: this.deps.appendTraceEvent
        });
        const missionRegistration = registerMissionActionOutcome(
          missionState,
          idempotencyKey,
          0,
          true
        );
        missionState = advanceMissionPhase(missionRegistration.nextState);
        continue;
      }
      if (deterministicActionIds.has(missionCheckpoint.actionId)) {
        const blockedResult: ActionRunResult = {
          action,
          mode,
          approved: false,
          blockedBy: ["ACTION_ID_DUPLICATE_DETECTED"],
          violations: [
            {
              code: "ACTION_ID_DUPLICATE_DETECTED",
              message: "Deterministic mission action id duplicated within this mission attempt."
            }
          ],
          votes: []
        };
        attemptResults.push(blockedResult);
        await this.deps.appendTraceEvent({
          eventType: "constraint_blocked",
          taskId: task.id,
          actionId: action.id,
          mode,
          details: {
            blockCode: "ACTION_ID_DUPLICATE_DETECTED",
            blockCategory: "runtime",
            deterministicActionId: missionCheckpoint.actionId
          }
        });
        await appendGovernanceEvent({
          taskId: task.id,
          proposalId: null,
          actionResult: blockedResult,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          appendTraceEvent: this.deps.appendTraceEvent
        });
        const missionRegistration = registerMissionActionOutcome(
          missionState,
          idempotencyKey,
          0,
          true
        );
        missionState = advanceMissionPhase(missionRegistration.nextState);
        continue;
      }
      deterministicActionIds.add(missionCheckpoint.actionId);
      if (Date.now() - startedAtMs > this.deps.config.limits.perTurnDeadlineMs) {
        const blockedResult: ActionRunResult = {
          action,
          mode,
          approved: false,
          blockedBy: ["GLOBAL_DEADLINE_EXCEEDED"],
          violations: [
            {
              code: "GLOBAL_DEADLINE_EXCEEDED",
              message: `Turn exceeded ${this.deps.config.limits.perTurnDeadlineMs}ms deadline.`
            }
          ],
          votes: []
        };
        attemptResults.push(blockedResult);
        await this.deps.appendTraceEvent({
          eventType: "constraint_blocked",
          taskId: task.id,
          actionId: action.id,
          mode,
          details: {
            blockCode: "GLOBAL_DEADLINE_EXCEEDED",
            blockCategory: "runtime"
          }
        });
        await appendGovernanceEvent({
          taskId: task.id,
          proposalId: null,
          actionResult: blockedResult,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          appendTraceEvent: this.deps.appendTraceEvent
        });
        const missionRegistration = registerMissionActionOutcome(
          missionState,
          idempotencyKey,
          0,
          true
        );
        missionState = advanceMissionPhase(missionRegistration.nextState);
        continue;
      }

      if (usageDelta.estimatedSpendUsd > this.deps.config.limits.maxCumulativeModelSpendUsd) {
        const blockedResult: ActionRunResult = {
          action,
          mode,
          approved: false,
          blockedBy: ["MODEL_SPEND_LIMIT_EXCEEDED"],
          violations: [
            {
              code: "MODEL_SPEND_LIMIT_EXCEEDED",
              message:
                `Model spend ${usageDelta.estimatedSpendUsd.toFixed(6)} exceeds ` +
                `max ${this.deps.config.limits.maxCumulativeModelSpendUsd.toFixed(2)}.`
            }
          ],
          votes: []
        };
        attemptResults.push(blockedResult);
        await this.deps.appendTraceEvent({
          eventType: "constraint_blocked",
          taskId: task.id,
          actionId: action.id,
          mode,
          details: {
            blockCode: "MODEL_SPEND_LIMIT_EXCEEDED",
            blockCategory: "runtime"
          }
        });
        await appendGovernanceEvent({
          taskId: task.id,
          proposalId: null,
          actionResult: blockedResult,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          appendTraceEvent: this.deps.appendTraceEvent
        });
        const missionRegistration = registerMissionActionOutcome(
          missionState,
          idempotencyKey,
          0,
          true
        );
        missionState = advanceMissionPhase(missionRegistration.nextState);
        continue;
      }

      const proposal = buildProposal(task, action, this.deps.config);
      const violations = evaluateHardConstraints(proposal, this.deps.config, {
        cumulativeEstimatedCostUsd:
          cumulativeApprovedEstimatedCostUsd + approvedEstimatedCostDeltaUsd
      });
      if (violations.length > 0) {
        const blockedResult: ActionRunResult = {
          action,
          mode,
          approved: false,
          blockedBy: violations.map((violation) => violation.code),
          violations,
          votes: []
        };
        attemptResults.push(blockedResult);
        await this.deps.appendTraceEvent({
          eventType: "constraint_blocked",
          taskId: task.id,
          actionId: action.id,
          proposalId: proposal.id,
          mode,
          details: {
            blockCode: violations[0]?.code ?? "CONSTRAINT_VIOLATION",
            blockCategory: "constraints",
            violationCount: violations.length
          }
        });
        await appendGovernanceEvent({
          taskId: task.id,
          proposalId: proposal.id,
          actionResult: blockedResult,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          appendTraceEvent: this.deps.appendTraceEvent
        });
        const missionRegistration = registerMissionActionOutcome(
          missionState,
          idempotencyKey,
          0,
          true
        );
        missionState = advanceMissionPhase(missionRegistration.nextState);
        continue;
      }

      const stage685Guard = evaluateStage685RuntimeGuard(action);
      if (stage685Guard) {
        const blockedResult: ActionRunResult = {
          action,
          mode,
          approved: false,
          blockedBy: [stage685Guard.violation.code],
          violations: [stage685Guard.violation],
          votes: []
        };
        attemptResults.push(blockedResult);
        await this.deps.appendTraceEvent({
          eventType: "constraint_blocked",
          taskId: task.id,
          actionId: action.id,
          proposalId: proposal.id,
          mode,
          details: {
            blockCode: stage685Guard.violation.code,
            blockCategory: "constraints",
            conflictCode: stage685Guard.conflictCode
          }
        });
        await appendGovernanceEvent({
          taskId: task.id,
          proposalId: proposal.id,
          actionResult: blockedResult,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          appendTraceEvent: this.deps.appendTraceEvent
        });
        const missionRegistration = registerMissionActionOutcome(
          missionState,
          idempotencyKey,
          0,
          true
        );
        missionState = advanceMissionPhase(missionRegistration.nextState);
        continue;
      }

      // Stage 6.75 Connector Policy Guard
      if (action.type === "network_write") {
        const url = normalizeOptionalString(action.params.url) ?? normalizeOptionalString(action.params.endpoint);
        if (!url) {
          const blockedResult: ActionRunResult = {
            action,
            mode,
            approved: false,
            blockedBy: ["NETWORK_EGRESS_POLICY_BLOCKED"],
            violations: [
              {
                code: "NETWORK_EGRESS_POLICY_BLOCKED",
                message: "Missing URL/endpoint in network_write action."
              }
            ],
            votes: []
          };
          attemptResults.push(blockedResult);
          await appendGovernanceEvent({
            taskId: task.id,
            proposalId: proposal.id,
            actionResult: blockedResult,
            governanceMemoryStore: this.deps.governanceMemoryStore,
            appendTraceEvent: this.deps.appendTraceEvent
          });
          const missionRegistration = registerMissionActionOutcome(
            missionState,
            idempotencyKey,
            0,
            true
          );
          missionState = advanceMissionPhase(missionRegistration.nextState);
          continue;
        }

        const connectorRaw = normalizeOptionalString(action.params.connector)?.toLowerCase();
        const connector =
          connectorRaw === "gmail" || connectorRaw === "calendar"
            ? connectorRaw
            : null;
        const operationRaw = normalizeOptionalString(action.params.operation)?.toLowerCase();
        let connectorOperation: Stage675ConnectorOperation | null = null;
        if (
          operationRaw === "read" ||
          operationRaw === "watch" ||
          operationRaw === "draft" ||
          operationRaw === "propose" ||
          operationRaw === "write" ||
          operationRaw === "update" ||
          operationRaw === "delete"
        ) {
          connectorOperation = operationRaw;
        }

        if (operationRaw && !connectorOperation) {
          const blockedResult: ActionRunResult = {
            action,
            mode,
            approved: false,
            blockedBy: ["CONNECTOR_OPERATION_NOT_SUPPORTED_IN_STAGE_6_75"],
            violations: [
              {
                code: "CONNECTOR_OPERATION_NOT_SUPPORTED_IN_STAGE_6_75",
                message: `Unsupported connector operation '${operationRaw}'.`
              }
            ],
            votes: []
          };
          attemptResults.push(blockedResult);
          await this.deps.appendTraceEvent({
            eventType: "constraint_blocked",
            taskId: task.id,
            actionId: action.id,
            proposalId: proposal.id,
            mode,
            details: {
              blockCode: "CONNECTOR_OPERATION_NOT_SUPPORTED_IN_STAGE_6_75",
              blockCategory: "constraints"
            }
          });
          await appendGovernanceEvent({
            taskId: task.id,
            proposalId: proposal.id,
            actionResult: blockedResult,
            governanceMemoryStore: this.deps.governanceMemoryStore,
            appendTraceEvent: this.deps.appendTraceEvent
          });
          const missionRegistration = registerMissionActionOutcome(
            missionState,
            idempotencyKey,
            0,
            true
          );
          missionState = advanceMissionPhase(missionRegistration.nextState);
          continue;
        }

        if (connectorOperation) {
          const connectorDecision = validateStage675ConnectorOperation(connectorOperation);
          if (!connectorDecision.ok && connectorDecision.blockCode) {
            const normalizedConnectorCode = isConstraintViolationCode(connectorDecision.blockCode)
              ? connectorDecision.blockCode
              : "CONNECTOR_OPERATION_NOT_SUPPORTED_IN_STAGE_6_75";
            const blockedResult: ActionRunResult = {
              action,
              mode,
              approved: false,
              blockedBy: [normalizedConnectorCode],
              violations: [
                {
                  code: normalizedConnectorCode,
                  message: connectorDecision.reason
                }
              ],
              votes: []
            };
            attemptResults.push(blockedResult);
            await this.deps.appendTraceEvent({
              eventType: "constraint_blocked",
              taskId: task.id,
              actionId: action.id,
              proposalId: proposal.id,
              mode,
              details: {
                blockCode: normalizedConnectorCode,
                blockCategory: "constraints"
              }
            });
            await appendGovernanceEvent({
              taskId: task.id,
              proposalId: proposal.id,
              actionResult: blockedResult,
              governanceMemoryStore: this.deps.governanceMemoryStore,
              appendTraceEvent: this.deps.appendTraceEvent
            });
            const missionRegistration = registerMissionActionOutcome(
              missionState,
              idempotencyKey,
              0,
              true
            );
            missionState = advanceMissionPhase(missionRegistration.nextState);
            continue;
          }
        }

        const requiresConsistencyPreflight =
          action.params.requiresConsistencyPreflight === true ||
          connector === "calendar" ||
          connector === "gmail";
        if (requiresConsistencyPreflight) {
          const lastReadAtIso =
            normalizeOptionalString(action.params.lastReadAtIso) ??
            normalizeOptionalString(action.params.observedAtWatermark);
          const unresolvedConflictRaw = action.params.unresolvedConflict;
          let unresolvedConflict: ConflictObjectV1 | null = null;
          if (
            unresolvedConflictRaw &&
            typeof unresolvedConflictRaw === "object" &&
            !Array.isArray(unresolvedConflictRaw)
          ) {
            const raw = unresolvedConflictRaw as Partial<ConflictObjectV1>;
            const rawConflictCode = normalizeOptionalString(raw.conflictCode);
            const detail = normalizeOptionalString(raw.detail);
            const observedAtWatermark = normalizeOptionalString(raw.observedAtWatermark);
            if (rawConflictCode && detail && observedAtWatermark) {
              const conflictCode = STAGE_6_75_BLOCK_CODES.includes(
                rawConflictCode as ConflictObjectV1["conflictCode"]
              )
                ? rawConflictCode as ConflictObjectV1["conflictCode"]
                : "CONFLICT_OBJECT_UNRESOLVED";
              unresolvedConflict = {
                conflictCode,
                detail,
                observedAtWatermark
              };
            } else {
              unresolvedConflict = {
                conflictCode: "CONFLICT_OBJECT_UNRESOLVED",
                detail: "Conflict object metadata is incomplete.",
                observedAtWatermark: nowIso
              };
            }
          }
          const providedFreshnessWindowMs =
            typeof action.params.freshnessWindowMs === "number" &&
              Number.isFinite(action.params.freshnessWindowMs) &&
              action.params.freshnessWindowMs > 0
              ? Math.floor(action.params.freshnessWindowMs)
              : null;
          const defaultFreshnessWindowMs = connector === "calendar" ? 2_000 : 5_000;
          const consistencyDecision = evaluateConsistencyPreflight({
            nowIso,
            lastReadAtIso,
            freshnessWindowMs: providedFreshnessWindowMs ?? defaultFreshnessWindowMs,
            unresolvedConflict
          });
          if (!consistencyDecision.ok && consistencyDecision.blockCode) {
            const normalizedConsistencyCode = isConstraintViolationCode(consistencyDecision.blockCode)
              ? consistencyDecision.blockCode
              : "STATE_STALE_REPLAN_REQUIRED";
            const blockedResult: ActionRunResult = {
              action,
              mode,
              approved: false,
              blockedBy: [normalizedConsistencyCode],
              violations: [
                {
                  code: normalizedConsistencyCode,
                  message: consistencyDecision.reason
                }
              ],
              votes: []
            };
            attemptResults.push(blockedResult);
            await this.deps.appendTraceEvent({
              eventType: "constraint_blocked",
              taskId: task.id,
              actionId: action.id,
              proposalId: proposal.id,
              mode,
              details: {
                blockCode: normalizedConsistencyCode,
                blockCategory: "constraints"
              }
            });
            await appendGovernanceEvent({
              taskId: task.id,
              proposalId: proposal.id,
              actionResult: blockedResult,
              governanceMemoryStore: this.deps.governanceMemoryStore,
              appendTraceEvent: this.deps.appendTraceEvent
            });
            const missionRegistration = registerMissionActionOutcome(
              missionState,
              idempotencyKey,
              0,
              true
            );
            missionState = advanceMissionPhase(missionRegistration.nextState);
            continue;
          }
        }

        const egressDecision = evaluateStage675EgressPolicy(url);
        if (!egressDecision.ok) {
          const blockedResult: ActionRunResult = {
            action,
            mode,
            approved: false,
            blockedBy: ["NETWORK_EGRESS_POLICY_BLOCKED"],
            violations: [
              {
                code: "NETWORK_EGRESS_POLICY_BLOCKED",
                message: egressDecision.reason
              }
            ],
            votes: []
          };
          attemptResults.push(blockedResult);
          await this.deps.appendTraceEvent({
            eventType: "constraint_blocked",
            taskId: task.id,
            actionId: action.id,
            proposalId: proposal.id,
            mode,
            details: {
              blockCode: "NETWORK_EGRESS_POLICY_BLOCKED",
              blockCategory: "constraints"
            }
          });
          await appendGovernanceEvent({
            taskId: task.id,
            proposalId: proposal.id,
            actionResult: blockedResult,
            governanceMemoryStore: this.deps.governanceMemoryStore,
            appendTraceEvent: this.deps.appendTraceEvent
          });
          const missionRegistration = registerMissionActionOutcome(
            missionState,
            idempotencyKey,
            0,
            true
          );
          missionState = advanceMissionPhase(missionRegistration.nextState);
          continue;
        }

        // Diff Approval Check - Require explicit approval receipt for network egress
        const approvalId = normalizeOptionalString(action.params.approvalId);
        if (!approvalId) {
          const blockedResult: ActionRunResult = {
            action,
            mode,
            approved: false,
            blockedBy: ["JIT_APPROVAL_REQUIRED"],
            violations: [
              {
                code: "JIT_APPROVAL_REQUIRED",
                message: "A cryptographically signed JIT UI diff approval is required for side-effect egress, but none was provided."
              }
            ],
            votes: []
          };
          attemptResults.push(blockedResult);
          await this.deps.appendTraceEvent({
            eventType: "constraint_blocked",
            taskId: task.id,
            actionId: action.id,
            proposalId: proposal.id,
            mode,
            details: {
              blockCode: "JIT_APPROVAL_REQUIRED",
              blockCategory: "constraints"
            }
          });
          await appendGovernanceEvent({
            taskId: task.id,
            proposalId: proposal.id,
            actionResult: blockedResult,
            governanceMemoryStore: this.deps.governanceMemoryStore,
            appendTraceEvent: this.deps.appendTraceEvent
          });
          const missionRegistration = registerMissionActionOutcome(
            missionState,
            idempotencyKey,
            0,
            true
          );
          missionState = advanceMissionPhase(missionRegistration.nextState);
          continue;
        }

        const approvalDiff =
          normalizeOptionalString(action.params.approvalDiff) ??
          canonicalJson({
            endpoint: url,
            method: normalizeOptionalString(action.params.method) ?? "POST",
            payload: action.params.payload ?? null
          });
        const approvalExpiresAtRaw = normalizeOptionalString(action.params.approvalExpiresAt);
        const approvalExpiresAt =
          approvalExpiresAtRaw ??
          new Date(Date.now() + 5 * 60 * 1000).toISOString();
        if (!Number.isFinite(Date.parse(approvalExpiresAt))) {
          const blockedResult: ActionRunResult = {
            action,
            mode,
            approved: false,
            blockedBy: ["APPROVAL_SCOPE_MISMATCH"],
            violations: [
              {
                code: "APPROVAL_SCOPE_MISMATCH",
                message: "Approval expiry timestamp is invalid."
              }
            ],
            votes: []
          };
          attemptResults.push(blockedResult);
          await this.deps.appendTraceEvent({
            eventType: "constraint_blocked",
            taskId: task.id,
            actionId: action.id,
            proposalId: proposal.id,
            mode,
            details: {
              blockCode: "APPROVAL_SCOPE_MISMATCH",
              blockCategory: "constraints"
            }
          });
          await appendGovernanceEvent({
            taskId: task.id,
            proposalId: proposal.id,
            actionResult: blockedResult,
            governanceMemoryStore: this.deps.governanceMemoryStore,
            appendTraceEvent: this.deps.appendTraceEvent
          });
          const missionRegistration = registerMissionActionOutcome(
            missionState,
            idempotencyKey,
            0,
            true
          );
          missionState = advanceMissionPhase(missionRegistration.nextState);
          continue;
        }

        const approvalMaxUses =
          typeof action.params.approvalMaxUses === "number" &&
            Number.isFinite(action.params.approvalMaxUses) &&
            action.params.approvalMaxUses > 0
            ? Math.floor(action.params.approvalMaxUses)
            : 1;
        const approvalUses =
          typeof action.params.approvalUses === "number" &&
            Number.isFinite(action.params.approvalUses) &&
            action.params.approvalUses >= 0
            ? Math.floor(action.params.approvalUses)
            : 0;
        const approvalRiskClass = action.params.riskClass === "tier_2" ? "tier_2" : "tier_3";
        const approvalActionIds = Array.isArray(action.params.approvalActionIds)
          ? action.params.approvalActionIds
            .map((value) => normalizeOptionalString(value))
            .filter((value): value is string => value !== null)
          : [];
        const scopedActionIds = approvalActionIds.length > 0 ? approvalActionIds : [action.id];
        const approvalIdempotencyKeys = Array.isArray(action.params.idempotencyKeys)
          ? action.params.idempotencyKeys
            .map((value) => normalizeOptionalString(value))
            .filter((value): value is string => value !== null)
          : [];
        const scopedIdempotencyKeys =
          approvalIdempotencyKeys.length > 0 ? approvalIdempotencyKeys : [idempotencyKey];

        const approvalRequest = createApprovalRequestV1({
          missionId: task.id,
          actionIds: scopedActionIds,
          diff: approvalDiff,
          riskClass: approvalRiskClass,
          idempotencyKeys: scopedIdempotencyKeys,
          expiresAt: approvalExpiresAt,
          maxUses: approvalMaxUses
        });
        const scopedApprovalRequest = {
          ...approvalRequest,
          approvalId
        };
        let approvalGrant = approvalGrantById.get(approvalId);
        if (!approvalGrant) {
          const initialGrant = createApprovalGrantV1({
            request: scopedApprovalRequest,
            approvedAt: nowIso,
            approvedBy: normalizeOptionalString(action.params.approvedBy) ?? "human_operator"
          });
          approvalGrant =
            approvalUses > 0
              ? {
                ...initialGrant,
                uses: approvalUses
              }
              : initialGrant;
        }
        const approvalDecision = validateApprovalGrantUse(
          scopedApprovalRequest,
          approvalGrant,
          {
            missionId: task.id,
            actionId: action.id,
            idempotencyKey,
            nowIso
          }
        );
        if (!approvalDecision.ok) {
          const blockCode =
            approvalDecision.blockCode && isConstraintViolationCode(approvalDecision.blockCode)
              ? approvalDecision.blockCode
              : "APPROVAL_SCOPE_MISMATCH";
          const blockedResult: ActionRunResult = {
            action,
            mode,
            approved: false,
            blockedBy: [blockCode],
            violations: [
              {
                code: blockCode,
                message: approvalDecision.reason
              }
            ],
            votes: []
          };
          attemptResults.push(blockedResult);
          await this.deps.appendTraceEvent({
            eventType: "constraint_blocked",
            taskId: task.id,
            actionId: action.id,
            proposalId: proposal.id,
            mode,
            details: {
              blockCode,
              blockCategory: "constraints"
            }
          });
          await appendGovernanceEvent({
            taskId: task.id,
            proposalId: proposal.id,
            actionResult: blockedResult,
            governanceMemoryStore: this.deps.governanceMemoryStore,
            appendTraceEvent: this.deps.appendTraceEvent
          });
          const missionRegistration = registerMissionActionOutcome(
            missionState,
            idempotencyKey,
            0,
            true
          );
          missionState = advanceMissionPhase(missionRegistration.nextState);
          continue;
        }

        approvalGrantById.set(approvalId, registerApprovalGrantUse(approvalGrant));
        if (connector && connectorOperation && connectorOperation !== "update" && connectorOperation !== "delete") {
          const externalIds = Array.isArray(action.params.externalIds)
            ? action.params.externalIds
              .map((value) => normalizeOptionalString(value))
              .filter((value): value is string => value !== null)
            : [];
          connectorReceiptByActionId.set(action.id, {
            connector,
            operation: connectorOperation,
            requestPayload: action.params.payload ?? null,
            responseMetadata: {
              endpoint: url
            },
            externalIds
          });
        }
      }

      const preparedOutputPromise =
        action.type === "memory_mutation" || action.type === "pulse_emit"
          ? Promise.resolve<string | null>(null)
          : prepareActionOutput(this.deps.executor, action);

      const governanceMemory = await this.deps.governanceMemoryStore.getReadView();
      const governorContext = buildGovernorContext({
        task,
        state,
        governanceMemory,
        profileMemoryStatus,
        config: this.deps.config,
        modelClient: this.deps.modelClient
      });
      const preflightVotes: GovernorVote[] = [];
      if (action.type === "create_skill") {
        const preflightStartedAtMs = Date.now();
        const codeReviewVote = await evaluateCodeReview(
          proposal,
          governorContext,
          this.deps.config.limits.perGovernorTimeoutMs
        );
        preflightVotes.push(codeReviewVote);
        await this.deps.appendTraceEvent({
          eventType: "governance_voted",
          taskId: task.id,
          actionId: action.id,
          proposalId: proposal.id,
          mode,
          durationMs: Date.now() - preflightStartedAtMs,
          details: {
            phase: "code_review_preflight",
            approved: codeReviewVote.approve,
            voteCount: 1,
            yesVotes: codeReviewVote.approve ? 1 : 0,
            noVotes: codeReviewVote.approve ? 0 : 1
          }
        });
        if (!codeReviewVote.approve) {
          const blockedResult: ActionRunResult = {
            action,
            mode,
            approved: false,
            blockedBy: [codeReviewVote.governorId],
            violations: [],
            votes: preflightVotes
          };
          attemptResults.push(blockedResult);
          await appendGovernanceEvent({
            taskId: task.id,
            proposalId: proposal.id,
            actionResult: blockedResult,
            governanceMemoryStore: this.deps.governanceMemoryStore,
            appendTraceEvent: this.deps.appendTraceEvent
          });
          const missionRegistration = registerMissionActionOutcome(
            missionState,
            idempotencyKey,
            0,
            true
          );
          missionState = advanceMissionPhase(missionRegistration.nextState);
          continue;
        }
      }

      let votes: GovernorVote[] = [];
      let decision: MasterDecision | undefined;
      const voteStartedAtMs = Date.now();
      if (mode === "fast_path") {
        const fastGovernors = this.deps.governors.filter((governor) =>
          this.deps.config.governance.fastPathGovernorIds.includes(governor.id)
        );

        if (fastGovernors.length === 0) {
          const blockedResult: ActionRunResult = {
            action,
            mode,
            approved: false,
            blockedBy: ["GOVERNOR_SET_EMPTY"],
            violations: [
              {
                code: "GOVERNOR_SET_EMPTY",
                message:
                  "Fast-path governance denied because no active governors matched fastPathGovernorIds."
              }
            ],
            votes: []
          };
          attemptResults.push(blockedResult);
          await this.deps.appendTraceEvent({
            eventType: "constraint_blocked",
            taskId: task.id,
            actionId: action.id,
            proposalId: proposal.id,
            mode,
            details: {
              blockCode: "GOVERNOR_SET_EMPTY",
              blockCategory: "governance"
            }
          });
          await appendGovernanceEvent({
            taskId: task.id,
            proposalId: proposal.id,
            actionResult: blockedResult,
            governanceMemoryStore: this.deps.governanceMemoryStore,
            appendTraceEvent: this.deps.appendTraceEvent
          });
          const missionRegistration = registerMissionActionOutcome(
            missionState,
            idempotencyKey,
            0,
            true
          );
          missionState = advanceMissionPhase(missionRegistration.nextState);
          continue;
        }
        const fastPathMaster = new MasterGovernor(fastGovernors.length);
        const fastVoteResult = await runCouncilVote(
          proposal,
          fastGovernors,
          governorContext,
          fastPathMaster,
          this.deps.config.limits.perGovernorTimeoutMs,
          {
            expectedGovernorIds: this.deps.config.governance.fastPathGovernorIds
          }
        );
        votes = fastVoteResult.votes;
        decision = fastVoteResult.decision;
      } else {
        const councilResult = await runCouncilVote(
          proposal,
          this.deps.governors,
          governorContext,
          this.deps.masterGovernor,
          this.deps.config.limits.perGovernorTimeoutMs,
          {
            expectedGovernorIds: FULL_COUNCIL_GOVERNOR_IDS
          }
        );
        votes = councilResult.votes;
        decision = councilResult.decision;
      }

      await this.deps.appendTraceEvent({
        eventType: "governance_voted",
        taskId: task.id,
        actionId: action.id,
        proposalId: proposal.id,
        mode,
        durationMs: Date.now() - voteStartedAtMs,
        details: {
          phase: mode === "fast_path" ? "fast_path_council" : "escalation_council",
          approved: decision ? decision.approved : true,
          voteCount: votes.length,
          yesVotes: decision ? decision.yesVotes : votes.filter((vote) => vote.approve).length,
          noVotes: decision ? decision.noVotes : votes.filter((vote) => !vote.approve).length,
          threshold: decision?.threshold ?? null
        }
      });

      if (!decision) {
        const blockedResult: ActionRunResult = {
          action,
          mode,
          approved: false,
          blockedBy: ["GOVERNANCE_DECISION_MISSING"],
          violations: [
            {
              code: "GOVERNANCE_DECISION_MISSING",
              message: "Governance decision missing after council vote; execution denied fail-closed."
            }
          ],
          votes: preflightVotes.concat(votes)
        };
        attemptResults.push(blockedResult);
        await this.deps.appendTraceEvent({
          eventType: "constraint_blocked",
          taskId: task.id,
          actionId: action.id,
          proposalId: proposal.id,
          mode,
          details: {
            blockCode: "GOVERNANCE_DECISION_MISSING",
            blockCategory: "governance"
          }
        });
        await appendGovernanceEvent({
          taskId: task.id,
          proposalId: proposal.id,
          actionResult: blockedResult,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          appendTraceEvent: this.deps.appendTraceEvent
        });
        const missionRegistration = registerMissionActionOutcome(
          missionState,
          idempotencyKey,
          0,
          true
        );
        missionState = advanceMissionPhase(missionRegistration.nextState);
        continue;
      }

      const combinedVotes = preflightVotes.concat(votes);
      const approved = decision.approved;
      if (!approved) {
        const blockedResult: ActionRunResult = {
          action,
          mode,
          approved: false,
          blockedBy: combinedVotes
            .filter((vote) => !vote.approve)
            .map((vote) => vote.governorId),
          violations: [],
          votes: combinedVotes,
          decision
        };
        attemptResults.push(blockedResult);
        await appendGovernanceEvent({
          taskId: task.id,
          proposalId: proposal.id,
          actionResult: blockedResult,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          appendTraceEvent: this.deps.appendTraceEvent
        });
        const missionRegistration = registerMissionActionOutcome(
          missionState,
          idempotencyKey,
          0,
          true
        );
        missionState = advanceMissionPhase(missionRegistration.nextState);
        continue;
      }

      // Stage 6.85 verification gate enforcement applies only to explicit completion-claim prompts.
      if (action.type === "respond") {
        if (shouldEnforceVerificationGateForRespond(task.userInput)) {
          const category = resolveVerificationCategoryForPrompt(task.userInput);
          const proofRefs = attemptResults
            .filter((result) => result.approved && result.action.type !== "respond")
            .map((result) => `action:${result.action.id}`);

          const verificationGate = evaluateVerificationGate({
            gateId: "verification_gate_runtime_chat",
            category,
            proofRefs,
            waiverApproved: false
          });

          if (!verificationGate.passed) {
            const blockedResult: ActionRunResult = {
              action,
              mode,
              approved: false,
              blockedBy: ["VERIFICATION_GATE_FAILED"],
              violations: [
                {
                  code: "VERIFICATION_GATE_FAILED",
                  message: `Task requires deterministic completion proofs for category '${category}', but none were provided. ` +
                    `The respond action is blocked to prevent false completion claims.`
                }
              ],
              votes: combinedVotes,
              decision
            };
            attemptResults.push(blockedResult);
            await this.deps.appendTraceEvent({
              eventType: "constraint_blocked",
              taskId: task.id,
              actionId: action.id,
              proposalId: proposal.id,
              mode,
              details: {
                blockCode: "VERIFICATION_GATE_FAILED",
                blockCategory: "constraints"
              }
            });
            await appendGovernanceEvent({
              taskId: task.id,
              proposalId: proposal.id,
              actionResult: blockedResult,
              governanceMemoryStore: this.deps.governanceMemoryStore,
              appendTraceEvent: this.deps.appendTraceEvent
            });
            const missionRegistration = registerMissionActionOutcome(
              missionState,
              idempotencyKey,
              0,
              true
            );
            missionState = advanceMissionPhase(missionRegistration.nextState);
            continue;
          }
        }
      }

      const executionStartedAtMs = Date.now();
      const stage686Execution = await this.stage686RuntimeActionEngine.execute({
        taskId: task.id,
        proposalId: proposal.id,
        missionId: task.id,
        missionAttemptId,
        action
      });
      let preparedOutput: string | null = null;
      let usedPreparedOutput = false;
      let output = "";
      let shellExecutionTelemetry: ReturnType<ToolExecutorOrgan["consumeShellExecutionTelemetry"]> | undefined;
      let executionFailureViolation = null as ReturnType<typeof resolveExecutionFailureViolation>;
      let stage686ExecutionMetadata: Record<string, string | number | boolean | null> | undefined;
      let stage686TraceDetails: Record<string, string | number | boolean | null> | undefined;
      if (stage686Execution) {
        output = stage686Execution.output;
        stage686ExecutionMetadata = stage686Execution.executionMetadata;
        stage686TraceDetails = stage686Execution.traceDetails;
        if (!stage686Execution.approved && stage686Execution.violationCode) {
          executionFailureViolation = {
            code: stage686Execution.violationCode,
            message: stage686Execution.violationMessage ?? stage686Execution.output
          };
        }
      } else {
        preparedOutput = await preparedOutputPromise;
        usedPreparedOutput = preparedOutput !== null;
        output =
          preparedOutput !== null
            ? preparedOutput
            : await this.deps.executor.execute(action);
        shellExecutionTelemetry = this.deps.executor.consumeShellExecutionTelemetry(action.id);
        executionFailureViolation = resolveExecutionFailureViolation(action, output);
      }
      if (executionFailureViolation) {
        const failureMetadata = {
          ...(shellExecutionTelemetry
            ? { ...shellExecutionTelemetry } as Record<string, string | number | boolean | null>
            : {}),
          ...(stage686ExecutionMetadata ?? {})
        };
        const executionMetadata = Object.keys(failureMetadata).length > 0
          ? failureMetadata
          : undefined;
        const shellMetadata = shellExecutionTelemetry
          ? { ...shellExecutionTelemetry } as Record<string, string | number | boolean | null>
          : undefined;
        const failedExecutionResult: ActionRunResult = {
          action,
          mode,
          approved: false,
          output,
          executionMetadata: executionMetadata ?? shellMetadata,
          blockedBy: [executionFailureViolation.code],
          violations: [executionFailureViolation],
          votes: combinedVotes,
          decision
        };
        attemptResults.push(failedExecutionResult);
        await this.deps.appendTraceEvent({
          eventType: "constraint_blocked",
          taskId: task.id,
          actionId: action.id,
          proposalId: proposal.id,
            mode,
            details: {
              blockCode: executionFailureViolation.code,
              blockCategory: "runtime",
              ...(stage686TraceDetails ?? {})
            }
          });
        await appendGovernanceEvent({
          taskId: task.id,
          proposalId: proposal.id,
          actionResult: failedExecutionResult,
          governanceMemoryStore: this.deps.governanceMemoryStore,
          appendTraceEvent: this.deps.appendTraceEvent
        });
        const missionRegistration = registerMissionActionOutcome(
          missionState,
          idempotencyKey,
          output.length,
          true
        );
        missionState = advanceMissionPhase(missionRegistration.nextState);
        continue;
      }
      const connectorReceiptInput = connectorReceiptByActionId.get(action.id);
      const connectorReceipt = connectorReceiptInput
        ? createConnectorReceiptV1({
          connector: connectorReceiptInput.connector,
          operation: connectorReceiptInput.operation,
          requestPayload: connectorReceiptInput.requestPayload,
          responseMetadata: connectorReceiptInput.responseMetadata,
          externalIds: connectorReceiptInput.externalIds,
          observedAt: new Date().toISOString()
        })
        : null;
      await this.deps.appendTraceEvent({
        eventType: "action_executed",
        taskId: task.id,
        actionId: action.id,
        proposalId: proposal.id,
        mode,
        durationMs: Date.now() - executionStartedAtMs,
        details: {
          usedPreparedOutput,
          outputLength: output.length,
          shellProfileFingerprint: shellExecutionTelemetry?.shellProfileFingerprint ?? null,
          shellSpawnSpecFingerprint: shellExecutionTelemetry?.shellSpawnSpecFingerprint ?? null,
          shellKind: shellExecutionTelemetry?.shellKind ?? null,
          shellExecutable: shellExecutionTelemetry?.shellExecutable ?? null,
          shellTimeoutMs: shellExecutionTelemetry?.shellTimeoutMs ?? null,
          shellEnvMode: shellExecutionTelemetry?.shellEnvMode ?? null,
          shellEnvKeyCount: shellExecutionTelemetry?.shellEnvKeyCount ?? null,
          shellEnvRedactedKeyCount: shellExecutionTelemetry?.shellEnvRedactedKeyCount ?? null,
          shellExitCode: shellExecutionTelemetry?.shellExitCode ?? null,
          shellSignal: shellExecutionTelemetry?.shellSignal ?? null,
          shellTimedOut: shellExecutionTelemetry?.shellTimedOut ?? null,
          shellStdoutDigest: shellExecutionTelemetry?.shellStdoutDigest ?? null,
          shellStderrDigest: shellExecutionTelemetry?.shellStderrDigest ?? null,
          shellStdoutBytes: shellExecutionTelemetry?.shellStdoutBytes ?? null,
          shellStderrBytes: shellExecutionTelemetry?.shellStderrBytes ?? null,
          shellStdoutTruncated: shellExecutionTelemetry?.shellStdoutTruncated ?? null,
          shellStderrTruncated: shellExecutionTelemetry?.shellStderrTruncated ?? null,
          missionAttemptId,
          missionPhase: missionState.currentPhase,
          deterministicActionId: missionCheckpoint.actionId,
          connector: connectorReceipt?.connector ?? null,
          connectorOperation: connectorReceipt?.operation ?? null,
          connectorExternalIdCount: connectorReceipt?.externalIds.length ?? null,
          ...(stage686TraceDetails ?? {})
        }
      });
      approvedEstimatedCostDeltaUsd += estimateActionCostUsd({
        type: action.type,
        params: action.params
      });
      const approvedExecutionMetadata: Record<string, string | number | boolean | null> = {
        ...(shellExecutionTelemetry
          ? { ...shellExecutionTelemetry } as Record<string, string | number | boolean | null>
          : {}),
        ...(stage686ExecutionMetadata ?? {}),
        missionAttemptId,
        missionPhase: missionState.currentPhase,
        deterministicActionId: missionCheckpoint.actionId
      };
      if (connectorReceipt) {
        approvedExecutionMetadata.stage675Connector = connectorReceipt.connector;
        approvedExecutionMetadata.stage675ConnectorOperation = connectorReceipt.operation;
        approvedExecutionMetadata.stage675ConnectorRequestFingerprint =
          connectorReceipt.requestFingerprint;
        approvedExecutionMetadata.stage675ConnectorResponseFingerprint =
          connectorReceipt.responseFingerprint;
        approvedExecutionMetadata.stage675ConnectorObservedAt = connectorReceipt.observedAt;
        approvedExecutionMetadata.stage675ConnectorExternalIdCount = connectorReceipt.externalIds.length;
      }
      const approvedResult: ActionRunResult = {
        action,
        mode,
        approved: true,
        output,
        executionMetadata: Object.keys(approvedExecutionMetadata).length > 0
          ? approvedExecutionMetadata
          : undefined,
        blockedBy: [],
        violations: [],
        votes: combinedVotes,
        decision
      };
      attemptResults.push(approvedResult);
      await appendGovernanceEvent({
        taskId: task.id,
        proposalId: proposal.id,
        actionResult: approvedResult,
        governanceMemoryStore: this.deps.governanceMemoryStore,
        appendTraceEvent: this.deps.appendTraceEvent
      });
      await appendExecutionReceipt({
        taskId: task.id,
        planTaskId: plan.taskId,
        proposalId: proposal.id,
        actionResult: approvedResult,
        executionReceiptStore: this.deps.executionReceiptStore
      });
      const missionRegistration = registerMissionActionOutcome(
        missionState,
        idempotencyKey,
        output.length,
        false
      );
      missionState = advanceMissionPhase(missionRegistration.nextState);
    }

    return {
      results: attemptResults,
      approvedEstimatedCostDeltaUsd
    };
  }
}
