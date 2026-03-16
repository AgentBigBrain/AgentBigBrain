/**
 * @fileoverview Delegates path-holder inspection to the shared runtime-owned workspace inspection helper.
 */

import { InspectPathHoldersActionParams, ExecutorExecutionOutcome } from "../../core/types";
import { LiveRunExecutorContext } from "./contracts";
import { executeInspectPathHolders as executeInspectPathHoldersViaWorkspaceInspection } from "./inspectWorkspaceResourcesHandler";

/**
 * Executes `inspect_path_holders` through the shared runtime-owned inspection implementation.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param params - Structured planner params for this inspection request.
 * @returns Typed executor outcome.
 */
export async function executeInspectPathHolders(
  context: LiveRunExecutorContext,
  params: InspectPathHoldersActionParams
): Promise<ExecutorExecutionOutcome> {
  return executeInspectPathHoldersViaWorkspaceInspection(context, params);
}
