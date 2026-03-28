/**
 * @fileoverview Executes loopback browser verification for live-run flows.
 */

import { ExecutorExecutionOutcome, VerifyBrowserActionParams } from "../../core/types";
import { isAbortError, throwIfAborted } from "../../core/runtimeAbort";
import {
  buildBrowserVerificationExecutionMetadata,
  buildExecutionOutcome,
  isLoopbackBrowserVerificationHost,
  LiveRunExecutorContext,
  normalizeOptionalString,
  resolveBrowserVerificationTimeoutMs,
  withRecoveryFailureMetadata
} from "./contracts";

/**
 * Executes `verify_browser` through the configured browser verifier backend.
 *
 * **Why it exists:**
 * Keeps loopback page verification separate from the generic executor so browser-proof policy and
 * result mapping stay localized to the live-run subsystem.
 *
 * **What it talks to:**
 * - Uses `BrowserVerifier` through `LiveRunExecutorContext`.
 * - Uses browser verification metadata helpers from `./contracts`.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param params - Structured planner params for this verification request.
 * @param signal - Optional abort signal propagated from the runtime.
 * @returns Promise resolving to a typed executor outcome.
 */
export async function executeBrowserVerification(
  context: LiveRunExecutorContext,
  params: VerifyBrowserActionParams,
  signal?: AbortSignal
): Promise<ExecutorExecutionOutcome> {
  throwIfAborted(signal);
  const url = normalizeOptionalString(params.url);
  if (!url) {
    return buildExecutionOutcome(
      "blocked",
      "Browser verification blocked: missing params.url.",
      "BROWSER_VERIFY_MISSING_URL"
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return buildExecutionOutcome(
      "blocked",
      "Browser verification blocked: params.url must be a valid absolute URL.",
      "BROWSER_VERIFY_URL_INVALID"
    );
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return buildExecutionOutcome(
      "blocked",
      "Browser verification blocked: params.url must use http or https.",
      "BROWSER_VERIFY_URL_INVALID"
    );
  }
  if (!isLoopbackBrowserVerificationHost(parsedUrl.hostname)) {
    return buildExecutionOutcome(
      "blocked",
      "Browser verification blocked: params.url must target localhost, 127.0.0.1, or ::1.",
      "BROWSER_VERIFY_URL_NOT_LOCAL"
    );
  }

  const timeoutMs = resolveBrowserVerificationTimeoutMs(context.config, params.timeoutMs);
  const expectedTitle = normalizeOptionalString(params.expectedTitle);
  const expectedText = normalizeOptionalString(params.expectedText);

  try {
    const verificationResult = await context.browserVerifier.verify({
      url: parsedUrl.toString(),
      expectedTitle,
      expectedText,
      timeoutMs,
      signal
    });

    const executionMetadata = buildBrowserVerificationExecutionMetadata({
      url: parsedUrl.toString(),
      passed: verificationResult.status === "verified",
      observedTitle: verificationResult.observedTitle,
      observedTextSample: verificationResult.observedTextSample,
      matchedTitle: verificationResult.matchedTitle,
      matchedText: verificationResult.matchedText,
      expectedTitle,
      expectedText,
      timeoutMs,
      lifecycleCode:
        verificationResult.status === "verified" ||
        verificationResult.status === "expectation_failed"
          ? "PROCESS_READY"
          : undefined
    });

    switch (verificationResult.status) {
      case "verified":
        return buildExecutionOutcome(
          "success",
          verificationResult.detail,
          undefined,
          executionMetadata
        );
      case "expectation_failed":
        return buildExecutionOutcome(
          "failed",
          verificationResult.detail,
          "BROWSER_VERIFY_EXPECTATION_FAILED",
          executionMetadata
        );
      case "runtime_unavailable":
        return buildExecutionOutcome(
          "failed",
          verificationResult.detail,
          "BROWSER_VERIFY_RUNTIME_UNAVAILABLE",
          withRecoveryFailureMetadata(
            executionMetadata,
            "DEPENDENCY_MISSING",
            "runtime_live_run"
          )
        );
      case "failed":
      default:
        return buildExecutionOutcome(
          "failed",
          verificationResult.detail,
          "BROWSER_VERIFY_FAILED",
          executionMetadata
        );
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return buildExecutionOutcome(
      "failed",
      `Browser verification failed: ${(error as Error).message}`,
      "BROWSER_VERIFY_FAILED"
    );
  }
}
