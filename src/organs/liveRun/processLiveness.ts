/**
 * @fileoverview Minimal local PID liveness checks for reconciling persisted live-run state.
 */

/**
 * Returns whether the current OS still appears to have one process with this pid.
 *
 * `process.kill(pid, 0)` is the portable Node check for local pid existence. It does not send a
 * real signal. `EPERM` still means the pid exists but this process cannot signal it.
 *
 * @param pid - Local process identifier to probe.
 * @returns `true` when the pid still appears alive on this machine.
 */
export function isProcessLikelyAlive(pid: number | null): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    return code === "EPERM";
  }
}
