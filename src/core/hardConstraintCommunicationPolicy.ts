/**
 * @fileoverview Deterministic communication-safety signal classifiers used by hard constraints.
 */

import {
  getBooleanParam,
  getStringParam,
  safeStringify
} from "./hardConstraintParamUtils";
import { GovernanceProposal } from "./types";

const IMPERSONATION_PATTERNS = [
  "impersonat",
  "pretend to be",
  "pose as",
  "roleplay as",
  "simulate being",
  "mimic a human",
  "speak for",
  "represent as",
  "act as if you are",
  "on behalf of ",
  "i am a human",
  "i'm a human",
  "this is the user",
  "i am the owner",
  "i'm the owner",
  "as a human",
  "i am your husband",
  "i am your wife"
];
const PERSONAL_DATA_PATTERNS = [
  "home address",
  "residence address",
  "residence coordinates",
  "phone number",
  "cell number",
  "email address",
  "social security",
  "ssn",
  "date of birth",
  "dob",
  "passport number",
  "driver license",
  "government id",
  "geo location",
  "geolocation",
  "gps coordinate",
  "residential location",
  "personal info",
  "private info",
  "location data"
];
const PERSONAL_DATA_DISCLOSURE_STEMS = [
  "share",
  "send",
  "reveal",
  "disclos",
  "provide",
  "expos",
  "leak",
  "publish",
  "transmit",
  "forward",
  "post"
];
const PERSONAL_DATA_REQUEST_STEMS = [
  "tell",
  "give",
  "show",
  "what",
  "where",
  "lookup",
  "find",
  "retriev",
  "return",
  "report",
  "list"
];
const IMPERSONATION_VERB_STEMS = [
  "impersonat",
  "pretend",
  "pose",
  "roleplay",
  "simulate",
  "mimic",
  "masquerad",
  "represent",
  "pass"
];
const HUMAN_IDENTITY_STEMS = [
  "human",
  "person",
  "owner",
  "user",
  "customer",
  "individual",
  "real"
];
const FIRST_PERSON_NAMED_IDENTITY_REGEX =
  /\b(?:[Ii]\s+am|[Ii]'m|[Tt]his\s+is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)(?=$|[.!?,;:])/g;
const NON_NAME_IDENTITY_TOKENS = new Set([
  "human",
  "person",
  "owner",
  "user",
  "customer",
  "individual",
  "real",
  "agent",
  "assistant",
  "bot",
  "model",
  "system",
  "ai"
]);
const AGENT_IDENTITY_HINT_STEMS = ["agent", "assistant", "bot", "model", "system", "ai", "llm"];
const RELAY_STEMS = ["behalf", "speak", "for", "as"];
const PROFILE_RECALL_CONTEXT_STEMS = [
  "profile",
  "memory",
  "recall",
  "rememb",
  "stored fact",
  "known fact",
  "profile fact",
  "user data",
  "who am i",
  "what is my",
  "where do i work",
  "my name",
  "about the user",
  "about you"
];
const PERSONAL_DATA_STEMS = [
  "address",
  "phone",
  "telephon",
  "email",
  "mail",
  "social",
  "security",
  "ssn",
  "birth",
  "dob",
  "passport",
  "license",
  "location",
  "geolocat",
  "coordinate",
  "residen",
  "contact"
];
const PERSONAL_DATA_CLASSIFICATIONS = ["pii", "private", "sensitive", "confidential"];

/**
 * Stems whose presence indicate the text is about software/code generation,
 * not actual PII disclosure. Used to raise the semantic PII threshold so
 * building a "Contact page with an email field" is not treated as sharing
 * someone's personal data.
 */
const CODE_GENERATION_CONTEXT_STEMS = [
  "component",
  "react",
  "tsx",
  "jsx",
  "html",
  "css",
  "div",
  "npm",
  "webpack",
  "vite",
  "import",
  "export",
  "render",
  "tailwind",
  "scss",
  "layout",
  "grid",
  "flexbox",
  "scaffold",
  "template",
  "boilerplate",
  "typescript",
  "javascript",
  "frontend",
  "backend",
  "dashboard",
  "sidebar",
  "navbar",
  "modal",
  "widget",
  "router",
  "route",
  "page",
  "view",
  "app",
  "src",
  "build",
  "deploy",
  "create-react-app"
] as const;

/**
 * Exact patterns from PERSONAL_DATA_PATTERNS that are highly ambiguous in
 * software-generation contexts (for example "email address input field").
 * These are skipped when code-generation context is detected; high-confidence
 * patterns (SSN, passport, government ID, etc.) are still enforced.
 */
const AMBIGUOUS_PII_PATTERNS_IN_CODE_CONTEXT: readonly string[] = [
  "email address",
  "phone number",
  "cell number",
  "personal info",
  "private info",
  "location data"
];
const PERSONAL_DATA_RECIPIENT_HINT_KEYS = [
  "recipient",
  "recipientId",
  "recipientName",
  "audience",
  "destination",
  "destinationAgentId",
  "targetUserId",
  "targetConversationId",
  "endpoint",
  "channel",
  "conversationId"
];

/**
 * Checks whether text contains any substring from a pattern allow/deny list.
 *
 * **Why it exists:**
 * Multiple communication checks rely on lightweight lexical phrase matching; this helper avoids
 * repeating normalization and loop logic.
 *
 * **What it talks to:**
 * - Local lowercase normalization only.
 *
 * @param text - Source text to inspect.
 * @param patterns - Phrase fragments that signal a match.
 * @returns `true` when at least one pattern is present in the text.
 */
function containsAnyPattern(text: string, patterns: readonly string[]): boolean {
  const normalized = text.toLowerCase();
  return patterns.some((pattern) => normalized.includes(pattern));
}

/**
 * Detects first-person claims that introduce a specific proper-name identity.
 *
 * **Why it exists:**
 * Hard constraints should block named human-identity claims without hardcoding any specific person.
 * This detector keeps that coverage deterministic while staying identity-agnostic.
 *
 * **What it talks to:**
 * - Reads `FIRST_PERSON_NAMED_IDENTITY_REGEX`, `NON_NAME_IDENTITY_TOKENS`, and
 *   `AGENT_IDENTITY_HINT_STEMS`.
 *
 * @param text - Candidate communication text from rationale/description/params.
 * @returns `true` when a first-person named identity claim is detected.
 */
function containsNamedHumanIdentityClaim(text: string): boolean {
  for (const match of text.matchAll(FIRST_PERSON_NAMED_IDENTITY_REGEX)) {
    const claimedIdentity = match[1];
    if (!claimedIdentity) {
      continue;
    }
    const identityTokens = claimedIdentity.toLowerCase().split(/\s+/).filter(Boolean);
    if (identityTokens.length === 0) {
      continue;
    }
    const hasAgentIdentityHint = identityTokens.some((token) =>
      AGENT_IDENTITY_HINT_STEMS.some((stem) => token.startsWith(stem))
    );
    if (hasAgentIdentityHint) {
      continue;
    }
    const hasNameToken = identityTokens.some((token) => !NON_NAME_IDENTITY_TOKENS.has(token));
    if (hasNameToken) {
      return true;
    }
  }
  return false;
}

/**
 * Produces a lightweight lexical stem for a token.
 *
 * **Why it exists:**
 * Semantic impersonation/personal-data checks use prefix matching. A tiny deterministic stemmer
 * improves recall across inflections without external NLP dependencies.
 *
 * **What it talks to:**
 * - Local regex transforms only.
 *
 * @param token - Token value used for lexical parsing or matching.
 * @returns Lowercased alphanumeric stem with simple suffix trimming.
 */
function stemToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/(ing|ed|es|s)$/i, "");
}

