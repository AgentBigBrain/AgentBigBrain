/**
 * @fileoverview Skill verification result contracts used by create-skill and registry flows.
 */

import type { SkillVerificationStatus } from "./contracts";

export interface SkillVerificationResult {
  status: SkillVerificationStatus;
  verifiedAt: string | null;
  failureReason: string | null;
  outputSummary: string | null;
}
