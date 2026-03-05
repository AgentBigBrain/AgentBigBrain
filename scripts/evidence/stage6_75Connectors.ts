/**
 * @fileoverview Runs Stage 6.75 checkpoint 6.75.D connector-surface validation for Gmail/Calendar operation policy, quarantine routing, and receipt fields.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createConnectorReceiptV1,
  validateStage675ConnectorOperation
} from "../../src/core/stage6_75ConnectorPolicy";
import {
  buildDefaultRetrievalQuarantinePolicy,
  distillExternalContent,
  requireDistilledPacketForPlanner
} from "../../src/core/retrievalQuarantine";
import {
  createApprovalGrantV1,
  createApprovalRequestV1,
  validateApprovalGrantUse
} from "../../src/core/stage6_75ApprovalPolicy";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_75_connector_report.json"
);

interface Stage675CheckpointDArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.75.D";
  operations: {
    readAllowed: boolean;
    proposeAllowed: boolean;
    writeAllowed: boolean;
    updateBlocked: boolean;
    deleteBlocked: boolean;
  };
  quarantine: {
    packetProduced: boolean;
    plannerGatePass: boolean;
    packetRiskSignals: readonly string[];
  };
  approvalBinding: {
    writeGrantValid: boolean;
    writeGrantBlockCode: string | null;
  };
  connectorReceipt: {
    connector: string;
    operation: string;
    requestFingerprint: string;
    responseFingerprint: string;
  };
  passCriteria: {
    operationScopePass: boolean;
    quarantineRoutingPass: boolean;
    approvalBindingPass: boolean;
    receiptFieldPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Implements `runStage675CheckpointD` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage675CheckpointD(): Promise<Stage675CheckpointDArtifact> {
  const readDecision = validateStage675ConnectorOperation("read");
  const proposeDecision = validateStage675ConnectorOperation("propose");
  const writeDecision = validateStage675ConnectorOperation("write");
  const updateDecision = validateStage675ConnectorOperation("update");
  const deleteDecision = validateStage675ConnectorOperation("delete");

  const quarantineResult = distillExternalContent(
    {
      sourceKind: "email",
      sourceId: "gmail_message_001",
      contentType: "text/plain",
      rawContent: "Meeting invite: propose slots for next week. No direct write yet.",
      observedAt: "2026-02-27T22:40:00.000Z"
    },
    buildDefaultRetrievalQuarantinePolicy("2026-02-27T22:41:00.000Z")
  );
  const plannerGate = quarantineResult.ok
    ? requireDistilledPacketForPlanner(quarantineResult.packet)
    : { blockCode: "QUARANTINE_NOT_APPLIED" as const };

  const request = createApprovalRequestV1({
    missionId: "mission_connector_write_001",
    actionIds: ["action_calendar_write_001"],
    diff: "Calendar write: add focus block Tuesday 2pm",
    riskClass: "tier_3",
    idempotencyKeys: ["idem_calendar_write_001"],
    expiresAt: "2026-02-27T23:40:00.000Z",
    maxUses: 1
  });
  const grant = createApprovalGrantV1({
    request,
    approvedAt: "2026-02-27T22:45:00.000Z",
    approvedBy: "operator_benac"
  });
  const grantDecision = validateApprovalGrantUse(request, grant, {
    missionId: "mission_connector_write_001",
    actionId: "action_calendar_write_001",
    idempotencyKey: "idem_calendar_write_001",
    nowIso: "2026-02-27T22:50:00.000Z"
  });

  const connectorReceipt = createConnectorReceiptV1({
    connector: "calendar",
    operation: "write",
    requestPayload: {
      eventTitle: "Focus block",
      startsAt: "2026-03-03T14:00:00.000Z"
    },
    responseMetadata: {
      status: "accepted",
      eventId: "evt_001"
    },
    externalIds: ["evt_001"],
    observedAt: "2026-02-27T22:51:00.000Z"
  });

  const operationScopePass =
    readDecision.ok &&
    proposeDecision.ok &&
    writeDecision.ok &&
    !updateDecision.ok &&
    !deleteDecision.ok;
  const quarantineRoutingPass = quarantineResult.ok && plannerGate === null;
  const approvalBindingPass = grantDecision.ok;
  const receiptFieldPass =
    connectorReceipt.requestFingerprint.length > 0 &&
    connectorReceipt.responseFingerprint.length > 0;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_75:connectors",
    checkpointId: "6.75.D",
    operations: {
      readAllowed: readDecision.ok,
      proposeAllowed: proposeDecision.ok,
      writeAllowed: writeDecision.ok,
      updateBlocked: !updateDecision.ok,
      deleteBlocked: !deleteDecision.ok
    },
    quarantine: {
      packetProduced: quarantineResult.ok,
      plannerGatePass: plannerGate === null,
      packetRiskSignals: quarantineResult.ok ? quarantineResult.packet.riskSignals : []
    },
    approvalBinding: {
      writeGrantValid: grantDecision.ok,
      writeGrantBlockCode: grantDecision.blockCode
    },
    connectorReceipt: {
      connector: connectorReceipt.connector,
      operation: connectorReceipt.operation,
      requestFingerprint: connectorReceipt.requestFingerprint,
      responseFingerprint: connectorReceipt.responseFingerprint
    },
    passCriteria: {
      operationScopePass,
      quarantineRoutingPass,
      approvalBindingPass,
      receiptFieldPass,
      overallPass: operationScopePass && quarantineRoutingPass && approvalBindingPass && receiptFieldPass
    }
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runStage675CheckpointD();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.75 checkpoint 6.75.D artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
