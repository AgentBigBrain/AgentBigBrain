/**
 * @fileoverview Tests deterministic main-agent identity normalization and satellite-clone naming behavior.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { allocateCloneAgentId, MAIN_AGENT_ID, normalizeAgentId } from "../../src/core/agentIdentity";

/**
 * Implements `allocatesFirstCloneNameFromDefaultPrefix` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function allocatesFirstCloneNameFromDefaultPrefix(): void {
  const allocated = allocateCloneAgentId([]);
  assert.equal(allocated, "atlas-1");
}

/**
 * Implements `balancesCloneNamingAcrossPrefixes` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function balancesCloneNamingAcrossPrefixes(): void {
  const allocated = allocateCloneAgentId(["atlas-1"]);
  assert.equal(allocated, "milkyway-1");
}

/**
 * Implements `supportsPreferredPrefixWhenProvided` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function supportsPreferredPrefixWhenProvided(): void {
  const allocated = allocateCloneAgentId(["atlas-1", "milkyway-1"], "astro");
  assert.equal(allocated, "astro-1");
}

/**
 * Implements `fillsFirstMissingSequenceForSelectedPrefix` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function fillsFirstMissingSequenceForSelectedPrefix(): void {
  const allocated = allocateCloneAgentId(["atlas-1", "atlas-3", "milkyway-1", "astro-1"], "atlas");
  assert.equal(allocated, "atlas-2");
}

/**
 * Implements `normalizesUnknownOrBlankAgentIdsToMainAgent` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function normalizesUnknownOrBlankAgentIdsToMainAgent(): void {
  assert.equal(normalizeAgentId(undefined), MAIN_AGENT_ID);
  assert.equal(normalizeAgentId(""), MAIN_AGENT_ID);
  assert.equal(normalizeAgentId("   "), MAIN_AGENT_ID);
}

/**
 * Implements `normalizesAgentIdsToLowercase` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function normalizesAgentIdsToLowercase(): void {
  assert.equal(normalizeAgentId("Astro-44"), "astro-44");
}

test("allocateCloneAgentId allocates first clone name from default prefix", allocatesFirstCloneNameFromDefaultPrefix);
test("allocateCloneAgentId balances clone naming across prefixes", balancesCloneNamingAcrossPrefixes);
test("allocateCloneAgentId supports preferred prefix when provided", supportsPreferredPrefixWhenProvided);
test("allocateCloneAgentId fills first missing sequence for selected prefix", fillsFirstMissingSequenceForSelectedPrefix);
test("normalizeAgentId maps unknown or blank values to main agent identity", normalizesUnknownOrBlankAgentIdsToMainAgent);
test("normalizeAgentId lowercases explicit agent IDs", normalizesAgentIdsToLowercase);

