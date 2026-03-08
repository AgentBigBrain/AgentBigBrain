/**
 * @fileoverview Tests targeted module-size enforcement for AI-first subsystem files and thin entrypoints.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertModuleSize,
  computeModuleSizeDiagnosticsFromRecords,
  ModuleSizeRule
} from "../../src/tools/checkModuleSize";

test("assertModuleSize passes for the current repo rules", () => {
  assert.doesNotThrow(() => assertModuleSize(process.cwd()));
});

test("computeModuleSizeDiagnosticsFromRecords reports violations for oversized matched files", () => {
  const rules: readonly ModuleSizeRule[] = [
    {
      label: "thin_entrypoint",
      exactPath: "src/interfaces/userFacingResult.ts",
      maxLines: 5
    },
    {
      label: "subsystem",
      pathPrefix: "src/interfaces/userFacing/",
      maxLines: 20
    }
  ];

  const diagnostics = computeModuleSizeDiagnosticsFromRecords(
    [
      { path: "src/interfaces/userFacingResult.ts", lineCount: 8 },
      { path: "src/interfaces/userFacing/resultSurface.ts", lineCount: 42 }
    ],
    rules
  );

  assert.deepEqual(
    diagnostics.violations.map((violation) => violation.path),
    [
      "src/interfaces/userFacingResult.ts",
      "src/interfaces/userFacing/resultSurface.ts"
    ]
  );
});

test("computeModuleSizeDiagnosticsFromRecords enforces thin entrypoint budgets independently of subsystem rules", () => {
  const rules: readonly ModuleSizeRule[] = [
    {
      label: "session_store_entrypoint",
      exactPath: "src/interfaces/sessionStore.ts",
      maxLines: 10
    },
    {
      label: "conversation_runtime_subsystem",
      pathPrefix: "src/interfaces/conversationRuntime/",
      maxLines: 20
    }
  ];

  const diagnostics = computeModuleSizeDiagnosticsFromRecords(
    [
      { path: "src/interfaces/sessionStore.ts", lineCount: 12 },
      { path: "src/interfaces/conversationRuntime/sessionPersistence.ts", lineCount: 25 }
    ],
    rules
  );

  assert.deepEqual(
    diagnostics.violations.map((violation) => `${violation.ruleLabel}:${violation.path}`),
    [
      "session_store_entrypoint:src/interfaces/sessionStore.ts",
      "conversation_runtime_subsystem:src/interfaces/conversationRuntime/sessionPersistence.ts"
    ]
  );
});
