/**
 * @fileoverview Shared deterministic contracts for non-safety language tokenization and ranking.
 */

export type LanguageProfileId = "generic_en" | "generic_es";

export type LanguageTokenDomain =
  | "conversation_topic"
  | "contextual_recall"
  | "planning_query"
  | "episode_planning_query"
  | "episode_linking"
  | "semantic_concepts";

export interface TokenizationRequest {
  text: string;
  domain: LanguageTokenDomain;
  profileId?: LanguageProfileId;
  minTokenLength?: number;
  maxTokens?: number;
}
