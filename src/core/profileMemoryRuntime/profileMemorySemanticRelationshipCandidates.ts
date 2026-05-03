/**
 * @fileoverview Converts typed semantic relationship candidates into governed fact candidates.
 */

import type { ProfileValidatedFactCandidateInput } from "./contracts";
import type { ProfileSemanticRelationshipCandidateInput } from "./contracts";
import {
  normalizeRelationshipDescriptor,
  normalizeProfileValue,
  stableContextHash
} from "./profileMemoryNormalization";
import {
  buildDisplayNameContactToken,
  buildQualifiedContactToken,
  sanitizeCapturedContactDisplayName,
  trimAssociationValue
} from "./profileMemoryContactExtractionSupport";
import {
  SEMANTIC_RELATIONSHIP_CURRENT_SOURCE,
  SEMANTIC_RELATIONSHIP_HISTORICAL_SOURCE,
  SEMANTIC_RELATIONSHIP_SEVERED_SOURCE,
  SEMANTIC_RELATIONSHIP_UNCERTAIN_SOURCE
} from "./profileMemoryTruthGovernanceSources";

const MINIMUM_SEMANTIC_RELATIONSHIP_CONFIDENCE = 0.7;

const SEMANTIC_RELATIONSHIP_DESCRIPTORS = new Set([
  "friend",
  "partner",
  "acquaintance",
  "coworker",
  "colleague",
  "work_peer",
  "manager",
  "employee",
  "neighbor",
  "roommate",
  "relative",
  "cousin",
  "son",
  "daughter",
  "parent",
  "child",
  "sibling",
  "teammate",
  "classmate"
]);

/**
 * Resolves the canonical source string for one semantic relationship lifecycle.
 *
 * @param lifecycle - Candidate lifecycle from the semantic interpreter.
 * @returns Canonical source string used by truth governance.
 */
function sourceForSemanticRelationshipLifecycle(
  lifecycle: ProfileSemanticRelationshipCandidateInput["lifecycle"]
): string {
  switch (lifecycle) {
    case "current":
      return SEMANTIC_RELATIONSHIP_CURRENT_SOURCE;
    case "historical":
      return SEMANTIC_RELATIONSHIP_HISTORICAL_SOURCE;
    case "severed":
      return SEMANTIC_RELATIONSHIP_SEVERED_SOURCE;
    case "uncertain":
      return SEMANTIC_RELATIONSHIP_UNCERTAIN_SOURCE;
  }
}

/**
 * Returns whether one semantic relationship candidate has enough typed evidence to normalize.
 *
 * @param candidate - Candidate proposed by a semantic interpreter or approved review path.
 * @returns `true` when the candidate is structurally usable.
 */
function hasRequiredSemanticRelationshipEvidence(
  candidate: ProfileSemanticRelationshipCandidateInput
): boolean {
  if (candidate.subject !== "current_user") {
    return false;
  }
  if (!candidate.evidenceSpan.text.trim()) {
    return false;
  }
  if (
    candidate.sourceFamily !== "semantic_model" &&
    candidate.sourceFamily !== "approved_review_path"
  ) {
    return false;
  }
  return (candidate.confidence ?? 0.85) >= MINIMUM_SEMANTIC_RELATIONSHIP_CONFIDENCE;
}

/**
 * Converts typed relationship candidates into the existing validated-fact input seam.
 *
 * **Why it exists:**
 * The model/semantic layer should produce typed relationship candidates with lifecycle and evidence
 * instead of relying on exact user phrases. This adapter lets those candidates flow through the
 * current governed fact path without reopening broad lexical extraction authority.
 *
 * @param candidates - Typed semantic relationship candidates.
 * @returns Validated fact candidates accepted by profile-memory ingest when policy allows them.
 */
export function buildValidatedSemanticRelationshipFactCandidates(
  candidates: readonly ProfileSemanticRelationshipCandidateInput[]
): readonly ProfileValidatedFactCandidateInput[] {
  const output: ProfileValidatedFactCandidateInput[] = [];

  for (const candidate of candidates) {
    if (!hasRequiredSemanticRelationshipEvidence(candidate)) {
      continue;
    }
    const displayName = sanitizeCapturedContactDisplayName(candidate.objectDisplayName);
    const qualifier = normalizeProfileValue(candidate.objectQualifier ?? "");
    const contactToken = qualifier
      ? buildQualifiedContactToken(displayName, qualifier)
      : buildDisplayNameContactToken(displayName);
    const relationLabel = normalizeRelationshipDescriptor(candidate.relationLabel);
    if (!contactToken || !relationLabel || !SEMANTIC_RELATIONSHIP_DESCRIPTORS.has(relationLabel)) {
      continue;
    }
    const source = sourceForSemanticRelationshipLifecycle(candidate.lifecycle);
    const confidence = candidate.confidence ?? 0.85;
    const ambiguity = candidate.ambiguity ?? (
      candidate.lifecycle === "uncertain" ? "ambiguous_relation" : "none"
    );
    const metadata = {
      subject: candidate.subject,
      objectDisplayName: displayName,
      ...(qualifier ? { objectQualifier: qualifier } : {}),
      relationLabel,
      lifecycle: candidate.lifecycle,
      sourceFamily: candidate.sourceFamily,
      ambiguity,
      evidenceSpan: {
        text: candidate.evidenceSpan.text,
        ...(typeof candidate.evidenceSpan.startOffset === "number"
          ? { startOffset: candidate.evidenceSpan.startOffset }
          : {}),
        ...(typeof candidate.evidenceSpan.endOffset === "number"
          ? { endOffset: candidate.evidenceSpan.endOffset }
          : {})
      }
    } satisfies ProfileValidatedFactCandidateInput["relationshipCandidate"];

    output.push({
      key: `contact.${contactToken}.name`,
      candidateValue: displayName,
      sensitive: candidate.sensitive === true,
      source,
      confidence,
      relationshipCandidate: metadata
    });
    output.push({
      key: `contact.${contactToken}.relationship`,
      candidateValue: relationLabel,
      sensitive: candidate.sensitive === true,
      source,
      confidence,
      relationshipCandidate: metadata
    });
    const workAssociation = normalizeProfileValue(trimAssociationValue(candidate.workAssociation ?? ""));
    if (workAssociation) {
      output.push({
        key: `contact.${contactToken}.work_association`,
        candidateValue: workAssociation,
        sensitive: candidate.sensitive === true,
        source,
        confidence,
        relationshipCandidate: metadata
      });
    }
    const contextText = normalizeProfileValue(candidate.evidenceSpan.text);
    if (contextText) {
      output.push({
        key: `contact.${contactToken}.context.${stableContextHash(contextText)}`,
        candidateValue: contextText,
        sensitive: candidate.sensitive === true,
        source,
        confidence,
        relationshipCandidate: metadata
      });
    }
  }

  return output;
}
