/**
 * @fileoverview Initial retraction and redaction contracts for canonical profile-memory truth.
 */

import type { ProfileMemoryGovernanceFamily } from "./profileMemoryTruthGovernanceContracts";

export type ProfileMemoryRetractionClass =
  | "historical_transition"
  | "correction_override"
  | "forget_or_delete";

export type ProfileMemoryRetractionRedactionState =
  | "not_requested"
  | "redaction_pending"
  | "value_redacted"
  | "tokenized"
  | "hashed";

export interface ProfileMemoryRetractionContract {
  family: ProfileMemoryGovernanceFamily;
  retractionClass: ProfileMemoryRetractionClass;
  redactionState: ProfileMemoryRetractionRedactionState;
  clearsCompatibilityProjection: boolean;
  preservesAuditHandle: boolean;
}
