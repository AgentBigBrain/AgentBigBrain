/**
 * @fileoverview Stable compatibility entrypoint for the canonical Stage 6.86 entity-graph subsystem.
 */

export {
  applyEntityExtractionToGraph,
  buildEntityKey,
  computeCoMentionIncrement,
  createEmptyEntityGraphV1,
  extractEntityCandidates,
  getEntityLookupTerms,
  pruneLowSignalEntitiesFromGraph,
  queryEntityGraphNodesByCanonicalOrAlias,
  promoteRelationEdgeWithConfirmation,
  type Stage686AliasConflict,
  type Stage686EntityExtractionInput,
  type Stage686EntityExtractionResult,
  type Stage686EntityDomainHint,
  type Stage686EntityGraphMutationOptions,
  type Stage686EntityGraphMutationResult,
  type Stage686EntityGraphPruneResult,
  type Stage686EntityTypeHint,
  type Stage686RelationPromotionInput,
  type Stage686RelationPromotionResult
} from "./stage6_86/entityGraph";
export {
  applyEntityAliasCandidateToGraph,
  validateEntityAliasCandidateValue,
  type Stage686EntityAliasCandidateInput,
  type Stage686EntityAliasMutationOptions,
  type Stage686EntityAliasMutationResult
} from "./stage6_86/entityGraphAliasReconciliation";