/**
 * Tokenizes text into normalized stems for semantic prefix matching.
 *
 * **Why it exists:**
 * Impersonation/personal-data semantic checks need one deterministic tokenization path.
 *
 * **What it talks to:**
 * - Calls `stemToken`.
 *
 * @param text - Free-form text extracted from proposal rationale/description/params.
 * @returns Non-empty stem list derived from the input text.
 */
function tokenizeForSemanticMatching(text: string): string[] {
  return text
    .split(/[^a-zA-Z0-9]+/)
    .map((token) => stemToken(token))
    .filter((token) => token.length > 0);
}

/**
 * Checks whether any token begins with one of the supplied lexical stems.
 *
 * **Why it exists:**
 * Stem-based policy checks (`impersonat`, `disclos`, etc.) should use one matcher.
 *
 * **What it talks to:**
 * - Local token/prefix iteration only.
 *
 * @param tokens - Pre-tokenized/stemmed terms.
 * @param prefixes - Stem prefixes to test for.
 * @returns `true` when at least one token matches one of the prefixes.
 */
function containsStemPrefix(tokens: string[], prefixes: readonly string[]): boolean {
  return tokens.some((token) => prefixes.some((prefix) => token.startsWith(prefix)));
}

/**
 * Counts distinct stem prefixes matched by the provided token list.
 *
 * **Why it exists:**
 * Some detectors require a minimum number of distinct lexical cues, not just one hit.
 *
 * **What it talks to:**
 * - Local set accumulation only.
 *
 * @param tokens - Pre-tokenized/stemmed terms.
 * @param prefixes - Stem prefixes considered relevant for the check.
 * @returns Count of unique prefixes that appear in at least one token.
 */
