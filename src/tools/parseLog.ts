/**
 * @fileoverview Normalizes stage live-smoke chat output logs into UTF-8 evidence text.
 */

import { readFileSync, writeFileSync } from "node:fs";

/**
 * Normalizes live smoke chat output into a stable shape for `parseLog` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for live smoke chat output so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `readFileSync` (import `readFileSync`) from `node:fs`.
 * - Uses `writeFileSync` (import `writeFileSync`) from `node:fs`.
 */
function normalizeLiveSmokeChatOutput(): void {
  let output = "Missing file";
  try {
    output = readFileSync("runtime/evidence/stage6_85_live_smoke_chat_output.txt", "utf16le");
  } catch {
    try {
      output = readFileSync("runtime/evidence/stage6_85_live_smoke_chat_output.txt", "utf8");
    } catch {
      // Keep deterministic missing-file placeholder content.
    }
  }

  const cleaned = output.replace(/\0/g, "");
  writeFileSync("runtime/evidence/stage6_85_chat_parsed.txt", cleaned, "utf8");
  console.log("Wrote parsed file.");
}

normalizeLiveSmokeChatOutput();
