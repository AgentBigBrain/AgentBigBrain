/**
 * @fileoverview Shared reflection-runtime contracts, rulepack metadata, and configuration surfaces.
 */

import { DistillerMergeLedgerStore } from "../../core/distillerLedger";
import { SatelliteCloneCoordinator } from "../../core/satelliteClone";
import { TaskRunResult } from "../../core/types";

export interface ReflectionConfig {
  reflectOnSuccess: boolean;
}

export interface ReflectionDistillerDependencies {
  distillerLedgerStore: DistillerMergeLedgerStore;
  satelliteCloneCoordinator: SatelliteCloneCoordinator;
}

export type ReflectionLessonSource = "failure" | "success";
export type LessonSignalCategory = "ALLOW" | "REJECT";
export type LessonSignalConfidenceTier = "HIGH" | "MED" | "LOW";
export type LessonSignalBlockReason =
  | "LESSON_TOO_SHORT"
  | "LOW_SIGNAL_PATTERN"
  | "NO_SUBSTANTIVE_SIGNAL_TOKEN"
  | "INSUFFICIENT_GOAL_OVERLAP"
  | "NEAR_DUPLICATE";

export interface LessonSignalClassificationContext {
  runResult: TaskRunResult;
  source: ReflectionLessonSource;
  existingLessons: readonly string[];
}

export interface LessonSignalScores {
  tokenCount: number;
  goalOverlap: number;
  operationalOverlap: number;
  maxSimilarity: number;
}

export interface LessonSignalClassification {
  allowPersist: boolean;
  category: LessonSignalCategory;
  confidenceTier: LessonSignalConfidenceTier;
  matchedRuleId: string;
  rulepackVersion: string;
  blockReason: LessonSignalBlockReason | null;
  scores: LessonSignalScores;
}

/**
 * Frozen deterministic baseline rulepack for reflection lesson quality gating.
 */
export const LessonSignalRulepackV1 = Object.freeze({
  version: "LessonSignalRulepackV1",
  minLessonLength: 24,
  minTokenLength: 3,
  lessonSimilarityThreshold: 0.5,
  minSuccessGoalOverlap: 2,
  minFailureGoalOverlap: 1,
  minOperationalOverlap: 1,
  stopWords: [
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "your",
    "their",
    "user",
    "users",
    "request",
    "requests",
    "task",
    "tasks",
    "action",
    "actions",
    "ensure",
    "ensures",
    "using",
    "before",
    "after",
    "while",
    "when",
    "where",
    "what",
    "which",
    "through"
  ],
  genericReflectionTokens: [
    "clarify",
    "clarifying",
    "clarification",
    "context",
    "contextual",
    "communication",
    "thorough",
    "requirement",
    "requirements",
    "effective",
    "efficient",
    "efficiency",
    "precise",
    "relevant",
    "successful",
    "successfully",
    "success",
    "smooth",
    "smoothly",
    "interaction",
    "interactions",
    "response",
    "responses",
    "align",
    "alignment",
    "understanding",
    "upfront",
    "proceed",
    "proceeding",
    "helpful",
    "better"
  ],
  lowSignalLessonPatterns: [
    /\bprioritizing user engagement\b/i,
    /\bfriendly greeting\b/i,
    /\benhances the overall user experience\b/i,
    /\bclarifying user requests\b/i,
    /\bfosters trust and efficiency\b/i,
    /\baccurate understanding and effective responses\b/i,
    /\bclarif(?:y|ying)\b.*\b(requirements?|requests?|needs?)\b/i,
    /\bprioritizing clear(?: and concise)? communication\b/i,
    /\bthorough(?:ly)? understanding(?: of)? (?:the )?user context\b/i,
    /\bprecise and relevant response\b/i,
    /\b(?:localhost|127\.0\.0\.1|loopback|private[-\s]?range)\b.*\b(?:blocked|denied|policy|policies|ethics|security)\b/i
  ],
  highSignalKeywords: [
    "sandbox",
    "constraint",
    "constraints",
    "governor",
    "governance",
    "approval",
    "validate",
    "validation",
    "policy",
    "blocked",
    "rollback",
    "schema",
    "budget",
    "trace",
    "receipt",
    "delete",
    "create",
    "skill",
    "path",
    "paths",
    "impersonation",
    "personal",
    "data",
    "security"
  ]
} as const);

export const DEFAULT_REFLECTION_CONFIG: ReflectionConfig = {
  reflectOnSuccess: false
};
