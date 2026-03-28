import path from "node:path";

/**
 * Detects whether one workspace path literal uses Windows-style separators or drive syntax.
 *
 * @param value - Raw filesystem path literal.
 * @returns `true` when the path should be normalized with `path.win32`.
 */
export function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\");
}

/**
 * Chooses the path module that matches one concrete path literal instead of the current host OS.
 *
 * @param value - Raw filesystem path literal.
 * @returns Matching `path` module for the provided path style.
 */
export function getPathModuleForPathValue(
  value: string
): typeof path.win32 | typeof path.posix {
  return isWindowsStylePath(value) ? path.win32 : path.posix;
}

/**
 * Chooses the active Next.js app-router root for one workspace. When both `app` and `src/app`
 * exist, the root `app` directory wins because Next resolves that route tree first.
 *
 * @param workspacePath - Exact Next.js workspace root.
 * @param pathExists - Callback used to probe candidate route roots.
 * @returns Preferred Next.js route directory.
 */
export function resolvePreferredNextRouteDirectory(
  workspacePath: string,
  pathExists: (targetPath: string) => boolean
): string {
  const pathModule = getPathModuleForPathValue(workspacePath);
  const rootAppDirectoryPath = pathModule.join(workspacePath, "app");
  const srcAppDirectoryPath = pathModule.join(workspacePath, "src", "app");
  if (pathExists(rootAppDirectoryPath)) {
    return rootAppDirectoryPath;
  }
  if (pathExists(srcAppDirectoryPath)) {
    return srcAppDirectoryPath;
  }
  return rootAppDirectoryPath;
}
