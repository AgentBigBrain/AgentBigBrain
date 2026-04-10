/**
 * @fileoverview Verifies that temporal profile-memory families stay mapped in the code-owned
 * family registry.
 */

import {
  PROFILE_MEMORY_GOVERNANCE_FAMILIES,
  type ProfileMemoryContactGovernanceFamily,
  type ProfileMemoryFamilyRegistryEntry,
  type ProfileMemoryGovernanceFamily
} from "../core/profileMemoryRuntime/profileMemoryTruthGovernanceContracts";
import {
  PROFILE_MEMORY_CONTACT_COMPATIBILITY_PROJECTION_TABLE,
  PROFILE_MEMORY_FAMILY_REGISTRY
} from "../core/profileMemoryRuntime/profileMemoryFamilyRegistry";

export interface TemporalMemoryRegistryIssue {
  family: string;
  message: string;
}

export interface TemporalMemoryRegistryDiagnostics {
  issues: TemporalMemoryRegistryIssue[];
}

type TemporalMemoryRegistryEntryMap = Readonly<
  Record<string, Partial<ProfileMemoryFamilyRegistryEntry>>
>;

type TemporalMemoryContactProjectionMap = Readonly<Record<string, string>>;

/**
 * Computes deterministic diagnostics for profile-memory family-registry coverage.
 *
 * **Why it exists:**
 * Phase 2.5 promotes family policy into a code-owned registry. This check keeps new canonical
 * families from landing outside that registry and makes the approved contact-family projection
 * table explicit in CI instead of relying on memory.
 *
 * **What it talks to:**
 * - Uses `PROFILE_MEMORY_GOVERNANCE_FAMILIES` from the governance contracts.
 * - Uses `PROFILE_MEMORY_FAMILY_REGISTRY` from the code-owned family registry.
 *
 * @param families - Canonical governance families that must be represented.
 * @param registryEntries - Registry entries keyed by canonical family.
 * @returns Diagnostics describing missing or malformed registry coverage.
 */
export function computeTemporalMemoryRegistryDiagnostics(
  families: readonly ProfileMemoryGovernanceFamily[] = PROFILE_MEMORY_GOVERNANCE_FAMILIES,
  registryEntries: TemporalMemoryRegistryEntryMap = PROFILE_MEMORY_FAMILY_REGISTRY,
  contactProjectionTable: TemporalMemoryContactProjectionMap =
    PROFILE_MEMORY_CONTACT_COMPATIBILITY_PROJECTION_TABLE
): TemporalMemoryRegistryDiagnostics {
  const issues: TemporalMemoryRegistryIssue[] = [];
  const familySet = new Set<string>(families);
  const canonicalContactFamilySet = new Set<string>(
    PROFILE_MEMORY_GOVERNANCE_FAMILIES.filter((family) => family.startsWith("contact."))
  );

  for (const family of families) {
    const entry = registryEntries[family];
    if (!entry) {
      issues.push({
        family,
        message: "Canonical family is missing from the profile-memory family registry."
      });
      continue;
    }
    if (entry.family !== family) {
      issues.push({
        family,
        message: "Registry entry does not self-identify with the matching canonical family."
      });
    }
    if (family.startsWith("contact.") && typeof entry.compatibilityProjection !== "string") {
      issues.push({
        family,
        message: "Contact families must declare an explicit compatibility projection policy."
      });
    }
    if (family.startsWith("contact.")) {
      const approvedProjection =
        contactProjectionTable[family as ProfileMemoryContactGovernanceFamily];
      if (typeof approvedProjection !== "string") {
        issues.push({
          family,
          message: "Contact families must be mapped in the approved compatibility projection table."
        });
      } else if (entry.compatibilityProjection !== approvedProjection) {
        issues.push({
          family,
          message:
            "Registry compatibility projection does not match the approved contact projection table."
        });
      }
    }
    if (
      entry.cardinality === "singular" &&
      entry.inventoryPolicy !== "single_current_winner"
    ) {
      issues.push({
        family,
        message: "Singular families must declare the single_current_winner inventory policy."
      });
    }
    if (
      entry.cardinality === "multi" &&
      entry.inventoryPolicy !== "bounded_multi_value"
    ) {
      issues.push({
        family,
        message: "Multi-value families must declare the bounded_multi_value inventory policy."
      });
    }
    if (
      entry.cardinality === "episode_only" &&
      entry.inventoryPolicy !== "episode_timeline"
    ) {
      issues.push({
        family,
        message: "Episode-only families must declare the episode_timeline inventory policy."
      });
    }
    if (
      entry.cardinality === "auxiliary" &&
      entry.inventoryPolicy !== "auxiliary_hidden"
    ) {
      issues.push({
        family,
        message: "Auxiliary families must declare the auxiliary_hidden inventory policy."
      });
    }
    if (
      entry.cardinality === "singular" &&
      entry.currentStateEligible &&
      entry.displacementPolicy !== "replace_authoritative_successor" &&
      entry.displacementPolicy !== "preserve_prior_on_conflict"
    ) {
      issues.push({
        family,
        message:
          "Singular current-state families must declare an explicit successor rule or prior-winner retention displacement policy."
      });
    }
    if (
      entry.cardinality === "multi" &&
      entry.displacementPolicy !== "append_multi_value"
    ) {
      issues.push({
        family,
        message: "Multi-value families must declare the append_multi_value displacement policy."
      });
    }
    if (
      entry.cardinality === "auxiliary" &&
      entry.displacementPolicy !== "not_applicable"
    ) {
      issues.push({
        family,
        message: "Auxiliary families must declare the not_applicable displacement policy."
      });
    }
    if (
      entry.endStatePolicy === "canonical_end_state" &&
      entry.displacementPolicy !== "resolution_only"
    ) {
      issues.push({
        family,
        message:
          "Families with canonical end-state handling must declare the resolution_only displacement policy."
      });
    }
    if (
      entry.supportOnlyLegacyBehavior === "disallowed" &&
      (
        entry.compatibilityProjection === "support_only_hidden" ||
        entry.compatibilityProjection === "support_only_visible" ||
        entry.compatibilityProjection === "support_only_name_only"
      )
    ) {
      issues.push({
        family,
        message:
          "Families that disallow support-only legacy behavior cannot declare a support-only compatibility projection."
      });
    }
    if (
      entry.currentStateEligible === false &&
      entry.compatibilityProjection === "ordinary_current_truth"
    ) {
      issues.push({
        family,
        message:
          "Families that are not current-state eligible cannot declare ordinary current-truth compatibility projection."
      });
    }
    if (
      entry.episodeSupportEligible === true &&
      entry.cardinality !== "episode_only"
    ) {
      issues.push({
        family,
        message: "Episode-support-eligible families must use episode_only cardinality."
      });
    }
    if (
      entry.corroborationMode !== "not_required" &&
      entry.answerModeFallback !== "report_insufficient_evidence"
    ) {
      issues.push({
        family,
        message:
          "Families that require corroboration must use report_insufficient_evidence as their answer-mode fallback."
      });
    }
    if (
      entry.supportOnlyLegacyBehavior === "support_only_visible_on_compatibility_surfaces" &&
      entry.answerModeFallback !== "report_supporting_history"
    ) {
      issues.push({
        family,
        message:
          "Families with compatibility-visible support-only posture must use report_supporting_history as their answer-mode fallback."
      });
    }
    if (
      entry.supportOnlyLegacyBehavior === "support_only_hidden_on_compatibility_surfaces" &&
      entry.currentStateEligible === false &&
      entry.corroborationMode === "not_required" &&
      entry.answerModeFallback !== "report_supporting_history"
    ) {
      issues.push({
        family,
        message:
          "Non-current support-only hidden families must use report_supporting_history as their answer-mode fallback."
      });
    }
    if (
      family === "generic.profile_fact" &&
      entry.minimumSensitivityFloor !== "force_sensitive_for_sensitive_keys"
    ) {
      issues.push({
        family,
        message:
          "generic.profile_fact must force sensitivity when the canonical key matches the sensitive-key heuristic."
      });
    }
  }

  for (const family of Object.keys(registryEntries)) {
    if (!familySet.has(family)) {
      issues.push({
        family,
        message: "Registry contains a family that is not part of the canonical governance contract."
      });
    }
  }

  for (const family of Object.keys(contactProjectionTable)) {
    if (!canonicalContactFamilySet.has(family)) {
      issues.push({
        family,
        message:
          "Approved contact projection table contains a family that is not part of the canonical governance contract."
      });
    }
  }

  return { issues };
}

