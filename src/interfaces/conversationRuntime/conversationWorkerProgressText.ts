/**
 * @fileoverview Human-first worker progress phrasing for queued and heartbeat updates.
 */

import type { ConversationJob } from "../sessionStore";
import { parseAutonomousExecutionInput } from "./managerContracts";

type WorkerProgressKind =
  | "build_preview"
  | "edit_preview"
  | "organize_folders"
  | "close_preview"
  | "explain_saved_work"
  | "inspect_blocker"
  | "generic_autonomous"
  | "generic_request";

/**
 * Normalizes worker progress source text into one bounded lowercase line for deterministic
 * narration selection.
 *
 * @param input - Raw user-facing request text.
 * @returns Lowercased single-line worker progress text.
 */
function normalizeProgressText(input: string | null | undefined): string {
  return (input ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Resolves the most meaningful request text for a running job, preferring the autonomous goal when
 * one exists.
 *
 * @param job - Running job whose source text should be rendered.
 * @returns Normalized request text plus whether the job is autonomous.
 */
function resolveProgressSourceText(
  job: Pick<ConversationJob, "input" | "executionInput">
): {
  normalizedText: string;
  autonomous: boolean;
} {
  const parsedAutonomousInput = job.executionInput
    ? parseAutonomousExecutionInput(job.executionInput)
    : null;
  const sourceText =
    parsedAutonomousInput?.goal ??
    job.input ??
    job.executionInput ??
    "";
  return {
    normalizedText: normalizeProgressText(sourceText),
    autonomous: parsedAutonomousInput !== null
  };
}

/**
 * Returns whether a normalized text contains any phrase from a bounded list.
 *
 * @param text - Normalized candidate text.
 * @param phrases - Candidate phrases to look for.
 * @returns `true` when any phrase is present.
 */
function containsAny(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

/**
 * Maps a running job request into a narrow worker-progress narration family.
 *
 * This is intentionally descriptive only. It does not participate in intent routing, safety, or
 * recovery authorization.
 *
 * @param text - Normalized request text.
 * @param autonomous - Whether the running job came from the autonomous loop.
 * @returns Worker progress category used for user-facing narration.
 */
function detectWorkerProgressKind(
  text: string,
  autonomous: boolean
): WorkerProgressKind {
  if (
    (containsAny(text, [
      "what changed",
      "tell me about",
      "explain what",
      "summarize",
      "summary of",
      "rough draft",
      "ready to review",
      "review first"
    ]) &&
      containsAny(text, [
        "change",
        "draft",
        "review",
        "work",
        "ready",
        "finished"
      ])) ||
    (text.includes("while i was away") && containsAny(text, ["what", "changed", "done"]))
  ) {
    return "explain_saved_work";
  }

  if (
    containsAny(text, [
      "close the",
      "close that",
      "shut down",
      "stop the",
      "close it"
    ]) &&
    containsAny(text, [
      "browser",
      "preview",
      "landing page",
      "page",
      "window",
      "server"
    ])
  ) {
    return "close_preview";
  }

  if (
    containsAny(text, [
      "organize",
      "move every folder",
      "move all the",
      "put every folder",
      "put all the",
      "should go in"
    ]) &&
    containsAny(text, [
      "folder",
      "folders",
      "desktop",
      "drone-folder",
      "drone-web-projects",
      "drone-company"
    ])
  ) {
    return "organize_folders";
  }

  if (
    containsAny(text, [
      "slider",
      "carousel",
      "edit the",
      "update the",
      "change the",
      "turn the hero"
    ]) &&
    containsAny(text, [
      "hero",
      "section",
      "page",
      "landing page",
      "site",
      "homepage",
      "preview"
    ])
  ) {
    return "edit_preview";
  }

  if (
    containsAny(text, [
      "build a",
      "create a",
      "make a",
      "design a",
      "generate a"
    ]) &&
    containsAny(text, [
      "page",
      "landing page",
      "site",
      "website",
      "homepage"
    ])
  ) {
    return "build_preview";
  }

  if (
    containsAny(text, [
      "inspect",
      "check",
      "verify",
      "figure out",
      "look into"
    ]) &&
    containsAny(text, [
      "blocker",
      "preview",
      "browser",
      "workspace",
      "holder",
      "safe"
    ])
  ) {
    return "inspect_blocker";
  }

  return autonomous ? "generic_autonomous" : "generic_request";
}

/**
 * Renders the base human-first sentence for one worker-progress narration family.
 *
 * @param kind - Worker progress category chosen for the active job.
 * @returns Human-first worker progress sentence without elapsed-time context.
 */
function buildBaseWorkerProgressMessage(kind: WorkerProgressKind): string {
  switch (kind) {
    case "build_preview":
      return "I'm building the page and setting up the preview.";
    case "edit_preview":
      return "I'm updating the current page and keeping the preview in sync.";
    case "organize_folders":
      return "I'm organizing the project folders and checking what can be moved safely.";
    case "close_preview":
      return "I'm closing the tracked preview and making sure that page is not left open.";
    case "explain_saved_work":
      return "I'm reviewing the saved work so I can summarize the changes clearly.";
    case "inspect_blocker":
      return "I'm checking the current workspace and verifying what is safe to do next.";
    case "generic_autonomous":
      return "I'm working through the next step and keeping the current workspace aligned.";
    case "generic_request":
    default:
      return "I'm working on that now.";
  }
}

/**
 * Builds a calmer, typed worker progress line for queued jobs and heartbeat updates.
 *
 * This helper is intentionally deterministic and meaning-light: it only improves user-facing
 * progress narration after a job is already running. It does not participate in routing,
 * authorization, or recovery decisions.
 *
 * @param job - Running job being described.
 * @param elapsed - Optional elapsed-time value in seconds.
 * @returns Human-first worker progress message.
 */
export function buildConversationWorkerProgressMessage(
  job: Pick<ConversationJob, "input" | "executionInput">,
  elapsed?: number
): string {
  const {
    normalizedText,
    autonomous
  } = resolveProgressSourceText(job);
  const baseMessage = buildBaseWorkerProgressMessage(
    detectWorkerProgressKind(normalizedText, autonomous)
  );
  if (typeof elapsed !== "number") {
    return baseMessage;
  }
  return baseMessage.replace(/\.$/, ` (${elapsed}s elapsed).`);
}
