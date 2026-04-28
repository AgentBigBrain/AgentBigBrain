/**
 * @fileoverview Covers lexical routing boundary diagnostics for frozen route-owner files.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeLexicalRoutingBoundaryDiagnosticsFromRecords
} from "../../src/tools/checkLexicalRoutingBoundary";

test("computeLexicalRoutingBoundaryDiagnosticsFromRecords reports broad route-owner vocabulary", () => {
  const diagnostics = computeLexicalRoutingBoundaryDiagnosticsFromRecords(
    [
      {
        path: "src/interfaces/routingMap.ts",
        content: [
          "const BUILD_ROUTE_PATTERNS = [",
          "  /build a website/i",
          "] as const;"
        ].join("\n")
      }
    ],
    ["src/interfaces/routingMap.ts"]
  );

  assert.equal(diagnostics.checkedFileCount, 1);
  assert.equal(diagnostics.findings.length, 1);
  assert.equal(diagnostics.findings[0].kind, "pattern_declaration");
  assert.equal(diagnostics.findings[0].lineNumber, 1);
});

test("computeLexicalRoutingBoundaryDiagnosticsFromRecords ignores exact-command exceptions", () => {
  const diagnostics = computeLexicalRoutingBoundaryDiagnosticsFromRecords(
    [
      {
        path: "src/organs/plannerPolicy/explicitActionIntent.ts",
        content:
          "const EXACT_BROWSER_ROUTE_PATTERN = /^open_browser\\b/; // lexical-boundary: exact"
      }
    ],
    ["src/organs/plannerPolicy/explicitActionIntent.ts"]
  );

  assert.equal(diagnostics.checkedFileCount, 1);
  assert.deepEqual(diagnostics.findings, []);
});

test("computeLexicalRoutingBoundaryDiagnosticsFromRecords ignores non-frozen files", () => {
  const diagnostics = computeLexicalRoutingBoundaryDiagnosticsFromRecords(
    [
      {
        path: "src/example.ts",
        content: "const RELATIONSHIP_ROUTE_PATTERNS = [/friend/i];"
      }
    ],
    ["src/interfaces/routingMap.ts"]
  );

  assert.equal(diagnostics.checkedFileCount, 0);
  assert.deepEqual(diagnostics.findings, []);
});
