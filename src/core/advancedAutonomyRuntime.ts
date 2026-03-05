/**
 * @fileoverview Barrel re-export for Stage 6.5 advanced-autonomy runtime modules.
 *
 * This file previously contained all federated delegation, satellite clone, distiller ledger,
 * execution receipt, and judgment pattern implementations in a single 2,000-line module.
 * It has been decomposed into focused, independently testable modules while preserving
 * backward compatibility via these re-exports.
 *
 * @see {@link ./federatedDelegation} - Contract auth, cost validation, inbound task routing
 * @see {@link ./satelliteClone} - Clone lifecycle, persona overlays, merge decisions, isolation
 * @see {@link ./distillerLedger} - Merge rejection tracking with JSON/SQLite dual backend
 * @see {@link ./executionReceipts} - Tamper-evident receipt chains with hash linking
 * @see {@link ./judgmentPatterns} - Pattern learning, confidence calibration, outcome signals
 * @see {@link ./cryptoUtils} - Shared hashing, clamping, and parsing utilities
 */

export {
  type FederatedAgentContract,
  type FederatedInboundTask,
  type FederatedDelegationDecision,
  FederatedDelegationGateway
} from "./federatedDelegation";

export {
  type SatellitePersonaRole,
  type SatelliteCloneStatus,
  type SatellitePersonaOverlay,
  type SatelliteCloneRecord,
  type SatelliteSpawnPolicy,
  type SatelliteSpawnRequest,
  type SatelliteSpawnDecision,
  type SatelliteMergeDecisionInput,
  type SatelliteMergeDecision,
  type SatelliteRelayRequest,
  type SatelliteRelayDecision,
  SatelliteCloneCoordinator,
  SatelliteIsolationBroker
} from "./satelliteClone";

export {
  type DistillerMergeLedgerEntry,
  DistillerMergeLedgerStore
} from "./distillerLedger";

export {
  type ExecutionReceipt,
  type AppendExecutionReceiptInput,
  type ExecutionReceiptVerificationResult,
  ExecutionReceiptStore
} from "./executionReceipts";

export {
  type JudgmentSignalType,
  type JudgmentRiskPosture,
  type JudgmentPatternStatus,
  type JudgmentOutcomeSignal,
  type JudgmentPattern,
  type RecordJudgmentPatternInput,
  type JudgmentCalibrationResult,
  JudgmentPatternStore,
  deriveJudgmentPatternFromTaskRun
} from "./judgmentPatterns";
