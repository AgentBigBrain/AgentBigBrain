/**
 * @fileoverview Implements deterministic ack timer and final delivery persistence flows for conversation jobs.
 */

import {
  assertAckInvariants,
  canEditAckMessage,
  deriveAckEligibility,
  isFinalDeliveryTerminal,
  isRateLimitedErrorCode
} from "./ackStateMachine";
import {
  ConversationAckLifecycleState,
  ConversationJob,
  InterfaceSessionStore
} from "./sessionStore";
import {
  findRecentJob,
  upsertRecentJob
} from "./conversationSessionMutations";

export interface ConversationDeliveryResult {
  ok: boolean;
  messageId: string | null;
  errorCode: string | null;
}

export interface ConversationNotifierCapabilities {
  supportsEdit: boolean;
  supportsNativeStreaming: boolean;
}

export interface ConversationNotifierTransport {
  capabilities: ConversationNotifierCapabilities;
  send(message: string): Promise<ConversationDeliveryResult>;
  edit?(messageId: string, message: string): Promise<ConversationDeliveryResult>;
  stream?(message: string): Promise<ConversationDeliveryResult>;
}

export interface ActiveAckTimerRecord {
  jobId: string;
  generation: number;
}

type AckLifecycleSetter = (
  job: ConversationJob,
  nextState: ConversationAckLifecycleState,
  fallbackErrorCode: string
) => void;

type AckTimerSupportEvaluator = (
  sessionKey: string,
  notifier: ConversationNotifierTransport
) => boolean;

const NATIVE_STREAM_FINAL_PREVIEW_MAX_UPDATES = 180;
const NATIVE_STREAM_FINAL_PREVIEW_MIN_STEP_DELAY_MS = 18;
const NATIVE_STREAM_FINAL_PREVIEW_MAX_STEP_DELAY_MS = 70;
const NATIVE_STREAM_FINAL_PREVIEW_TARGET_DURATION_MS = 2_400;
const EDITABLE_ACK_PREVIEW_MAX_UPDATES = 28;
const EDITABLE_ACK_PREVIEW_MIN_STEP_DELAY_MS = 120;
const EDITABLE_ACK_PREVIEW_MAX_STEP_DELAY_MS = 280;
const EDITABLE_ACK_PREVIEW_TARGET_DURATION_MS = 3_200;
const EDITABLE_ACK_PREVIEW_RATE_LIMIT_RETRY_DELAY_MS = 260;
const PREVIEW_PUNCTUATION_PAUSE_MS = 45;

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

/**
 * Schedules delayed ack timer delivery for one running job when transport/session capabilities allow it.
 *
 * @param input - Timer state, running job metadata, and lifecycle callbacks.
 */
export function scheduleAckTimerForJob(input: ScheduleAckTimerForJobInput): void {
  const {
    sessionKey,
    runningJob,
    notify,
    ackTimers,
    clearAckTimer,
    canUseAckTimerForSession,
    onTimerFire
  } = input;
  clearAckTimer(sessionKey);
  if (!canUseAckTimerForSession(sessionKey, notify)) {
    return;
  }
  if (!runningJob.ackEligibleAt) {
    return;
  }

  const eligibleAtMs = Date.parse(runningJob.ackEligibleAt);
  if (!Number.isFinite(eligibleAtMs)) {
    return;
  }
  const delayMs = Math.max(0, eligibleAtMs - Date.now());
  const timerRecord: ActiveAckTimerRecord = {
    jobId: runningJob.id,
    generation: runningJob.ackTimerGeneration
  };
  const timer = setTimeout(() => {
    ackTimers.delete(sessionKey);
    void onTimerFire(timerRecord);
  }, delayMs);
  ackTimers.set(sessionKey, timer);
}

/**
 * Processes an expired ack timer and persists deterministic ack metadata outcomes.
 *
 * @param input - Ack timer context and callback dependencies from conversation manager.
 * @returns Promise resolving once ack timer outcomes are persisted.
 */
