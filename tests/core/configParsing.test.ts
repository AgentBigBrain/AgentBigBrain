/**
 * @fileoverview Tests the extracted config-runtime parsing helpers and stable parsing semantics.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseBoolean,
  parseBrowserVerificationHeadless,
  parseHourOfDay,
  parseLedgerBackend,
  parseRuntimeMode,
  parseUserProtectedPathPrefixes
} from "../../src/core/configRuntime/configParsing";

test("config parsing normalizes booleans and browser verification aliases deterministically", () => {
  assert.equal(parseBoolean("yes", false), true);
  assert.equal(parseBoolean("off", true), false);
  assert.equal(
    parseBrowserVerificationHeadless(
      {
        BRAIN_BROWSER_VERIFY_VISIBLE: "true",
        BRAIN_BROWSER_VERIFY_HEADLESS: "true"
      },
      true
    ),
    false
  );
  assert.equal(parseBrowserVerificationHeadless({}, true), true);
});

test("config parsing keeps runtime mode and ledger backend fail-closed", () => {
  assert.equal(parseRuntimeMode("full_access"), "full_access");
  assert.equal(parseRuntimeMode("unexpected"), "isolated");
  assert.equal(parseLedgerBackend("sqlite"), "sqlite");
  assert.equal(parseLedgerBackend("other"), "json");
});

test("config parsing keeps quiet hours bounded and protected paths normalized", () => {
  assert.equal(parseHourOfDay("23", 8), 23);
  assert.equal(parseHourOfDay("42", 8), 8);
  assert.deepEqual(
    parseUserProtectedPathPrefixes(` "C:\\Secrets" ; C:/Secrets/ ; '/Users/example/Docs' `),
    ["C:\\Secrets", "/Users/example/Docs"]
  );
});

test("config parsing fails closed for empty and invalid protected path entries", () => {
  assert.throws(
    () => parseUserProtectedPathPrefixes("C:/safe;;C:/other"),
    /empty path entry/i
  );
  assert.throws(
    () => parseUserProtectedPathPrefixes("C:/safe;C:/bad*path"),
    /invalid path entry/i
  );
});
