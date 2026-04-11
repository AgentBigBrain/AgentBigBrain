import { extractRequestedFrameworkFolderName } from "./frameworkBuildActionHeuristics";

const BUILD_EXECUTION_DESTINATION_PATTERN =
  /\b(?:on|to)\s+(?:my|the)\s+(desktop|documents|downloads)\b|\b(?:in|inside|at|under|from|go\s+to)\s+(?:the\s+)?['"]?[a-z]:\\|\b(?:in|inside|at|under|from|go\s+to)\s+(?:the\s+)?['"]?\/(?:users|home|tmp|var|opt)\//i;
const NAMED_WORKSPACE_LAUNCH_VERB_PATTERN =
  /\b(?:start(?:\s+up)?|launch|run|open|reopen|pull\s+up|bring\s+(?:up|back)|switch\s+to|go\s+back\s+to)\b/i;
const NAMED_WORKSPACE_VIEW_INTENT_PATTERN =
  /\b(?:browser|tab|window|preview|see\b|view\b|show\b|put\s+it\s+up)\b/i;

/** Detects explicit relaunch or reopen requests for one named workspace on a user-owned desktop path. */
export function hasNamedWorkspaceLaunchOpenIntent(activeRequest: string): boolean {
  return (
    extractRequestedFrameworkFolderName(activeRequest) !== null &&
    NAMED_WORKSPACE_LAUNCH_VERB_PATTERN.test(activeRequest) &&
    BUILD_EXECUTION_DESTINATION_PATTERN.test(activeRequest) &&
    NAMED_WORKSPACE_VIEW_INTENT_PATTERN.test(activeRequest)
  );
}
