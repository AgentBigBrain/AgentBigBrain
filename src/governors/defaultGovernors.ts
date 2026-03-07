/**
 * @fileoverview Composes the default governor council from focused policy modules.
 */

import { Governor } from "./types";
import { complianceGovernor } from "./defaultCouncil/complianceGovernor";
import { continuityGovernor } from "./defaultCouncil/continuityGovernor";
import { ethicsGovernor } from "./defaultCouncil/ethicsGovernor";
import { logicGovernor } from "./defaultCouncil/logicGovernor";
import { resourceGovernor } from "./defaultCouncil/resourceGovernor";
import { securityGovernor } from "./defaultCouncil/securityGovernor";
import { utilityGovernor } from "./defaultCouncil/utilityGovernor";

/**
 * Builds default governors for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of default governors consistent across call sites while leaving the detailed
 * policy ownership inside `src/governors/defaultCouncil/`.
 *
 * **What it talks to:**
 * - Uses `Governor` (import `Governor`) from `./types`.
 * - Uses focused default-council governor modules within this subsystem.
 *
 * @returns Ordered collection produced by this step.
 */
export function createDefaultGovernors(): Governor[] {
  return [
    ethicsGovernor,
    logicGovernor,
    resourceGovernor,
    securityGovernor,
    continuityGovernor,
    utilityGovernor,
    complianceGovernor
  ];
}