function countStemPrefixMatches(tokens: string[], prefixes: readonly string[]): number {
  const matched = new Set<string>();
  for (const token of tokens) {
    for (const prefix of prefixes) {
      if (token.startsWith(prefix)) {
        matched.add(prefix);
      }
    }
  }
  return matched.size;
}

/**
 * Detects semantic impersonation cues that may not match literal phrase rules.
 *
 * **Why it exists:**
 * Attack prompts often paraphrase impersonation requests. This detector combines stemmed verbs,
 * human-identity stems, and relay phrasing to catch those variants deterministically.
 *
 * **What it talks to:**
 * - Calls `tokenizeForSemanticMatching`.
 * - Calls `containsStemPrefix`.
 *
 * @param text - Candidate communication text from action payloads.
 * @returns `true` when impersonation semantics are detected.
 */
function containsSemanticImpersonationSignal(text: string): boolean {
  const tokens = tokenizeForSemanticMatching(text);
  const hasImpersonationVerb = containsStemPrefix(tokens, IMPERSONATION_VERB_STEMS);
  const hasHumanIdentityTarget = containsStemPrefix(tokens, HUMAN_IDENTITY_STEMS);
  const hasRelayPattern = RELAY_STEMS.every((stem) => tokens.includes(stem));
  return (hasImpersonationVerb && hasHumanIdentityTarget) || hasRelayPattern;
}

/**
 * Returns `true` when text indicates profile-fact recall rather than impersonation.
 *
 * **Why it exists:**
 * Avoids false-positive impersonation blocks for prompts that explicitly reference stored user facts.
 *
 * **What it talks to:**
 * - Reads `PROFILE_RECALL_CONTEXT_STEMS`.
 *
 * @param text - Candidate communication text.
 * @returns `true` when at least two profile-recall stems are present.
 */
