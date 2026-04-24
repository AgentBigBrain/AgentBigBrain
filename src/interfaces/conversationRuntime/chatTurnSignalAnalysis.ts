/** @fileoverview Structural turn-feature analysis for conversational routing surfaces. */
import {
  normalizeLanguageToken,
  tokenizeLanguageTerms
} from "../../core/languageRuntime/tokenization";
import {
  ARTIFACT_CUE_TERMS,
  ASSISTANT_REFERENCE_TERMS,
  CHAT_FILLER_TERMS,
  EXPLICIT_ARTIFACT_PATTERN,
  FOLLOW_UP_DECISION_TERMS,
  IDENTITY_GRAMMAR_TERMS,
  NAME_CONCEPT_TERMS,
  QUESTION_LEAD_TERMS,
  QUESTION_MARK_PATTERN,
  RELATIONSHIP_CUE_PATTERNS,
  RELATIONSHIP_CUE_TERMS,
  SELF_REFERENCE_TERMS,
  STATUS_CUE_TERMS,
  WORKFLOW_CUE_TERMS
} from "./chatTurnSignalLexicon";
import {
  hasDirectSelfIdentityQuestionShape,
  hasExplicitSelfIdentityDeclarationShape,
  hasSelfIdentityMetaQuestionShape,
  hasSelfIdentityRecallAssertionShape,
  hasWorkflowCallbackRequestShape
} from "./chatTurnSignalShapes";

