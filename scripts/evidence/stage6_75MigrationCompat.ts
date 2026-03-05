/**
 * @fileoverview Runs Stage 6.75 migration-compatibility normalization checks (`normalizeArtifactForParityV1`) and exits fail-closed on drift.
 */

import { normalizeArtifactForParityV1 } from "../../src/core/normalizers/stage6_75MigrationParity";

interface MigrationCompatResult {
  deterministicParity: boolean;
  normalizedSchemaName: string;
  normalizedPayloadHash: string;
}

/**
 * Implements `sha256Hex` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function sha256Hex(value: string): string {
  return require("node:crypto").createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Implements `runMigrationCompat` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export function runMigrationCompat(): MigrationCompatResult {
  const input = {
    schemaName: "DistilledPacketV1",
    schemaVersion: "v1",
    payload: {
      zeta: 2,
      alpha: {
        b: 2,
        a: 1
      }
    }
  } as const;

  const normalizedA = normalizeArtifactForParityV1(input);
  const normalizedB = normalizeArtifactForParityV1(input);
  const deterministicParity =
    JSON.stringify(normalizedA) === JSON.stringify(normalizedB);
  return {
    deterministicParity,
    normalizedSchemaName: normalizedA.schemaName,
    normalizedPayloadHash: sha256Hex(JSON.stringify(normalizedA.payload))
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function main(): void {
  const result = runMigrationCompat();
  console.log(
    `Stage 6.75 migration parity: ${result.deterministicParity ? "PASS" : "FAIL"} (${result.normalizedSchemaName})`
  );
  if (!result.deterministicParity) {
    process.exitCode = 1;
  }
}

main();
