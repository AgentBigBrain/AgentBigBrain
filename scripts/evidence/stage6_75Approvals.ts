/**
 * @fileoverview Runs Stage 6.75 checkpoint 6.75.F diff-based approval UX validation and emits scope/expiry/max-use misuse evidence artifact.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createApprovalGrantV1,
  createApprovalRequestV1,
  registerApprovalGrantUse,
  validateApprovalGrantUse
} from "../../src/core/stage6_75ApprovalPolicy";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_75_diff_approval_report.json"
);

interface Stage675CheckpointFArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.75.F";
  decisions: {
    validUsePass: boolean;
    scopeMismatchBlocked: boolean;
    expiryBlocked: boolean;
    maxUsesBlocked: boolean;
    scopeMismatchCode: string | null;
    expiryCode: string | null;
    maxUsesCode: string | null;
  };
  passCriteria: {
    validPass: boolean;
    misusePass: boolean;
    overallPass: boolean;
  };
}

/**
 * Implements `runStage675CheckpointF` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage675CheckpointF(): Promise<Stage675CheckpointFArtifact> {
  const request = createApprovalRequestV1({
    missionId: "mission_approval_flow_001",
    actionIds: ["action_write_calendar_001"],
    diff: "Calendar write diff payload",
    riskClass: "tier_3",
    idempotencyKeys: ["idem_write_calendar_001"],
    expiresAt: "2026-02-27T23:59:00.000Z",
    maxUses: 1
  });
  const grant = createApprovalGrantV1({
    request,
    approvedAt: "2026-02-27T23:00:00.000Z",
    approvedBy: "operator_benac"
  });

  const validDecision = validateApprovalGrantUse(request, grant, {
    missionId: "mission_approval_flow_001",
    actionId: "action_write_calendar_001",
    idempotencyKey: "idem_write_calendar_001",
    nowIso: "2026-02-27T23:01:00.000Z"
  });

  const scopeMismatchDecision = validateApprovalGrantUse(request, grant, {
    missionId: "mission_approval_flow_001",
    actionId: "action_outside_scope_999",
    idempotencyKey: "idem_write_calendar_001",
    nowIso: "2026-02-27T23:01:00.000Z"
  });

  const expiryDecision = validateApprovalGrantUse(request, grant, {
    missionId: "mission_approval_flow_001",
    actionId: "action_write_calendar_001",
    idempotencyKey: "idem_write_calendar_001",
    nowIso: "2026-02-28T00:01:00.000Z"
  });

  const exhaustedGrant = registerApprovalGrantUse(grant);
  const maxUsesDecision = validateApprovalGrantUse(request, exhaustedGrant, {
    missionId: "mission_approval_flow_001",
    actionId: "action_write_calendar_001",
    idempotencyKey: "idem_write_calendar_001",
    nowIso: "2026-02-27T23:02:00.000Z"
  });

  const validPass = validDecision.ok;
  const misusePass =
    !scopeMismatchDecision.ok &&
    !expiryDecision.ok &&
    !maxUsesDecision.ok &&
    scopeMismatchDecision.blockCode === "APPROVAL_SCOPE_MISMATCH" &&
    expiryDecision.blockCode === "APPROVAL_EXPIRED" &&
    maxUsesDecision.blockCode === "APPROVAL_MAX_USES_EXCEEDED";

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_75:approvals",
    checkpointId: "6.75.F",
    decisions: {
      validUsePass: validDecision.ok,
      scopeMismatchBlocked: !scopeMismatchDecision.ok,
      expiryBlocked: !expiryDecision.ok,
      maxUsesBlocked: !maxUsesDecision.ok,
      scopeMismatchCode: scopeMismatchDecision.blockCode,
      expiryCode: expiryDecision.blockCode,
      maxUsesCode: maxUsesDecision.blockCode
    },
    passCriteria: {
      validPass,
      misusePass,
      overallPass: validPass && misusePass
    }
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runStage675CheckpointF();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.75 checkpoint 6.75.F artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