export async function handleAckTimerFire(input: HandleAckTimerFireInput): Promise<void> {
  const {
    sessionKey,
    timerRecord,
    notify,
    store,
    maxRecentJobs,
    canUseAckTimerForSession,
    setAckLifecycleState
  } = input;

  const session = await store.getSession(sessionKey);
  if (!session || session.runningJobId !== timerRecord.jobId) {
    return;
  }

  const runningJob = findRecentJob(session, timerRecord.jobId);
  if (!runningJob || runningJob.status !== "running") {
    return;
  }
  if (runningJob.ackTimerGeneration !== timerRecord.generation) {
    return;
  }

  const nowIso = new Date().toISOString();
  const eligibility = deriveAckEligibility(
    runningJob,
    nowIso,
    canUseAckTimerForSession(sessionKey, notify)
  );
  if (!eligibility.eligible) {
    if (eligibility.reasonCode && eligibility.reasonCode !== "ACK_DELAY_NOT_REACHED") {
      runningJob.ackLastErrorCode = eligibility.reasonCode;
      upsertRecentJob(session, runningJob, maxRecentJobs);
      session.updatedAt = nowIso;
      await store.setSession(session);
    }
    return;
  }

  const ackMessage = "Working on it. Use /status for live state.";
  const delivery = await notify.send(ackMessage);
  if (!delivery.ok) {
    setAckLifecycleState(
      runningJob,
      "CANCELLED",
      delivery.errorCode ?? "ACK_SEND_FAILED"
    );
    runningJob.ackLastErrorCode = delivery.errorCode ?? "ACK_SEND_FAILED";
    upsertRecentJob(session, runningJob, maxRecentJobs);
    session.updatedAt = nowIso;
    await store.setSession(session);
    return;
  }

  if (!delivery.messageId) {
    setAckLifecycleState(
      runningJob,
      "CANCELLED",
      "ACK_MESSAGE_ID_MISSING"
    );
    runningJob.ackLastErrorCode = "ACK_MESSAGE_ID_MISSING";
    upsertRecentJob(session, runningJob, maxRecentJobs);
    session.updatedAt = nowIso;
    await store.setSession(session);
    return;
  }

  setAckLifecycleState(runningJob, "SENT", "ACK_STATE_TRANSITION_BLOCKED");
  runningJob.ackMessageId = delivery.messageId;
  runningJob.ackSentAt = nowIso;
  runningJob.ackLastErrorCode = null;
  const invariant = assertAckInvariants(runningJob);
  if (!invariant.ok) {
    setAckLifecycleState(
      runningJob,
      "CANCELLED",
      invariant.reasonCode ?? "ACK_INVARIANT_FAILED"
    );
    runningJob.ackLastErrorCode = invariant.reasonCode ?? "ACK_INVARIANT_FAILED";
    runningJob.ackMessageId = null;
  }

  upsertRecentJob(session, runningJob, maxRecentJobs);
  session.updatedAt = nowIso;
  await store.setSession(session);
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

/**
 * Pauses between native draft stream updates so client rendering appears incremental.
 *
 * @param ms - Delay duration in milliseconds.
 * @returns Promise resolved after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds bounded cumulative word-level steps used for typewriter-style final-message previews.
 *
 * @param finalMessage - Final message text that will be sent persistently after preview streaming.
 * @param includeFinalText - Whether preview steps should include the complete final text.
 * @returns Ordered cumulative preview steps.
 */
function buildWordPreviewSteps(
  finalMessage: string,
  includeFinalText: boolean,
  maxUpdates: number
): string[] {
  const normalized = finalMessage.trim();
  if (!normalized) {
    return [];
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    return includeFinalText ? [normalized] : [];
  }

  const previewWordCount = includeFinalText ? words.length : words.length - 1;
  if (previewWordCount <= 0) {
    return [];
  }

  const safeMaxUpdates = Math.max(1, maxUpdates);
  const stride = Math.max(1, Math.ceil(previewWordCount / safeMaxUpdates));
  const steps: string[] = [];
  for (let wordCount = 1; wordCount <= previewWordCount; wordCount += stride) {
    steps.push(words.slice(0, wordCount).join(" "));
  }

  const previewTerminal = words.slice(0, previewWordCount).join(" ");
  if (steps.length === 0 || steps[steps.length - 1] !== previewTerminal) {
    steps.push(previewTerminal);
  }
  if (includeFinalText && steps[steps.length - 1] !== normalized) {
    steps.push(normalized);
  }
  return steps;
}

/**
 * Builds bounded cumulative character-level steps for smoother native-draft streaming previews.
 *
 * @param finalMessage - Final message text that will be sent persistently after preview streaming.
 * @param includeFinalText - Whether preview steps should include the complete final text.
 * @param maxUpdates - Upper bound for number of preview updates.
 * @returns Ordered cumulative preview steps.
 */
function buildCharacterPreviewSteps(
  finalMessage: string,
  includeFinalText: boolean,
  maxUpdates: number
): string[] {
  const normalized = finalMessage.trim();
  if (!normalized) {
    return [];
  }

  const characters = Array.from(normalized);
  if (characters.length <= 1) {
    return includeFinalText ? [normalized] : [];
  }

  const previewCharacterCount = includeFinalText
    ? characters.length
    : characters.length - 1;
  if (previewCharacterCount <= 0) {
    return [];
  }

  const safeMaxUpdates = Math.max(1, maxUpdates);
  const stride = Math.max(1, Math.ceil(previewCharacterCount / safeMaxUpdates));
  const steps: string[] = [];
  for (
    let characterCount = 1;
    characterCount <= previewCharacterCount;
    characterCount += stride
  ) {
    steps.push(characters.slice(0, characterCount).join(""));
  }

  const previewTerminal = characters.slice(0, previewCharacterCount).join("");
  if (steps.length === 0 || steps[steps.length - 1] !== previewTerminal) {
    steps.push(previewTerminal);
  }
  if (includeFinalText && steps[steps.length - 1] !== normalized) {
    steps.push(normalized);
  }
  return steps;
}

/**
 * Resolves bounded adaptive native-preview cadence from target duration and update count.
 *
 * @param updateCount - Number of native preview updates scheduled for this message.
 * @returns Base delay in milliseconds to apply between native preview steps.
 */
function resolveNativePreviewBaseDelayMs(updateCount: number): number {
  if (updateCount <= 1) {
    return NATIVE_STREAM_FINAL_PREVIEW_MIN_STEP_DELAY_MS;
  }
  const candidateDelayMs = Math.round(
    NATIVE_STREAM_FINAL_PREVIEW_TARGET_DURATION_MS / updateCount
  );
  return Math.max(
    NATIVE_STREAM_FINAL_PREVIEW_MIN_STEP_DELAY_MS,
    Math.min(candidateDelayMs, NATIVE_STREAM_FINAL_PREVIEW_MAX_STEP_DELAY_MS)
  );
}

/**
 * Resolves bounded adaptive editable-preview cadence from target duration and update count.
 *
 * @param updateCount - Number of editable preview updates scheduled for this message.
 * @returns Base delay in milliseconds to apply between editable preview steps.
 */
function resolveEditablePreviewBaseDelayMs(updateCount: number): number {
  if (updateCount <= 1) {
    return EDITABLE_ACK_PREVIEW_MIN_STEP_DELAY_MS;
  }
  const candidateDelayMs = Math.round(
    EDITABLE_ACK_PREVIEW_TARGET_DURATION_MS / updateCount
  );
  return Math.max(
    EDITABLE_ACK_PREVIEW_MIN_STEP_DELAY_MS,
    Math.min(candidateDelayMs, EDITABLE_ACK_PREVIEW_MAX_STEP_DELAY_MS)
  );
}

/**
 * Derives a bounded step delay that adds slight pauses at punctuation boundaries.
 *
 * @param stepText - Current cumulative preview text.
 * @param baseDelayMs - Baseline step delay for this transport.
 * @returns Delay in milliseconds before the next preview step.
 */
function derivePreviewStepDelayMs(stepText: string, baseDelayMs: number): number {
  const trimmed = stepText.trim();
  if (!trimmed) {
    return baseDelayMs;
  }
  if (/[,.!?;:]$/.test(trimmed)) {
    return baseDelayMs + PREVIEW_PUNCTUATION_PAUSE_MS;
  }
  return baseDelayMs;
}

/**
 * Sends one editable preview update with a deterministic single retry on rate-limit signals.
 *
 * @param notify - Notifier transport containing editable message capability.
 * @param ackMessageId - Existing ack message id targeted for preview edits.
 * @param message - Preview text payload.
 * @returns Edit delivery result for the update.
 */
async function editPreviewStepWithRetry(
  notify: ConversationNotifierTransport,
  ackMessageId: string,
  message: string
): Promise<ConversationDeliveryResult> {
  const firstAttempt = await notify.edit!(ackMessageId, message);
  if (firstAttempt.ok || !isRateLimitedErrorCode(firstAttempt.errorCode)) {
    return firstAttempt;
  }
  await sleep(EDITABLE_ACK_PREVIEW_RATE_LIMIT_RETRY_DELAY_MS);
  return notify.edit!(ackMessageId, message);
}

interface EditableAckPreviewResult {
  deliveredFullText: boolean;
}

/**
 * Streams a bounded typewriter-style preview through native draft transport before final send.
 *
 * **Why it exists:**
 * Native draft mode should feel incremental to users; this helper emits cumulative updates while
 * preserving fail-closed final delivery if draft streaming fails.
 *
 * **What it talks to:**
 * - Uses notifier `stream(...)` capability when available.
 *
 * @param notify - Notifier transport for the active conversation session.
 * @param finalMessage - Final message that will be sent persistently.
 * @returns Promise resolving after best-effort preview streaming completes.
 */
async function streamNativeFinalPreview(
  notify: ConversationNotifierTransport,
  finalMessage: string
): Promise<void> {
  if (!notify.capabilities.supportsNativeStreaming || typeof notify.stream !== "function") {
    return;
  }

  const steps = buildCharacterPreviewSteps(
    finalMessage,
    false,
    NATIVE_STREAM_FINAL_PREVIEW_MAX_UPDATES
  );
  if (steps.length <= 1) {
    return;
  }
  const baseDelayMs = resolveNativePreviewBaseDelayMs(steps.length);

  for (let index = 0; index < steps.length; index += 1) {
    const delivery = await notify.stream(steps[index]);
    if (!delivery.ok) {
      return;
    }
    if (index < steps.length - 1) {
      await sleep(derivePreviewStepDelayMs(
        steps[index],
        baseDelayMs
      ));
    }
  }
}

/**
 * Streams bounded word-level preview updates by editing the ack message before final replacement.
 *
 * **Why it exists:**
 * Editable Telegram transports can feel static when only one final edit occurs; bounded preview
 * edits make delivery feel live while keeping deterministic final replacement semantics.
 *
 * **What it talks to:**
 * - Uses notifier `edit(...)` capability against the existing ack message id.
 *
 * @param notify - Notifier transport for the active conversation session.
 * @param ackMessageId - Existing ack message id used for progressive edits.
 * @param finalMessage - Final message that will be sent by terminal edit/send path.
 * @returns Promise resolving after best-effort preview edits complete.
 */
async function streamEditableAckPreview(
  notify: ConversationNotifierTransport,
  ackMessageId: string,
  finalMessage: string
): Promise<EditableAckPreviewResult> {
  if (typeof notify.edit !== "function") {
    return { deliveredFullText: false };
  }

  const steps = buildWordPreviewSteps(
    finalMessage,
    true,
    EDITABLE_ACK_PREVIEW_MAX_UPDATES
  );
  if (steps.length === 0) {
    return { deliveredFullText: false };
  }
  const baseDelayMs = resolveEditablePreviewBaseDelayMs(steps.length);
  const normalizedFinalMessage = finalMessage.trim();

  for (let index = 0; index < steps.length; index += 1) {
    const stepText = steps[index];
    const delivery = await editPreviewStepWithRetry(
      notify,
      ackMessageId,
      stepText
    );
    if (!delivery.ok) {
      return { deliveredFullText: false };
    }

    const isLastStep = index >= steps.length - 1;
    if (isLastStep && stepText === normalizedFinalMessage) {
      return { deliveredFullText: true };
    }

    if (!isLastStep) {
      await sleep(derivePreviewStepDelayMs(
        stepText,
        baseDelayMs
      ));
    }
  }

  return { deliveredFullText: false };
}

/**
 * Sends or edits the final user-facing message and persists delivery outcomes.
 *
 * @param input - Final-delivery context and callback dependencies from conversation manager.
 * @returns Promise resolving after final-delivery outcomes are persisted.
 */
export async function deliverFinalMessage(input: DeliverFinalMessageInput): Promise<void> {
  const {
    sessionKey,
    jobId,
    finalMessage,
    notify,
    store,
    maxRecentJobs,
    canUseAckTimerForSession,
    setAckLifecycleState
  } = input;

  const session = await store.getSession(sessionKey);
  if (!session) {
    return;
  }

  const runningOrRecentJob = findRecentJob(session, jobId);
  if (!runningOrRecentJob) {
    return;
  }
  if (isFinalDeliveryTerminal(runningOrRecentJob.finalDeliveryOutcome)) {
    return;
  }

  const canUseAckEdit =
    canUseAckTimerForSession(sessionKey, notify) && canEditAckMessage(runningOrRecentJob);
  const canEditInTransport = typeof notify.edit === "function";
  const baseNowIso = new Date().toISOString();
  let editablePreviewDeliveredFullText = false;
  let editAttempted = false;

  if (runningOrRecentJob.isSystemJob !== true) {
    if (canUseAckEdit && canEditInTransport) {
      const previewResult = await streamEditableAckPreview(
        notify,
        runningOrRecentJob.ackMessageId!,
        finalMessage
      );
      editablePreviewDeliveredFullText = previewResult.deliveredFullText;
    } else {
      await streamNativeFinalPreview(notify, finalMessage);
    }
  }

  if (canUseAckEdit && canEditInTransport) {
    if (editablePreviewDeliveredFullText) {
      runningOrRecentJob.ackEditAttemptCount += 1;
      runningOrRecentJob.finalDeliveryAttemptCount += 1;
      runningOrRecentJob.finalDeliveryLastAttemptAt = baseNowIso;
      setAckLifecycleState(
        runningOrRecentJob,
        "REPLACED",
        "ACK_REPLACE_STATE_TRANSITION_BLOCKED"
      );
      runningOrRecentJob.finalDeliveryOutcome = "sent";
      runningOrRecentJob.finalDeliveryLastErrorCode = null;
      runningOrRecentJob.ackLastErrorCode = null;
      upsertRecentJob(session, runningOrRecentJob, maxRecentJobs);
      session.updatedAt = baseNowIso;
      await store.setSession(session);
      return;
    }

    editAttempted = true;
    runningOrRecentJob.ackEditAttemptCount += 1;
    runningOrRecentJob.finalDeliveryAttemptCount += 1;
    runningOrRecentJob.finalDeliveryLastAttemptAt = baseNowIso;
    const editResult = await notify.edit!(runningOrRecentJob.ackMessageId!, finalMessage);
    if (editResult.ok) {
      setAckLifecycleState(
        runningOrRecentJob,
        "REPLACED",
        "ACK_REPLACE_STATE_TRANSITION_BLOCKED"
      );
      runningOrRecentJob.finalDeliveryOutcome = "sent";
      runningOrRecentJob.finalDeliveryLastErrorCode = null;
      runningOrRecentJob.ackLastErrorCode = null;
      upsertRecentJob(session, runningOrRecentJob, maxRecentJobs);
      session.updatedAt = baseNowIso;
      await store.setSession(session);
      return;
    }
    runningOrRecentJob.ackLastErrorCode = editResult.errorCode ?? "ACK_EDIT_FAILED";
    runningOrRecentJob.finalDeliveryLastErrorCode = editResult.errorCode ?? "ACK_EDIT_FAILED";
  }

  const sendAttemptAt = new Date().toISOString();
  runningOrRecentJob.finalDeliveryAttemptCount += 1;
  runningOrRecentJob.finalDeliveryLastAttemptAt = sendAttemptAt;
  const sendResult = await notify.send(finalMessage);
  if (sendResult.ok) {
    runningOrRecentJob.finalDeliveryOutcome = "sent";
    runningOrRecentJob.finalDeliveryLastErrorCode = null;
    setAckLifecycleState(
      runningOrRecentJob,
      "FINAL_SENT_NO_EDIT",
      "ACK_FINAL_NO_EDIT_STATE_TRANSITION_BLOCKED"
    );
    upsertRecentJob(session, runningOrRecentJob, maxRecentJobs);
    session.updatedAt = sendAttemptAt;
    await store.setSession(session);
    return;
  }

  runningOrRecentJob.finalDeliveryOutcome = isRateLimitedErrorCode(sendResult.errorCode)
    ? "rate_limited"
    : "failed";
  runningOrRecentJob.finalDeliveryLastErrorCode =
    sendResult.errorCode ??
    (editAttempted ? "FINAL_SEND_FAILED_AFTER_EDIT_ATTEMPT" : "FINAL_SEND_FAILED");
  runningOrRecentJob.errorMessage =
    `Final response delivery failed (${runningOrRecentJob.finalDeliveryLastErrorCode}).`;
  runningOrRecentJob.status = "failed";
  setAckLifecycleState(
    runningOrRecentJob,
    "CANCELLED",
    runningOrRecentJob.finalDeliveryLastErrorCode
  );
  runningOrRecentJob.ackLastErrorCode = runningOrRecentJob.finalDeliveryLastErrorCode;
  upsertRecentJob(session, runningOrRecentJob, maxRecentJobs);
  session.updatedAt = sendAttemptAt;
  await store.setSession(session);
}
