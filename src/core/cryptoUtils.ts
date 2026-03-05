/**
 * @fileoverview Shared deterministic utility functions for hashing, clamping, parsing, and formatting across advanced-autonomy runtime modules.
 */

import { createHash } from "node:crypto";

/**
 * Computes a SHA-256 hex digest of the input string.
 */
export function hashSha256(input: string): string {
    return createHash("sha256").update(input).digest("hex");
}

/**
 * Converts an optional ISO string to a valid ISO timestamp, defaulting to now.
 */
export function toIso(value: string | undefined): string {
    const candidate = value ? new Date(value) : new Date();
    if (Number.isNaN(candidate.valueOf())) {
        return new Date().toISOString();
    }
    return candidate.toISOString();
}

/**
 * Clamps a number to be non-negative, returning 0 for non-finite values.
 */
export function clampNonNegative(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, value);
}

/**
 * Clamps a number to the [0, 1] confidence range with 4 decimal precision.
 */
export function clampConfidence(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Number(Math.min(1, Math.max(0, value)).toFixed(4));
}

/**
 * Deduplicates, trims, and sorts an array of strings.
 */
export function toSortedUnique(values: readonly string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
        left.localeCompare(right)
    );
}

/**
 * Safely parses a JSON string as a string array, returning an empty array on failure.
 */
export function parseJsonStringArray(raw: string): string[] {
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.filter((value): value is string => typeof value === "string");
    } catch {
        return [];
    }
}
