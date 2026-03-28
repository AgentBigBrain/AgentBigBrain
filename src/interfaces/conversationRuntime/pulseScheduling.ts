/**
 * @fileoverview Stable entrypoint for canonical proactive delivery-selection helpers.
 */

export {
  conversationBelongsToProvider,
  selectPulseTargetSession,
  shouldSkipSessionForPulse,
  shouldSuppressPulseForSessionDomain,
  sortByMostRecentSessionUpdate
} from "../proactiveRuntime/deliveryPolicy";
