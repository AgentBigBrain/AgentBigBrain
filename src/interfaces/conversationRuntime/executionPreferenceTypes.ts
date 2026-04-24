/**
 * @fileoverview Shared execution-preference types for the conversation front door.
 */

import type { PresentationPreferences } from "./presentationPreferenceResolution";

export type AutonomousExecutionSignalStrength = "none" | "ambiguous" | "strong";

export interface ExtractedExecutionPreferences {
  planOnly: boolean;
  executeNow: boolean;
  autonomousExecution: boolean;
  autonomousExecutionStrength: AutonomousExecutionSignalStrength;
  naturalSkillDiscovery: boolean;
  statusOrRecall: boolean;
  reusePriorApproach: boolean;
  presentation: PresentationPreferences;
}
