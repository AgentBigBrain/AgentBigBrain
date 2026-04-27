/**
 * @fileoverview Compatibility request patterns for live-verification planner policy.
 */

export const BUILD_EXECUTION_VERB_PATTERN =
  /\b(create|build|make|generate|scaffold|setup|set up|spin up|run|start|launch|fix|repair|finish|complete|implement|continue)\b/i;
export const BUILD_EXECUTION_TARGET_PATTERN =
  /\b(app|application|project|dashboard|site|website|landing\s+page|homepage|web\s+page|page|frontend|backend|api|cli|repo|repository|react|next\.?js|vue|svelte|angular|vite)\b/i;
export const BUILD_EXECUTION_DESTINATION_PATTERN =
  /\b(?:on|to)\s+(?:my|the)\s+(desktop|documents|downloads)\b|\b(?:in|inside|at|under|from|go\s+to)\s+(?:the\s+)?['"]?[a-z]:\\|\b(?:in|inside|at|under|from|go\s+to)\s+(?:the\s+)?['"]?\/(?:users|home|tmp|var|opt)\//i;
export const LOCAL_WORKSPACE_ORGANIZATION_VERB_PATTERN =
  /\b(?:organize|group|sort|move|collect|gather|tidy|clean\s+up)\b/i;
export const LOCAL_WORKSPACE_ORGANIZATION_TARGET_PATTERN =
  /\b(?:folder|folders|directory|directories|project|projects|workspace|workspaces|files)\b/i;
export const LOCAL_WORKSPACE_ORGANIZATION_DESTINATION_PATTERN =
  /\b(?:into|in(?:to)?|under)\s+(?:a\s+)?folder\s+called\b|\bcreate\s+a\s+folder\s+called\b/i;
export const LOCAL_WORKSPACE_ORGANIZATION_USER_OWNED_LOCATION_PATTERN =
  /\bmy\s+(desktop|documents|downloads)\b/i;
export const LOCAL_WORKSPACE_ORGANIZATION_IMPLICIT_MOVE_PATTERN =
  /\b(?:every|all)\s+(?:folder|folders|directory|directories|project|projects|workspace|workspaces|files)\b[\s\S]{0,80}\b(?:go|belongs?)\b[\s\S]{0,20}\b(?:in|into|under)\b/i;
export const LOCAL_WORKSPACE_ORGANIZATION_REFERENCE_PATTERN =
  /\b(?:you\s+made\s+earlier|made\s+earlier|from\s+earlier|earlier|same\s+place|same\s+folder|existing)\b/i;
export const BUILD_EXPLANATION_ONLY_PATTERN =
  /^\s*(how\s+do\s+i|how\s+to|explain|show\s+me\s+how|tutorial|guide\s+me|what\s+is)\b|\b(without\s+executing|do\s+not\s+execute|don't\s+execute|guidance\s+only|instructions?\s+only)\b/i;
export const NATURAL_BROWSER_CONTROL_FOLLOW_UP_PATTERN =
  /^\s*(?:open|reopen|show|bring\s+(?:back|up)|pull\s+up|close|shut|dismiss|hide)\b[\s\S]{0,50}\b(?:browser|tab|window|preview|page|landing page|homepage)\b/i;
export const FRAMEWORK_APP_REQUEST_PATTERN =
  /\b(?:react|vite|next\.?js|nextjs|vue|svelte|angular)\b/i;
export const STATIC_HTML_BUILD_LANE_PATTERN =
  /\bExecution lane:\s*static_html_build\b/i;
export const STATIC_HTML_BUILD_FORMAT_RESOLVED_PATTERN =
  /(?:^|\n)Build format resolved:\s*create a plain static HTML deliverable\b/i;
export const EXPLICIT_STATIC_HTML_REQUEST_PATTERN =
  /\b(?:static\s+single[- ]page|single[- ]file\s+html|single[- ]page\s+site|single[- ]page\s+html|plain\s+html|static\s+html)\b/i;
export const EXPLICIT_INDEX_HTML_ENTRY_PATTERN =
  /\bindex\.html\b/i;
export const NEGATED_FRAMEWORK_SCAFFOLD_PATTERN =
  /\bdo\s+not\s+(?:scaffold|use|create|build\s+with|generate\s+with|start\s+with)\b[\s\S]{0,80}\b(?:react|vite|next\.?js|nextjs|vue|svelte|angular)\b/i;
export const FRAMEWORK_APP_BOOTSTRAP_CUE_PATTERN =
  /\b(?:create|make|generate|scaffold|bootstrap|spin\s+up|set\s+up|setup|get\b[\s\S]{0,24}\bstarted|from\s+scratch|fresh|new)\b/i;
export const FRAMEWORK_APP_NAMED_WORKSPACE_CUE_PATTERN =
  /\b(?:called|named|folder\s+called|project\s+called|workspace\s+called)\b/i;
export const FRAMEWORK_APP_SCAFFOLD_CONTINUATION_PATTERN =
  /\bscaffold(?:ed|ing)\b/i;
export const FRAMEWORK_WORKSPACE_PREPARATION_PATTERN =
  /\b(?:workspace|ready\s+for\s+edits|dependencies\s+installed|stop\s+after\s+the\s+workspace\s+is\s+ready|do\s+not\s+run\b|do\s+not\s+open\b|don't\s+run\b|don't\s+open\b)\b/i;
export const FRAMEWORK_BUILD_LIFECYCLE_BUILD_PATTERN =
  /\b(?:turn\s+that|make|build|finish|complete|implement)\b[\s\S]{0,120}\b(?:landing\s+page|homepage|page|site|app|workspace|project)\b/i;
export const FRAMEWORK_BUILD_LIFECYCLE_PREVIEW_PATTERN =
  /\b(?:start|launch|serve|preview)\b[\s\S]{0,120}\b(?:localhost|127\.0\.0\.1|::1|loopback|preview|server|host|port|page|site|app)\b|\b(?:localhost|127\.0\.0\.1|::1|loopback|preview|server|host|port)\b[\s\S]{0,120}\b(?:start|launch|serve|preview|running|ready)\b/i;
export const FRAMEWORK_BUILD_LIFECYCLE_OPEN_PATTERN =
  /\b(?:open|reopen|show|bring\s+(?:back|up)|pull\s+up)\b[\s\S]{0,120}\b(?:browser|tab|window|preview|landing\s+page|homepage|page|site|app)\b/i;
export const FRAMEWORK_BUILD_LIFECYCLE_EDIT_PATTERN =
  /\b(?:change|edit|tweak|update|replace|rewrite|refresh)\b[\s\S]{0,120}\b(?:section|heading|hero|footer|copy|text|cta|button|content|page)\b/i;
export const FRAMEWORK_BUILD_LIFECYCLE_CLOSE_PATTERN =
  /^\s*(?:(?:thanks|thank you|ok|okay|alright|all right|now)[\s,!.:-]+)*(?:please\s+)?(?:close|shut|stop|dismiss|hide)\b/i;
export const NEGATED_LIVE_RUN_PATTERN =
  /\bdo\s+not\s+(?:probe|check|confirm|verify)\b[\s\S]{0,80}\b(?:localhost|127\.0\.0\.1|::1|loopback|http|port|ready|readiness)\b/i;
export const NEGATED_BROWSER_VERIFICATION_PATTERN =
  /\bdo\s+not\s+(?:(?:open|reopen)\s+or\s+)?(?:verify|check|inspect|review)\b[\s\S]{0,80}\b(?:browser|homepage|ui|page|render|renders|rendering)\b/i;
export const NATURAL_LOCAL_START_PATTERN =
  /\b(?:start|launch|run)\b[\s\S]{0,32}\b(?:it|the app|the site|the page)\b[\s\S]{0,24}\b(?:locally|local)\b/i;
export const NATURAL_BROWSER_OPEN_PATTERN =
  /\bopen\b[\s\S]{0,24}\b(?:it|the app|the site|the page)\b[\s\S]{0,24}\bin\s+my\s+browser\b/i;
export const NATURAL_BROWSER_LEAVE_UP_PATTERN =
  /\bleave\b[\s\S]{0,24}\b(?:it|the app|the site|the page)\b[\s\S]{0,24}\bup\b[\s\S]{0,24}\b(?:for me to|so i can)\s+(?:see|view|look)\b/i;
export const RUNTIME_PROCESS_MANAGEMENT_VERB_PATTERN =
  /\b(?:inspect|check|verify|confirm|make sure|find out|see if|look at|stop|shut\s+down|turn\s+off|kill)\b/i;
export const RUNTIME_PROCESS_MANAGEMENT_TARGET_PATTERN =
  /\b(?:still\s+running|running|server|servers|preview(?:\s+stack|\s+server)?|process(?:es)?|localhost|loopback|port|dev\s+server)\b/i;
export const LIVE_VERIFICATION_REQUEST_PATTERNS: readonly RegExp[] = [
  /\bnpm\s+start\b/i,
  /\bnpm\s+run\s+dev\b/i,
  /\b(?:pnpm|yarn)\s+(?:start|dev)\b/i,
  /\b(?:next|vite)\s+dev\b/i,
  NATURAL_LOCAL_START_PATTERN,
  /\bdev\s+server\b/i,
  /\b(localhost|127\.0\.0\.1|::1|loopback)\b/i,
  /\b(run|start|launch|serve)\b[\s\S]{0,80}\b(server|service|api|backend|dev\s+server)\b/i,
  /\b(?:probe|check|confirm|wait\s+until)\b[\s\S]{0,80}\b(?:localhost|http|port|ready|readiness)\b/i,
  /\b(?:tell\s+me|let\s+me\s+know|confirm)\b[\s\S]{0,24}\bif\b[\s\S]{0,24}\b(?:it|the app|the site|the page)\b[\s\S]{0,24}\bworked\b/i,
  /\bverify\b[\s\S]{0,80}\b(ui|homepage|browser|render|renders|rendering)\b/i,
  /\b(playwright|screenshot|visual(?:ly)?\s+confirm)\b/i
];
export const BROWSER_VERIFICATION_REQUEST_PATTERNS: readonly RegExp[] = [
  /\bverify\b[\s\S]{0,80}\b(ui|homepage|browser|render|renders|rendering)\b/i,
  /\b(check|inspect|review)\b[\s\S]{0,80}\b(browser|homepage|ui|page|render|rendering)\b/i,
  /\b(screenshot|visual(?:ly)?\s+confirm)\b/i
];
export const PERSISTENT_BROWSER_OPEN_REQUEST_PATTERNS: readonly RegExp[] = [
  /\bleave\b[\s\S]{0,40}\b(browser|page|site|window|it)\b[\s\S]{0,20}\bopen\b/i,
  NATURAL_BROWSER_OPEN_PATTERN,
  NATURAL_BROWSER_LEAVE_UP_PATTERN,
  /\bkeep\b[\s\S]{0,40}\b(browser|page|site|window|it)\b[\s\S]{0,20}\bopen\b/i,
  /\blet me (?:see|view)\b/i,
  /\bso i can (?:see|view)\b/i
];
