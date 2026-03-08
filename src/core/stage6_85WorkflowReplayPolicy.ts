/**
 * @fileoverview Thin compatibility entrypoint for canonical Stage 6.85 workflow-replay helpers.
 */

export type { WorkflowBridgeDecision } from "./stage6_85/workflowReplay";
export {
  buildWorkflowCaptureV1,
  buildWorkflowRunReceipt,
  compileWorkflowScriptV1,
  detectWorkflowConflict,
  evaluateComputerUseBridge
} from "./stage6_85/workflowReplay";
