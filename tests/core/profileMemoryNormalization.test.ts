/**
 * @fileoverview Focused tests for canonical profile-memory normalization helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isSensitiveKey,
  normalizeProfileKey,
  normalizeProfileValue
} from "../../src/core/profileMemoryRuntime/profileMemoryNormalization";

test("normalizeProfileKey collapses punctuation and whitespace into dotted form", () => {
  assert.equal(normalizeProfileKey(" Preferred Name "), "preferred.name");
  assert.equal(normalizeProfileKey("followup-tax filing"), "followup.tax.filing");
});

test("normalizeProfileValue collapses repeated whitespace", () => {
  assert.equal(normalizeProfileValue("  Lantern   Studio  "), "Lantern Studio");
});

test("isSensitiveKey detects normalized sensitive keys", () => {
  assert.equal(isSensitiveKey("Residence.Current"), true);
  assert.equal(isSensitiveKey("employment.current"), false);
});
