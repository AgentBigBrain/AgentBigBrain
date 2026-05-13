/**
 * @fileoverview Source Recall capture helpers for lower-authority conversation job surfaces.
 */

import {
  captureLowerAuthoritySourceRecall,
  type LowerAuthoritySourceRecallCaptureResult
} from "../../core/sourceRecall/sourceRecallConversationCapture";
import type { TaskPrincipalAccessEnvelope } from "../../core/types";
import type { ConversationJob, ConversationSession } from "../sessionStore";
import { requirePrincipalAccessForOperation } from "../principalRuntime/principalAccess";
import type { ConversationSourceRecallCaptureDependencies } from "./managerContracts";

export interface CaptureConversationJobSourceRecallInput {
  session: ConversationSession;
  job: ConversationJob;
  sourceRecallCapture?: ConversationSourceRecallCaptureDependencies | null;
}

export interface CaptureConversationJobSourceRecallResult {
  assistantTurnResult: LowerAuthoritySourceRecallCaptureResult | null;
  taskInputResult: LowerAuthoritySourceRecallCaptureResult | null;
  taskSummaryResult: LowerAuthoritySourceRecallCaptureResult | null;
}

/**
 * Captures persisted task input, generated task summary, and final assistant summary as Source Recall.
 *
 * **Why it exists:**
 * Job input and result summaries can help answer "what did this workflow run do?" but they are not
 * original user turns, governed facts, approvals, or completion proof. This helper also avoids full
 * execution prompts so Source Recall does not become a hidden prompt archive.
 *
 * **What it talks to:**
 * - Uses `captureLowerAuthoritySourceRecall` from
 *   `../../core/sourceRecall/sourceRecallConversationCapture`.
 *
 * @param input - Session, persisted job, and optional Source Recall capture dependencies.
 * @returns Capture results for assistant final text, task input, and task summary when attempted.
 */
export async function captureConversationJobSourceRecall(
  input: CaptureConversationJobSourceRecallInput
): Promise<CaptureConversationJobSourceRecallResult> {
  const sourceRecallCapture = input.sourceRecallCapture ?? null;
  if (!sourceRecallCapture) {
    return {
      assistantTurnResult: null,
      taskInputResult: null,
      taskSummaryResult: null
    };
  }

  try {
    const isAgentPulseJob =
      input.job.pulseMetadata?.kind === "agent_pulse" &&
      input.job.pulseMetadata.sourceRecallTaskInputCaptureAllowed === false;
    const taskInputText = normalizeTaskSourceText(input.job.input);
    const taskSummaryText = normalizeTaskSourceText(input.job.resultSummary ?? "");
    const scopeId = `conversation:${input.session.conversationId}`;
    const threadId = `conversation:${input.session.conversationId}`;
    const principalAccess = buildJobSourceRecallCapturePrincipalAccess(input.session);

    const taskInputResult = taskInputText && !isAgentPulseJob
      ? await captureLowerAuthoritySourceRecall({
          scopeId,
          threadId,
          text: taskInputText,
          observedAt: input.job.createdAt,
          sourceKind: "task_input",
          sourceRole: "runtime",
          captureClass: "operational_output",
          sourceAuthority: "strict_schema",
          sourceTimeKind: "captured_record",
          freshness: "recent",
          originSurface: "conversation_job",
          originRefId: `${input.session.conversationId}:${input.job.id}:input`,
          originParentRefId: input.job.id,
          policy: sourceRecallCapture.policy,
          writer: sourceRecallCapture.writer,
          capturedAt: sourceRecallCapture.capturedAt,
          principalAccess
        })
      : null;

    const taskSummaryResult = taskSummaryText
      ? await captureLowerAuthoritySourceRecall({
          scopeId,
          threadId,
          text: taskSummaryText,
          observedAt: input.job.completedAt ?? input.job.startedAt ?? input.job.createdAt,
          sourceKind: "task_summary",
          sourceRole: "runtime",
          captureClass: "operational_output",
          sourceAuthority: "stale_runtime_context",
          sourceTimeKind: "generated_summary",
          freshness: "recent",
          originSurface: "conversation_job",
          originRefId: `${input.session.conversationId}:${input.job.id}:summary`,
          originParentRefId: input.job.id,
          policy: sourceRecallCapture.policy,
          writer: sourceRecallCapture.writer,
          capturedAt: sourceRecallCapture.capturedAt,
          principalAccess
        })
      : null;
    const assistantTurnResult = taskSummaryText
      ? await captureLowerAuthoritySourceRecall({
          scopeId,
          threadId,
          text: taskSummaryText,
          observedAt: input.job.completedAt ?? input.job.startedAt ?? input.job.createdAt,
          sourceKind: "assistant_turn",
          sourceRole: "assistant",
          captureClass: "assistant_output",
          sourceAuthority: "semantic_model",
          sourceTimeKind: "generated_summary",
          freshness: "recent",
          originSurface: "conversation_job",
          originRefId: `${input.session.conversationId}:${input.job.id}:assistant-final`,
          originParentRefId: input.job.id,
          policy: sourceRecallCapture.policy,
          writer: sourceRecallCapture.writer,
          capturedAt: sourceRecallCapture.capturedAt,
          principalAccess
        })
      : null;

    return {
      assistantTurnResult,
      taskInputResult,
      taskSummaryResult
    };
  } catch {
    return {
      assistantTurnResult: null,
      taskInputResult: null,
      taskSummaryResult: null
    };
  }
}

/**
 * Normalizes task source text without adding summarization or prompt context.
 *
 * @param value - Candidate persisted job text.
 * @returns Trimmed text, or empty when there is nothing to capture.
 */
function normalizeTaskSourceText(value: string): string {
  return value.trim();
}

/**
 * Implements `buildJobSourceRecallCapturePrincipalAccess` behavior within this module.
 */
function buildJobSourceRecallCapturePrincipalAccess(
  session: ConversationSession
): TaskPrincipalAccessEnvelope | undefined {
  const principalContext = session.principalContext;
  if (!principalContext) {
    return undefined;
  }
  return requirePrincipalAccessForOperation({
    principalContext,
    operation: "source_recall_capture",
    accessClass: principalContext.route.visibility === "public" ? "shared_public" : "session_only",
    allowed: true,
    reason: principalContext.route.visibility === "public" ? "public_safe" : "session_only_allowed"
  });
}