function containsProfileRecallContext(text: string): boolean {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const stem of PROFILE_RECALL_CONTEXT_STEMS) {
    if (lower.includes(stem)) {
      hits += 1;
      if (hits >= 2) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Returns `true` when text contains enough software-generation vocabulary.
 *
 * **Why it exists:**
 * Personal-data semantic checks raise their threshold in software-generation contexts to reduce
 * false positives (for example "email field" inside UI code scaffolding requests).
 *
 * **What it talks to:**
 * - Reads `CODE_GENERATION_CONTEXT_STEMS`.
 *
 * @param text - Candidate communication text.
 * @returns `true` when at least three code-generation stems are present.
 */
function containsCodeGenerationContext(text: string): boolean {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const stem of CODE_GENERATION_CONTEXT_STEMS) {
    if (lower.includes(stem)) {
      hits += 1;
      if (hits >= 3) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Semantic PII signal detector using deterministic lexical thresholds.
 *
 * **Why it exists:**
 * Captures paraphrased PII request/disclosure signals beyond exact phrase matching while avoiding
 * overblocking code-generation prompts.
 *
 * **What it talks to:**
 * - Calls `tokenizeForSemanticMatching`, `countStemPrefixMatches`, and `containsStemPrefix`.
 * - Calls `containsCodeGenerationContext` to choose threshold.
 *
 * @param text - Candidate communication text.
 * @returns `true` when PII identifier and disclosure/request signals are both present.
 */
function containsSemanticPersonalDataSignal(text: string): boolean {
  const tokens = tokenizeForSemanticMatching(text);
  const personalDataStemMatchCount = countStemPrefixMatches(tokens, PERSONAL_DATA_STEMS);
  const threshold = containsCodeGenerationContext(text) ? 4 : 2;
  const hasPersonalDataIdentifier = personalDataStemMatchCount >= threshold;
  const hasDisclosureSignal =
    containsStemPrefix(tokens, PERSONAL_DATA_DISCLOSURE_STEMS) ||
    containsStemPrefix(tokens, PERSONAL_DATA_REQUEST_STEMS);
  return hasPersonalDataIdentifier && hasDisclosureSignal;
}

/**
 * Recursively detects sensitive-data hints in object keys and nested structures.
 *
 * **Why it exists:**
 * Personal-data requests often appear in key names (`recipientEmail`, `home_address`, etc.), not
 * just free text values.
 *
 * **What it talks to:**
 * - Calls `containsSemanticPersonalDataSignal` on object keys.
 * - Recurses through nested objects/arrays.
 *
 * @param input - Arbitrary structured payload to scan.
 * @returns `true` when a sensitive key hint is detected at any depth.
 */
function containsSensitiveKeyHints(input: unknown): boolean {
  if (Array.isArray(input)) {
    return input.some((item) => containsSensitiveKeyHints(item));
  }

  if (typeof input !== "object" || input === null) {
    return false;
  }

  const record = input as Record<string, unknown>;
  return Object.entries(record).some(([key, value]) => {
    if (containsSemanticPersonalDataSignal(key)) {
      return true;
    }
    return containsSensitiveKeyHints(value);
  });
}

/**
 * Checks whether action params explicitly label payload as sensitive/private data.
 *
 * **Why it exists:**
 * Some communication actions include declared classifications (`dataClassification`) that should
 * trigger approval gating even when lexical signals are weak.
 *
 * **What it talks to:**
 * - Calls `getStringParam`.
 * - Reads `PERSONAL_DATA_CLASSIFICATIONS`.
 *
 * @param params - Action parameter bag.
 * @returns `true` when `dataClassification` matches a sensitive classification value.
 */
function containsSensitiveClassificationHint(params: Record<string, unknown>): boolean {
  const classification = getStringParam(params, "dataClassification");
  if (!classification) {
    return false;
  }
  const normalized = classification.trim().toLowerCase();
  return PERSONAL_DATA_CLASSIFICATIONS.includes(normalized);
}

/**
 * Checks whether recipient hint fields are present in params.
 *
 * **Why it exists:**
 * Recipient/destination fields strengthen confidence that the action intends external data sharing.
 *
 * **What it talks to:**
 * - Reads `PERSONAL_DATA_RECIPIENT_HINT_KEYS`.
 *
 * @param params - Action parameter bag.
 * @returns `true` when at least one recipient-like field is populated.
 */
function containsRecipientHint(params: Record<string, unknown>): boolean {
  return PERSONAL_DATA_RECIPIENT_HINT_KEYS.some((key) => {
    const value = params[key];
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    return typeof value === "number";
  });
}

/**
 * Identifies proposals that produce outbound communication.
 *
 * **Why it exists:**
 * Identity and personal-data controls only apply to communication actions.
 *
 * **What it talks to:**
 * - Reads `proposal.action.type`.
 *
 * @param proposal - Governance proposal under evaluation.
 * @returns `true` for `respond` or `network_write` actions.
 */
export function isCommunicationAction(proposal: GovernanceProposal): boolean {
  return proposal.action.type === "respond" || proposal.action.type === "network_write";
}

/**
 * Detects impersonation signals in a communication proposal.
 *
 * **Why it exists:**
 * Identity safety must block both explicit flags (`impersonateHuman`) and paraphrased textual
 * attempts to claim human identity.
 *
 * **What it talks to:**
 * - Calls `getBooleanParam`, `getStringParam`, and `safeStringify`.
 * - Calls `containsAnyPattern`, `containsProfileRecallContext`, and
 *   `containsSemanticImpersonationSignal`.
 *
 * @param proposal - Communication proposal being scanned for impersonation behavior.
 * @returns `true` when impersonation intent/signal is detected.
 */
export function containsImpersonationSignal(proposal: GovernanceProposal): boolean {
  const params = proposal.action.params;
  if (getBooleanParam(params, "impersonateHuman")) {
    return true;
  }

  const declaredIdentity = getStringParam(params, "actorIdentity");
  if (declaredIdentity && declaredIdentity.trim().toLowerCase() !== "agent") {
    return true;
  }

  const speakerRole = getStringParam(params, "speakerRole");
  if (
    speakerRole &&
    ["human", "person", "owner", "user"].includes(speakerRole.trim().toLowerCase())
  ) {
    return true;
  }

  const textSignal = [
    proposal.rationale,
    proposal.action.description,
    safeStringify(proposal.action.params)
  ].join("\n");

  if (containsAnyPattern(textSignal, IMPERSONATION_PATTERNS)) {
    return true;
  }

  if (containsNamedHumanIdentityClaim(textSignal)) {
    return true;
  }

  if (containsProfileRecallContext(textSignal)) {
    return false;
  }

  return containsSemanticImpersonationSignal(textSignal);
}

/**
 * Detects personal-data disclosure signals in a communication proposal.
 *
 * **Why it exists:**
 * Privacy policy blocks outbound personal-data sharing unless explicit human approval exists.
 *
 * **What it talks to:**
 * - Calls sensitive-key/classification helpers and semantic PII detectors.
 * - Applies code-generation context suppression rules to reduce false positives.
 * - Reads recipient hint fields for request/disclosure intent.
 *
 * @param proposal - Communication proposal being scanned for personal-data disclosure.
 * @returns `true` when personal-data sharing/request patterns are detected.
 */
export function containsPersonalDataSignal(proposal: GovernanceProposal): boolean {
  const params = proposal.action.params;
  if (getBooleanParam(params, "sharePersonalData")) {
    return true;
  }
  if (containsSensitiveClassificationHint(params)) {
    return true;
  }
  if (containsSensitiveKeyHints(params)) {
    return true;
  }

  const textSignal = [
    proposal.rationale,
    proposal.action.description,
    safeStringify(proposal.action.params)
  ].join("\n");

  const isCodeGen = containsCodeGenerationContext(textSignal);
  if (isCodeGen) {
    const highConfidencePatterns = PERSONAL_DATA_PATTERNS.filter(
      (pattern) => !AMBIGUOUS_PII_PATTERNS_IN_CODE_CONTEXT.includes(pattern)
    );
    if (containsAnyPattern(textSignal, highConfidencePatterns)) {
      return true;
    }
  } else if (containsAnyPattern(textSignal, PERSONAL_DATA_PATTERNS)) {
    return true;
  }

  if (containsSemanticPersonalDataSignal(textSignal)) {
    return true;
  }

  if (containsRecipientHint(params)) {
    const tokens = tokenizeForSemanticMatching(textSignal);
    const hasPersonalDataIdentifier = containsStemPrefix(tokens, PERSONAL_DATA_STEMS);
    const hasDisclosureSignal =
      containsStemPrefix(tokens, PERSONAL_DATA_DISCLOSURE_STEMS) ||
      containsStemPrefix(tokens, PERSONAL_DATA_REQUEST_STEMS);
    return hasPersonalDataIdentifier && hasDisclosureSignal;
  }

  return false;
}

/**
 * Validates explicit human approval markers on a proposal.
 *
 * **Why it exists:**
 * Personal-data communication is allowed only with affirmative approval metadata and a non-empty
 * approval id.
 *
 * **What it talks to:**
 * - Calls `getBooleanParam` and `getStringParam` on proposal params.
 *
 * @param proposal - Governance proposal carrying optional approval metadata.
 * @returns `true` when explicit approval is present and properly formed.
 */
export function hasExplicitHumanApproval(proposal: GovernanceProposal): boolean {
  const params = proposal.action.params;
  const approved = getBooleanParam(params, "explicitHumanApproval");
  const approvalId = getStringParam(params, "approvalId");
  return approved && typeof approvalId === "string" && approvalId.trim().length > 0;
}
