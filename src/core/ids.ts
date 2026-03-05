/**
 * @fileoverview Generates compact unique identifiers for tasks, actions, and proposals.
 */

export function makeId(prefix: string): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${time}_${rand}`;
}

