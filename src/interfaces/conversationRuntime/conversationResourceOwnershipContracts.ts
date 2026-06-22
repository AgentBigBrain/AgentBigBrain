/**
 * @fileoverview Compact redacted ownership contracts for recoverable conversation runtime resources.
 */

import type {
  LegacyIdentityState,
  PrincipalAccessClass,
  PrincipalRole
} from "../principalRuntime/principalAccess";

export type ConversationResourceRouteVisibility = "private" | "public" | "unknown";

export interface ConversationResourceOwnerMetadata {
  principalRole: PrincipalRole;
  routeVisibility: ConversationResourceRouteVisibility;
  accessClass: PrincipalAccessClass;
  legacyIdentityState: LegacyIdentityState;
  providerUserIdHash: string | null;
  sourceJobId: string | null;
}
