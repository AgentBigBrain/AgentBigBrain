import path from "node:path";

/**
 * Resolves a workspace-relative path to an absolute path while preserving absolute inputs.
 *
 * @param inputPath - Relative or absolute path.
 * @returns Absolute filesystem path.
 */
export function resolveWorkspacePath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  return path.resolve(process.cwd(), inputPath);
}

/**
 * Checks whether a target path stays inside a bounded prefix.
 *
 * @param targetPath - Candidate target path.
 * @param prefix - Required parent prefix.
 * @returns `true` when the resolved target stays inside the resolved prefix.
 */
export function isPathWithinPrefix(targetPath: string, prefix: string): boolean {
  const normalizedTarget = path.resolve(process.cwd(), targetPath).toLowerCase();
  const normalizedPrefix = path.resolve(process.cwd(), prefix).toLowerCase();
  return (
    normalizedTarget === normalizedPrefix ||
    normalizedTarget.startsWith(`${normalizedPrefix}${path.sep}`) ||
    normalizedTarget.startsWith(`${normalizedPrefix}/`) ||
    normalizedTarget.startsWith(`${normalizedPrefix}\\`)
  );
}
