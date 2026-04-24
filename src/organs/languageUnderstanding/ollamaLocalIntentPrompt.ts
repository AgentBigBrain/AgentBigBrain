import type { ConversationIntentSemanticHint } from "../../interfaces/conversationRuntime/intentModeContracts";
import type { LocalIntentModelSignal, LocalIntentModelSessionHints } from "./localIntentModelContracts";
import type { ConversationSemanticRouteId } from "../../interfaces/conversationRuntime/intentModeContracts";

export type SupportedLocalIntentMode =
  | "chat"
  | "plan"
  | "build"
  | "static_html_build"
  | "framework_app_build"
  | "clarify_build_format"
  | "autonomous"
  | "review"
  | "status_or_recall"
  | "discover_available_capabilities";

export const SUPPORTED_MODES = new Set<SupportedLocalIntentMode>([
  "chat",
  "plan",
  "build",
  "static_html_build",
  "framework_app_build",
  "clarify_build_format",
  "autonomous",
  "review",
  "status_or_recall",
  "discover_available_capabilities"
]);

export const SUPPORTED_CONFIDENCE = new Set<LocalIntentModelSignal["confidence"]>([
  "low",
  "medium",
  "high"
]);

export const SUPPORTED_SEMANTIC_HINTS = new Set<ConversationIntentSemanticHint>([
  "review_ready",
  "guided_review",
  "next_review_step",
  "while_away_review",
  "wrap_up_summary",
  "explain_handoff",
  "resume_handoff"
]);

export const SUPPORTED_ROUTE_IDS = new Set<ConversationSemanticRouteId>([
  "chat_answer",
  "relationship_recall",
  "status_recall",
  "plan_request",
  "build_request",
  "static_html_build",
  "framework_app_build",
  "clarify_build_format",
  "clarify_execution_mode",
  "autonomous_execution",
  "review_feedback",
  "capability_discovery"
]);

/**
 * Builds the bounded classifier prompt sent to the local Phi model.
 *
 * @param userInput - Raw user request being classified.
 * @param routingHint - Optional deterministic routing hint supplied by the front door.
 * @param sessionHints - Current session context supplied to the local intent model.
 * @returns Prompt text constrained to the local intent-model contract.
 */