const RAW_TOKEN_PATTERN = /[\p{L}\p{N}]+(?:['.-][\p{L}\p{N}]+)*/gu;

export type ConversationTurnKind =
  | "plain_chat"
  | "self_identity_query"
  | "self_identity_statement"
  | "assistant_identity_query"
  | "status_or_recall"
  | "workflow_candidate"
  | "approval_or_control";
export type ConversationTurnActionability = "none" | "recall_only" | "workflow_candidate";

export interface ConversationChatTurnSignals {
  rawTokenCount: number;
  meaningfulTerms: readonly string[];
  questionLike: boolean;
  primaryKind: ConversationTurnKind;
  actionability: ConversationTurnActionability;
  lightweightConversation: boolean;
  interpersonalConversation: boolean;
  referencesSelf: boolean;
  referencesAssistant: boolean;
  containsNameConcept: boolean;
  referencesArtifact: boolean;
  containsWorkflowCue: boolean;
  containsWorkflowCallbackCue: boolean;
  containsStatusCue: boolean;
  containsApprovalCue: boolean;
  containsRelationshipCue: boolean;
}

/**
 * Collapses repeated whitespace into one stable text shape for structural turn analysis.
 *
 * **Why it exists:**
 * Keeps tokenization and cue extraction aligned without forcing every consumer to reimplement
 * whitespace normalization.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Raw input text.
 * @returns Trimmed text with repeated whitespace collapsed.
 */
export function normalizeConversationChatTurnWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Collects bounded meaningful terms across the supported generic language profiles.
 *
 * **Why it exists:**
 * Structural conversational analysis needs content-bearing terms, but it should stay aligned with
 * the shared language-runtime tokenization policy instead of drifting into local stop-word lists.
 *
 * **What it talks to:**
 * - Uses `tokenizeLanguageTerms` (import `tokenizeLanguageTerms`) from `../../core/languageRuntime/tokenization`.
 *
 * @param userInput - Raw current user wording.
 * @returns Deduplicated normalized terms that survive stop-word filtering.
 */
function collectMeaningfulTerms(userInput: string): readonly string[] {
  const combined = new Set<string>();
  for (const profileId of ["generic_en", "generic_es"] as const) {
    for (const domain of ["conversation_topic", "contextual_recall"] as const) {
      const terms = tokenizeLanguageTerms({
        text: userInput,
        domain,
        profileId,
        minTokenLength: 2,
        maxTokens: 8
      });
      for (const term of terms) {
        combined.add(term);
      }
    }
  }
  return [...combined];
}

/**
 * Tokenizes raw user input into normalized surface tokens for bounded structural checks.
 *
 * **Why it exists:**
 * The routing layer needs surface-token order for short-turn grammar checks, but that should stay
 * centralized so identity and follow-up helpers evaluate the same token stream.
 *
 * **What it talks to:**
 * - Uses `normalizeLanguageToken` (import `normalizeLanguageToken`) from `../../core/languageRuntime/tokenization`.
 * - Uses local constants/helpers within this module.
 *
 * @param userInput - Raw current user wording.
 * @returns Stable normalized token sequence.
 */
export function collectConversationChatTurnRawTokens(
  userInput: string
): readonly string[] {
  const matches = userInput.match(RAW_TOKEN_PATTERN) ?? [];
  return matches.map((token) => normalizeLanguageToken(token));
}

/**
 * Returns whether any raw or meaningful token matches one of the provided cue terms.
 *
 * **Why it exists:**
 * Structural cue checks should stay uniform across workflow, status, approval, and identity
 * feature extraction instead of each call site hand-rolling token scans.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param rawTokens - Surface token sequence.
 * @param meaningfulTerms - Stop-word filtered content terms.
 * @param cues - Candidate cue term set.
 * @returns `true` when any cue is present.
 */
function hasCue(
  rawTokens: readonly string[],
  meaningfulTerms: readonly string[],
  cues: ReadonlySet<string>
): boolean {
  return (
    rawTokens.some((token) => cues.has(token)) ||
    meaningfulTerms.some((term) => cues.has(term))
  );
}

/**
 * Returns structural signals for one conversational turn without relying on a growing phrase list.
 *
 * **Why it exists:**
 * Routing and direct-conversation safeguards need a shared bounded feature extractor so they can
 * reason about greetings, identity, workflow, and status cues from the same evidence.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * - Uses `normalizeLanguageToken` and `tokenizeLanguageTerms` from `../../core/languageRuntime/tokenization`.
 *
 * @param userInput - Raw current user wording.
 * @returns Stable structural turn features for routing safeguards.
 */
export function analyzeConversationChatTurnSignals(
  userInput: string
): ConversationChatTurnSignals {
  const normalized = normalizeConversationChatTurnWhitespace(userInput);
  const rawTokens = collectConversationChatTurnRawTokens(normalized);
  const meaningfulTerms = collectMeaningfulTerms(normalized);
  const containsQuestionLead = rawTokens.some((token) => QUESTION_LEAD_TERMS.has(token));
  const questionLike =
    QUESTION_MARK_PATTERN.test(normalized) ||
    containsQuestionLead;
  const referencesSelf = hasCue(rawTokens, meaningfulTerms, SELF_REFERENCE_TERMS);
  const referencesAssistant = hasCue(
    rawTokens,
    meaningfulTerms,
    ASSISTANT_REFERENCE_TERMS
  );
  const containsNameConcept = hasCue(
    rawTokens,
    meaningfulTerms,
    NAME_CONCEPT_TERMS
  );
  const referencesArtifact =
    EXPLICIT_ARTIFACT_PATTERN.test(normalized) ||
    hasCue(rawTokens, meaningfulTerms, ARTIFACT_CUE_TERMS);
  const containsWorkflowCue = hasCue(
    rawTokens,
    meaningfulTerms,
    WORKFLOW_CUE_TERMS
  );
  const containsStatusCue = hasCue(rawTokens, meaningfulTerms, STATUS_CUE_TERMS);
  const containsWorkflowCallbackCue = hasWorkflowCallbackRequestShape(
    rawTokens,
    containsWorkflowCue,
    containsStatusCue,
    referencesArtifact
  );
  const containsApprovalCue = hasCue(
    rawTokens,
    meaningfulTerms,
    FOLLOW_UP_DECISION_TERMS
  );
  const containsRelationshipCue = hasCue(
    rawTokens,
    meaningfulTerms,
    RELATIONSHIP_CUE_TERMS
  ) || RELATIONSHIP_CUE_PATTERNS.some((pattern) => pattern.test(normalized));
  const nonIdentityMeaningfulTerms = meaningfulTerms.filter(
    (term) => !IDENTITY_GRAMMAR_TERMS.has(term) && !CHAT_FILLER_TERMS.has(term)
  );
  const identityGrammarOnly = nonIdentityMeaningfulTerms.length === 0;
  const selfIdentityStatement =
    hasExplicitSelfIdentityDeclarationShape(rawTokens) &&
    !questionLike &&
    !referencesArtifact &&
    !containsWorkflowCue &&
    !containsStatusCue &&
    referencesSelf &&
    containsNameConcept;
  const selfIdentityQuery =
    !referencesArtifact &&
    !containsWorkflowCue &&
    !containsStatusCue &&
    referencesSelf &&
    (
      hasDirectSelfIdentityQuestionShape(
        rawTokens,
        referencesSelf,
        referencesAssistant,
        containsNameConcept,
        referencesArtifact,
        containsWorkflowCue,
        containsStatusCue
      ) ||
      (
        questionLike &&
        !hasSelfIdentityMetaQuestionShape(
          rawTokens,
          referencesSelf,
          referencesAssistant,
          containsNameConcept
        ) &&
        (containsNameConcept || nonIdentityMeaningfulTerms.length === 0)
      ) ||
      hasSelfIdentityRecallAssertionShape(
        rawTokens,
        meaningfulTerms,
        referencesSelf,
        referencesAssistant,
        containsNameConcept,
        referencesArtifact,
        containsWorkflowCue,
        containsStatusCue
      )
    );
  const assistantIdentityQuery =
    questionLike &&
    referencesAssistant &&
    !containsStatusCue &&
    !containsWorkflowCue &&
    !referencesArtifact &&
    !hasSelfIdentityMetaQuestionShape(
      rawTokens,
      referencesSelf,
      referencesAssistant,
      containsNameConcept
    ) &&
    (containsNameConcept || identityGrammarOnly);
  const lightweightConversation =
    rawTokens.length > 0 &&
    rawTokens.length <= 3 &&
    nonIdentityMeaningfulTerms.length <= 1 &&
    !referencesArtifact &&
    !containsWorkflowCue &&
    !containsStatusCue &&
    !selfIdentityQuery &&
    !assistantIdentityQuery &&
    !containsApprovalCue;

  let primaryKind: ConversationTurnKind = "plain_chat";
  if (selfIdentityStatement) {
    primaryKind = "self_identity_statement";
  } else if (selfIdentityQuery) {
    primaryKind = "self_identity_query";
  } else if (assistantIdentityQuery) {
    primaryKind = "assistant_identity_query";
  } else if (containsApprovalCue) {
    primaryKind = "approval_or_control";
  } else if (
    containsWorkflowCue ||
    containsWorkflowCallbackCue ||
    (referencesArtifact && meaningfulTerms.length > 0)
  ) {
    primaryKind = "workflow_candidate";
  } else if (containsStatusCue) {
    primaryKind = "status_or_recall";
  }

  let actionability: ConversationTurnActionability = "none";
  if (primaryKind === "workflow_candidate" || primaryKind === "approval_or_control") {
    actionability = "workflow_candidate";
  } else if (primaryKind === "status_or_recall") {
    actionability = "recall_only";
  }
  const interpersonalConversation =
    primaryKind === "plain_chat" &&
    rawTokens.length > 0 &&
    rawTokens.length <= 8 &&
    !referencesArtifact &&
    !containsWorkflowCue &&
    !containsWorkflowCallbackCue &&
    !containsStatusCue &&
    !containsApprovalCue &&
    (referencesSelf || referencesAssistant);

  return {
    rawTokenCount: rawTokens.length,
    meaningfulTerms,
    questionLike,
    primaryKind,
    actionability,
    lightweightConversation,
    interpersonalConversation,
    referencesSelf,
    referencesAssistant,
    containsNameConcept,
    referencesArtifact,
    containsWorkflowCue,
    containsWorkflowCallbackCue,
    containsStatusCue,
    containsApprovalCue,
    containsRelationshipCue
  };
}
