/**
 * @fileoverview Canonical preview-streaming helpers for final conversation delivery.
 */

import { isRateLimitedErrorCode } from "../ackStateMachine";
import type {
  ConversationDeliveryResult,
  ConversationNotifierTransport
} from "./managerContracts";

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

export interface EditableAckPreviewResult {
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
export async function streamNativeFinalPreview(
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
export async function streamEditableAckPreview(
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
 * Pauses between preview updates so client rendering appears incremental.
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
