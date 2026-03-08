/**
 * @fileoverview Canonical contracts for the stable conversation delivery lifecycle entrypoint.
 */

import type {
  ConversationAckLifecycleState,
  ConversationJob,
  InterfaceSessionStore
} from "../sessionStore";
import type { ConversationNotifierTransport } from "./managerContracts";

export interface ActiveAckTimerRecord {
  jobId: string;
  generation: number;
}

export type AckLifecycleSetter = (
  job: ConversationJob,
  nextState: ConversationAckLifecycleState,
  fallbackErrorCode: string
) => void;

export type AckTimerSupportEvaluator = (
  sessionKey: string,
  notifier: ConversationNotifierTransport
) => boolean;

export interface HandleAckTimerFireInput {
  sessionKey: string;
  timerRecord: ActiveAckTimerRecord;
  notify: ConversationNotifierTransport;
  store: InterfaceSessionStore;
  maxRecentJobs: number;
  canUseAckTimerForSession: AckTimerSupportEvaluator;
  setAckLifecycleState: AckLifecycleSetter;
}

export interface ScheduleAckTimerForJobInput {
  sessionKey: string;
  runningJob: ConversationJob;
  notify: ConversationNotifierTransport;
  ackTimers: Map<string, NodeJS.Timeout>;
  clearAckTimer(sessionKey: string): void;
  canUseAckTimerForSession: AckTimerSupportEvaluator;
  onTimerFire(timerRecord: ActiveAckTimerRecord): Promise<void>;
}

export interface DeliverFinalMessageInput {
  sessionKey: string;
  jobId: string;
  finalMessage: string;
  notify: ConversationNotifierTransport;
  store: InterfaceSessionStore;
  maxRecentJobs: number;
  canUseAckTimerForSession: AckTimerSupportEvaluator;
  setAckLifecycleState: AckLifecycleSetter;
}
