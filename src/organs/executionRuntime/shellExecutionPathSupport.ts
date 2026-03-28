import path from "node:path";

/**
 * Detects whether one shell path literal uses Windows-style separators or drive syntax.
 *
 * @param value - Raw path literal extracted from the shell command.
 * @returns `true` when path resolution should use `path.win32`.
 */
export function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\");
}

/**
 * Chooses the path module that matches the path literals present in the current shell context.
 *
 * @param values - Raw path literals or expressions involved in one resolution step.
 * @returns Matching `path` module for the detected path style.
 */
export function getPathModuleForContext(
  ...values: readonly string[]
): typeof path.win32 | typeof path.posix {
  return values.some((value) => isWindowsStylePath(value)) ? path.win32 : path.posix;
}