/**
 * Fails closed when the profile-memory family registry drifts from the canonical governance family
 * contract.
 *
 * **Why it exists:**
 * Registry coverage is part of the temporal-memory maintainability contract, so drift must fail in
 * CI instead of silently accumulating.
 *
 * **What it talks to:**
 * - Uses `computeTemporalMemoryRegistryDiagnostics` from this module.
 *
 * @param families - Canonical governance families that must be represented.
 * @param registryEntries - Registry entries keyed by canonical family.
 */
export function assertTemporalMemoryRegistry(
  families: readonly ProfileMemoryGovernanceFamily[] = PROFILE_MEMORY_GOVERNANCE_FAMILIES,
  registryEntries: TemporalMemoryRegistryEntryMap = PROFILE_MEMORY_FAMILY_REGISTRY,
  contactProjectionTable: TemporalMemoryContactProjectionMap =
    PROFILE_MEMORY_CONTACT_COMPATIBILITY_PROJECTION_TABLE
): void {
  const diagnostics = computeTemporalMemoryRegistryDiagnostics(
    families,
    registryEntries,
    contactProjectionTable
  );
  if (diagnostics.issues.length === 0) {
    return;
  }

  const lines = ["Temporal memory registry check found issues:"];
  for (const issue of diagnostics.issues) {
    lines.push(`- ${issue.family}: ${issue.message}`);
  }
  throw new Error(lines.join("\n"));
}

/**
 * Runs the temporal-memory family registry check entrypoint.
 *
 * **Why it exists:**
 * Makes registry drift enforcement runnable from package scripts and CI without duplicating the
 * underlying assertion logic.
 *
 * **What it talks to:**
 * - Uses `assertTemporalMemoryRegistry` from this module.
 *
 * @returns Nothing. Success or failure is reported through process output and exit code.
 */
function main(): void {
  try {
    assertTemporalMemoryRegistry();
    console.log("Temporal memory registry check passed.");
  } catch (error) {
    console.error("Temporal memory registry check failed:");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