export function buildLocalIntentPrompt(
  userInput: string,
  routingHint: object | null,
  sessionHints: LocalIntentModelSessionHints | null
): string {
  return [
    "Classify the user's request for AgentBigBrain.",
    "Return JSON only.",
    "Choose the semantic route by meaning, not by matching hidden token lists or phrase tables.",
    "Allowed routeId values: chat_answer, relationship_recall, status_recall, plan_request, build_request, static_html_build, framework_app_build, clarify_build_format, clarify_execution_mode, autonomous_execution, review_feedback, capability_discovery.",
    "Allowed confidence values: low, medium, high.",
    "Optional semanticHint values: review_ready, guided_review, next_review_step, while_away_review, wrap_up_summary, explain_handoff, resume_handoff.",
    "The runtime will derive legacy execution mode from routeId. Do not return a mode field.",
    "Use semanticHint only when the session hints show durable return-handoff context.",
    "If session hints show recentAssistantTurnKind=\"informational_answer\" and recentAssistantAnswerThreadActive=true, keep short ambiguous follow-ups like 'okay, what else?', 'tell me more', or 'and?' on the chat path unless the user explicitly re-anchors to saved work, a draft, a page, a browser window, or another concrete artifact.",
    "Use autonomous_execution only when the user clearly wants the assistant to handle the task end to end.",
    "Phrases like 'end to end', 'take care of it', or 'handle everything' are ambiguous on their own.",
    "Only use autonomous_execution for those ambiguous phrases when the same request clearly contains workflow or execution context, or when session hints show workflow continuity.",
    "If session hints show a profile or relationship lane without workflow continuity, prefer chat_answer or build_request over autonomous_execution for ambiguous end-to-end wording.",
    "Promote to autonomous_execution when the user says strong completion phrases like 'go until you finish' or 'keep going until it's done', or when end-to-end phrasing appears with clear workflow context.",
    "Use build_request when the user clearly wants execution or implementation now, but not necessarily a long autonomous loop.",
    "Use static_html_build when the user clearly wants a plain HTML deliverable, a self-contained index.html, or explicitly says not to use a framework.",
    "Use framework_app_build when the user clearly wants Next.js, React, or another framework app lifecycle.",
    "Use clarify_build_format when the user clearly wants a landing page or site built but did not make the build format clear enough to choose between plain HTML and a framework app.",
    "Use build_request for concrete browser control requests like opening, reopening, or closing a tracked local browser window.",
    "Use plan_request when the user wants explanation or a plan first and does not want execution yet.",
    "Use review_feedback when the user is correcting prior work or asking the assistant to inspect something it did wrong.",
    "Use status_recall when the user asks what was created, where something was put, what is happening now, or what was left open, but not when they are asking you to open or close something now.",
    "Use relationship_recall when the user is asking about a person, relationship, or relationship status from memory/context.",
    "Use chat_answer for direct conversation, lightweight follow-ups, or ordinary Q&A that should stay conversational.",
    "If session hints show a durable return handoff, treat natural review-return questions about the saved draft, rough draft, what else is ready, or what to look at or review next as status_recall even when the wording is indirect.",
    "Use semanticHint review_ready when the user wants to see what is ready, what draft exists, or whether there is anything else worth looking over from the saved work.",
    "Use semanticHint guided_review when the user asks what to inspect, review, or look at first.",
    "Use semanticHint next_review_step when the user asks what to review next, what to look at next, or what else they should inspect from the saved work.",
    "Use semanticHint while_away_review when the user asks what happened, what changed, or what was finished while they were away, gone, or out.",
    "Use semanticHint wrap_up_summary when the user asks what you wrapped up, finished up, or completed for them from the saved work without specifically framing it as being away.",
    "Use semanticHint explain_handoff when the user wants you to walk through, explain, or summarize what you changed or wrapped up in the saved work.",
    "Use semanticHint resume_handoff when the user wants to continue, keep refining, keep going, or pick back up from the saved checkpoint instead of starting over.",
    "Use capability_discovery when the user asks what the assistant can do here, what tools or skills it knows, or why a capability is unavailable.",
    "When the request is weak or ambiguous, prefer chat_answer with low confidence instead of guessing.",
    "Examples:",
    '- "Could you take care of this end to end and leave the browser open for me later tonight?" => {"routeId":"autonomous_execution","confidence":"high"}',
    '- "Build a landing page for my desktop folder, go until you finish, then run it in a browser and leave it open for me." => {"routeId":"autonomous_execution","confidence":"high"}',
    '- With session hints showing domainDominantLane="profile" and workflowContinuityActive=false: "Could you take care of this end to end and remember that I like dark mode?" => {"routeId":"chat_answer","confidence":"low"}',
    '- With session hints showing workflowContinuityActive=true: "Take care of it end to end and leave the preview open for me." => {"routeId":"autonomous_execution","confidence":"medium"}',
    '- "Please talk me through the plan first and do not run anything yet." => {"routeId":"plan_request","confidence":"high"}',
    '- "What did you put on my desktop and what are you doing right now?" => {"routeId":"status_recall","confidence":"high"}',
    '- "Do you know Billy?" => {"routeId":"relationship_recall","confidence":"high"}',
    '- "Close the browser for our landing page." => {"routeId":"build_request","confidence":"high"}',
    '- "Open the landing page browser again so I can see it." => {"routeId":"build_request","confidence":"high"}',
    '- "Build me a single self-contained HTML landing page and put it on my desktop." => {"routeId":"static_html_build","confidence":"high"}',
    '- "Make this a plain HTML site, not Next.js or React." => {"routeId":"static_html_build","confidence":"high"}',
    '- "Create a Next.js landing page for this company." => {"routeId":"framework_app_build","confidence":"high"}',
    '- "Build me a React app for this dashboard." => {"routeId":"framework_app_build","confidence":"high"}',
    '- "Build me a landing page for this company and put it on my desktop." => {"routeId":"clarify_build_format","confidence":"medium"}',
    '- "Change the hero image to a slider on the landing page from earlier." => {"routeId":"build_request","confidence":"high"}',
    '- "Update the homepage header we were working on and keep the same preview open." => {"routeId":"build_request","confidence":"high"}',
    '- "What can you do here, and why can\'t you leave a browser open in this setup?" => {"routeId":"capability_discovery","confidence":"high"}',
    '- "You did this wrong. Look at the screenshot and fix it." => {"routeId":"review_feedback","confidence":"high"}',
    '- With session hints showing recentAssistantTurnKind="informational_answer" and recentAssistantAnswerThreadActive=true: "Okay, what else?" => {"routeId":"chat_answer","confidence":"medium"}',
    '- With session hints showing recentAssistantTurnKind="informational_answer" and recentAssistantAnswerThreadActive=true: "Tell me more." => {"routeId":"chat_answer","confidence":"medium"}',
    '- With session hints showing a durable handoff: "When I get back later, what should I inspect first from the draft you left me?" => {"routeId":"status_recall","confidence":"medium","semanticHint":"guided_review"}',
    '- With session hints showing a durable handoff: "What else is ready from that draft?" => {"routeId":"status_recall","confidence":"medium","semanticHint":"review_ready"}',
    '- With session hints showing a durable handoff: "Is there anything else in that draft I should look over?" => {"routeId":"status_recall","confidence":"medium","semanticHint":"review_ready"}',
    '- With session hints showing a durable handoff: "What should I review next from that draft?" => {"routeId":"status_recall","confidence":"medium","semanticHint":"next_review_step"}',
    '- With session hints showing a durable handoff: "What should I look at after that?" => {"routeId":"status_recall","confidence":"medium","semanticHint":"next_review_step"}',
    '- With session hints showing a durable handoff: "What did you finish while I was gone?" => {"routeId":"status_recall","confidence":"high","semanticHint":"while_away_review"}',
    '- With session hints showing a durable handoff: "What did you wrap up for me on that draft?" => {"routeId":"status_recall","confidence":"medium","semanticHint":"wrap_up_summary"}',
    '- With session hints showing a durable handoff: "Explain what you actually changed in that saved draft." => {"routeId":"status_recall","confidence":"medium","semanticHint":"explain_handoff"}',
    '- With session hints showing a durable handoff: "When you get a chance, keep refining that draft from where you left off." => {"routeId":"build_request","confidence":"medium","semanticHint":"resume_handoff"}',
    '- With session hints showing a durable handoff and autonomous continuity: "Tomorrow, keep going on that page until it is really done." => {"routeId":"autonomous_execution","confidence":"medium","semanticHint":"resume_handoff"}',
    "",
    "User request:",
    userInput,
    "",
    "Deterministic routing hint:",
    JSON.stringify(routingHint),
    "",
    "Session hints:",
    JSON.stringify(sessionHints),
    "",
    'Reply as one JSON object with keys: routeId, confidence, matchedRuleId, explanation, semanticHint.'
  ].join("\n");
}
