import { BrainConfig } from "../config";
import { getStringParam } from "../hardConstraintParamUtils";
import { isPathWithinPrefix, isProtectedPath } from "../hardConstraintPathPolicy";
import { ConstraintViolation } from "../types";

/**
 * Validates filesystem actions against protected-path and sandbox-prefix rules.
 *
 * @param actionType - Filesystem action being evaluated.
 * @param params - Planned action params.
 * @param config - Active brain config with sandbox settings.
 * @returns Constraint violations for invalid or disallowed path requests.
 */
export function evaluatePathActionConstraints(
  actionType: "delete_file" | "read_file" | "write_file" | "list_directory",
  params: Record<string, unknown>,
  config: BrainConfig
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const targetPath = getStringParam(params, "path");

  if (!targetPath) {
    violations.push({
      code:
        actionType === "delete_file"
          ? "DELETE_MISSING_PATH"
          : actionType === "read_file"
            ? "READ_MISSING_PATH"
            : actionType === "write_file"
              ? "WRITE_MISSING_PATH"
              : "LIST_MISSING_PATH",
      message:
        actionType === "delete_file"
          ? "Delete action requires a path."
          : actionType === "read_file"
            ? "Read action requires a path."
            : actionType === "write_file"
              ? "Write action requires a path."
              : "List directory action requires a path."
    });
    return violations;
  }

  if (isProtectedPath(targetPath, config)) {
    violations.push({
      code:
        actionType === "delete_file"
          ? "DELETE_PROTECTED_PATH"
          : actionType === "read_file"
            ? "READ_PROTECTED_PATH"
            : actionType === "write_file"
              ? "WRITE_PROTECTED_PATH"
              : "LIST_PROTECTED_PATH",
      message:
        actionType === "delete_file"
          ? `Delete denied for protected path: ${targetPath}`
          : actionType === "read_file"
            ? `Read denied for protected path: ${targetPath}`
            : actionType === "write_file"
              ? `Write denied to protected path: ${targetPath}`
              : `List denied for protected path: ${targetPath}`
    });
    return violations;
  }

  if (actionType === "delete_file" && config.permissions.enforceSandboxDelete) {
    if (!isPathWithinPrefix(targetPath, config.dna.sandboxPathPrefix)) {
      violations.push({
        code: "DELETE_OUTSIDE_SANDBOX",
        message: `Delete path must stay inside sandbox (${config.dna.sandboxPathPrefix}).`
      });
    }
  }

  if (actionType === "list_directory" && config.permissions.enforceSandboxListDirectory) {
    if (!isPathWithinPrefix(targetPath, config.dna.sandboxPathPrefix)) {
      violations.push({
        code: "LIST_OUTSIDE_SANDBOX",
        message: `List path must stay inside sandbox (${config.dna.sandboxPathPrefix}).`
      });
    }
  }

  return violations;
}
