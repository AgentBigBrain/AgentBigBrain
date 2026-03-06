import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAppleSiliconNodeMismatchMessage,
  detectAppleSiliconNodeMismatchFromValues
} from "../../src/core/appleSiliconRuntime";

test("detectAppleSiliconNodeMismatchFromValues identifies Rosetta x64 Node on Apple Silicon", () => {
  const mismatch = detectAppleSiliconNodeMismatchFromValues("darwin", "x64", "arm64");
  assert.deepEqual(mismatch, {
    platform: "darwin",
    nodeArch: "x64",
    machineArch: "arm64"
  });
});

test("detectAppleSiliconNodeMismatchFromValues ignores native arm64 Node on Apple Silicon", () => {
  const mismatch = detectAppleSiliconNodeMismatchFromValues("darwin", "arm64", "arm64");
  assert.equal(mismatch, null);
});

test("detectAppleSiliconNodeMismatchFromValues ignores non-darwin runtimes", () => {
  const mismatch = detectAppleSiliconNodeMismatchFromValues("linux", "x64", "arm64");
  assert.equal(mismatch, null);
});

test("buildAppleSiliconNodeMismatchMessage explains native arm64 remediation", () => {
  const message = buildAppleSiliconNodeMismatchMessage("onnxruntime-node");
  assert.match(message, /Apple Silicon machine detected/i);
  assert.match(message, /darwin\/x64/i);
  assert.match(message, /native arm64 Node install/i);
  assert.match(message, /BRAIN_ENABLE_EMBEDDINGS=false/i);
});
