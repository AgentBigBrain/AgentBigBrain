/**
 * @fileoverview Redacted principal snapshot contracts for persisted conversation jobs.
 */

import type {
  IdentityAuthority,
  LegacyIdentityState,
  OwnerMatchSource,
  PrincipalAccessClass,
  PrincipalAccessOperation,
  PrincipalAccessReason,
  PrincipalRole
} from "../principalRuntime/principalAccess";

export type ConversationJobSnapshotRouteVisibility = "private" | "public" | "unknown";

export type ConversationJobPrincipalSnapshotState =
  | "verified"
  | "legacy_actor_unknown"
  | "malformed_blocked";

export interface ConversationJobPrincipalSnapshot {
  snapshotState: ConversationJobPrincipalSnapshotState;
  principalRole: PrincipalRole;
  routeVisibility: ConversationJobSnapshotRouteVisibility;
  accessOperation: PrincipalAccessOperation;
  accessClass: PrincipalAccessClass;
  accessAllowed: boolean;
  accessReason: PrincipalAccessReason;
  identityAuthority: IdentityAuthority;
  ownerMatchSource: OwnerMatchSource;
  legacyIdentityState: LegacyIdentityState;
  principalIdHash: string | null;
  providerUserIdHash: string | null;
  decisionId: string | null;
}
