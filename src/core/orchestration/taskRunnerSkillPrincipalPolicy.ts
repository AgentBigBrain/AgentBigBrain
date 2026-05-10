/**
 * @fileoverview Principal/access policy for governed runtime skill lifecycle actions.
 */

import type {
  ActionRunResult,
  ConstraintViolation,
  TaskPrincipalAccessEnvelope,
  TaskRunResult
} from "../types";

export interface TaskRunnerSkillPrincipalDecision {
  allowed: boolean;
  violation: ConstraintViolation | null;
  traceDetails: Record<string, string | number | boolean | null>;
}

const MUTATING_SKILL_ACTIONS = new Set<ActionRunResult["action"]["type"]>([
  "create_skill",
  "update_skill",
  "deprecate_skill",
  "approve_skill",
  "reject_skill"
]);

/**
 * Blocks protected skill lifecycle mutations unless the task carries owner/operator access.
 *
 * @param input - Task/action context from task-runner preflight.
 * @returns Allow/block decision with bounded trace metadata.
 */
export function evaluateTaskRunnerSkillPrincipalAccess(input: {
  action: ActionRunResult["action"];
  task: TaskRunResult["task"];
}): TaskRunnerSkillPrincipalDecision {
  if (!MUTATING_SKILL_ACTIONS.has(input.action.type)) {
    return buildAllowedDecision(input.task.principalAccess ?? null, false);
  }

  const principalAccess = input.task.principalAccess ?? null;
  const role = readPrincipalRole(principalAccess);
  const accessAllowed = principalAccess?.accessDecision.allowed === true;
  const accessClass = readAccessClass(principalAccess);
  const roleAllowed = role === "owner" || role === "operator";
  const classAllowed = accessClass === "owner_private" || accessClass === "operator_private";

  if (roleAllowed && accessAllowed && classAllowed) {
    return buildAllowedDecision(principalAccess, true);
  }

  return {
    allowed: false,
    violation: {
      code: "IDENTITY_IMPERSONATION_DENIED",
      message:
        "Skill lifecycle actions require owner or operator principal access; session-local, public, external, and legacy actors cannot mutate governed skills."
    },
    traceDetails: buildTraceDetails(principalAccess, true, false)
  };
}

function buildAllowedDecision(
  principalAccess: TaskPrincipalAccessEnvelope | null,
  protectedLifecycle: boolean
): TaskRunnerSkillPrincipalDecision {
  return {
    allowed: true,
    violation: null,
    traceDetails: buildTraceDetails(principalAccess, protectedLifecycle, true)
  };
}

function buildTraceDetails(
  principalAccess: TaskPrincipalAccessEnvelope | null,
  protectedLifecycle: boolean,
  allowed: boolean
): Record<string, string | number | boolean | null> {
  return {
    blockCode: allowed ? null : "IDENTITY_IMPERSONATION_DENIED",
    blockCategory: allowed ? null : "constraints",
    protectedSkillLifecycle: protectedLifecycle,
    principalRole: readPrincipalRole(principalAccess),
    accessClass: readAccessClass(principalAccess),
    accessAllowed: principalAccess?.accessDecision.allowed ?? null
  };
}

function readPrincipalRole(principalAccess: TaskPrincipalAccessEnvelope | null): string | null {
  const actor = principalAccess?.principalContext.actor;
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    return null;
  }
  const role = (actor as { principalRole?: unknown }).principalRole;
  return typeof role === "string" ? role : null;
}

function readAccessClass(principalAccess: TaskPrincipalAccessEnvelope | null): string | null {
  const accessClass = principalAccess?.accessDecision.accessClass;
  return typeof accessClass === "string" ? accessClass : null;
}
