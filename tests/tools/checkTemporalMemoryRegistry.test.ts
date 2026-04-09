/**
 * @fileoverview Tests temporal-memory family-registry coverage enforcement.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertTemporalMemoryRegistry,
  computeTemporalMemoryRegistryDiagnostics
} from "../../src/tools/checkTemporalMemoryRegistry";
import type {
  ProfileMemoryFamilyRegistryEntry,
  ProfileMemoryGovernanceFamily
} from "../../src/core/profileMemoryRuntime/profileMemoryTruthGovernanceContracts";

test("assertTemporalMemoryRegistry passes for the current repo", () => {
  assert.doesNotThrow(() => assertTemporalMemoryRegistry());
});

test("computeTemporalMemoryRegistryDiagnostics reports missing family coverage", () => {
  const families: readonly ProfileMemoryGovernanceFamily[] = [
    "identity.preferred_name",
    "contact.name"
  ];
  const diagnostics = computeTemporalMemoryRegistryDiagnostics(families, {
    "identity.preferred_name": {
      family: "identity.preferred_name",
      compatibilityProjection: "ordinary_current_truth",
      corroborationMode: "required_before_current_state",
      answerModeFallback: "report_insufficient_evidence"
    } satisfies Partial<ProfileMemoryFamilyRegistryEntry>
  });

  assert.deepEqual(diagnostics.issues, [
    {
      family: "contact.name",
      message: "Canonical family is missing from the profile-memory family registry."
    }
  ]);
});

test("computeTemporalMemoryRegistryDiagnostics reports extra and malformed contact entries", () => {
  const families: readonly ProfileMemoryGovernanceFamily[] = ["contact.name"];
  const diagnostics = computeTemporalMemoryRegistryDiagnostics(families, {
    "contact.name": {
      family: "contact.relationship",
      corroborationMode: "required_before_current_state",
      answerModeFallback: "report_insufficient_evidence"
    } satisfies Partial<ProfileMemoryFamilyRegistryEntry>,
    "contact.rogue": {
      family: "contact.name",
      compatibilityProjection: "ordinary_current_truth",
      corroborationMode: "required_before_current_state",
      answerModeFallback: "report_insufficient_evidence"
    } satisfies Partial<ProfileMemoryFamilyRegistryEntry>
  });

  assert.deepEqual(diagnostics.issues, [
    {
      family: "contact.name",
      message:
        "Registry entry does not self-identify with the matching canonical family."
    },
    {
      family: "contact.name",
      message:
        "Contact families must declare an explicit compatibility projection policy."
    },
    {
      family: "contact.name",
      message:
        "Registry compatibility projection does not match the approved contact projection table."
    },
    {
      family: "contact.rogue",
      message:
        "Registry contains a family that is not part of the canonical governance contract."
    }
  ]);
});

test("computeTemporalMemoryRegistryDiagnostics reports inconsistent registry policy combinations", () => {
  const families: readonly ProfileMemoryGovernanceFamily[] = ["contact.context"];
  const diagnostics = computeTemporalMemoryRegistryDiagnostics(families, {
    "contact.context": {
      family: "contact.context",
      cardinality: "multi",
      inventoryPolicy: "single_current_winner",
      currentStateEligible: false,
      supportOnlyLegacyBehavior: "disallowed",
      compatibilityProjection: "support_only_visible",
      episodeSupportEligible: true,
      corroborationMode: "required_before_current_state",
      answerModeFallback: "report_current_state"
    } satisfies Partial<ProfileMemoryFamilyRegistryEntry>
  });

  assert.deepEqual(diagnostics.issues, [
    {
      family: "contact.context",
      message:
        "Multi-value families must declare the bounded_multi_value inventory policy."
    },
    {
      family: "contact.context",
      message:
        "Multi-value families must declare the append_multi_value displacement policy."
    },
    {
      family: "contact.context",
      message:
        "Families that disallow support-only legacy behavior cannot declare a support-only compatibility projection."
    },
    {
      family: "contact.context",
      message:
        "Episode-support-eligible families must use episode_only cardinality."
    },
    {
      family: "contact.context",
      message:
        "Families that require corroboration must use report_insufficient_evidence as their answer-mode fallback."
    }
  ]);
});

test("computeTemporalMemoryRegistryDiagnostics reports displacement-policy drift", () => {
  const families: readonly ProfileMemoryGovernanceFamily[] = [
    "identity.preferred_name",
    "contact.context",
    "followup.resolution",
    "contact.entity_hint"
  ];
  const diagnostics = computeTemporalMemoryRegistryDiagnostics(families, {
    "identity.preferred_name": {
      family: "identity.preferred_name",
      cardinality: "singular",
      currentStateEligible: true,
      inventoryPolicy: "single_current_winner",
      displacementPolicy: "append_multi_value",
      corroborationMode: "not_required",
      answerModeFallback: "report_ambiguous_contested"
    } satisfies Partial<ProfileMemoryFamilyRegistryEntry>,
    "contact.context": {
      family: "contact.context",
      cardinality: "multi",
      currentStateEligible: false,
      inventoryPolicy: "bounded_multi_value",
      displacementPolicy: "preserve_prior_on_conflict",
      supportOnlyLegacyBehavior: "support_only_visible_on_compatibility_surfaces",
      compatibilityProjection: "support_only_visible",
      episodeSupportEligible: false,
      corroborationMode: "not_required",
      answerModeFallback: "report_supporting_history"
    } satisfies Partial<ProfileMemoryFamilyRegistryEntry>,
    "followup.resolution": {
      family: "followup.resolution",
      cardinality: "singular",
      currentStateEligible: false,
      inventoryPolicy: "single_current_winner",
      displacementPolicy: "replace_authoritative_successor",
      endStatePolicy: "canonical_end_state",
      supportOnlyLegacyBehavior: "disallowed",
      corroborationMode: "not_required",
      answerModeFallback: "report_insufficient_evidence"
    } satisfies Partial<ProfileMemoryFamilyRegistryEntry>,
    "contact.entity_hint": {
      family: "contact.entity_hint",
      cardinality: "auxiliary",
      currentStateEligible: false,
      inventoryPolicy: "auxiliary_hidden",
      displacementPolicy: "preserve_prior_on_conflict",
      supportOnlyLegacyBehavior: "support_only_hidden_on_compatibility_surfaces",
      compatibilityProjection: "corroboration_hidden",
      episodeSupportEligible: false,
      corroborationMode: "required_before_current_state",
      answerModeFallback: "report_insufficient_evidence"
    } satisfies Partial<ProfileMemoryFamilyRegistryEntry>
  });

  assert.deepEqual(diagnostics.issues, [
    {
      family: "identity.preferred_name",
      message:
        "Singular current-state families must declare an explicit successor rule or prior-winner retention displacement policy."
    },
    {
      family: "contact.context",
      message:
        "Multi-value families must declare the append_multi_value displacement policy."
    },
    {
      family: "followup.resolution",
      message:
        "Families with canonical end-state handling must declare the resolution_only displacement policy."
    },
    {
      family: "contact.entity_hint",
      message:
        "Auxiliary families must declare the not_applicable displacement policy."
    }
  ]);
});

test("computeTemporalMemoryRegistryDiagnostics reports answer-mode fallback drift for support-only families", () => {
  const families: readonly ProfileMemoryGovernanceFamily[] = [
    "contact.context",
    "contact.school_association"
  ];
  const diagnostics = computeTemporalMemoryRegistryDiagnostics(families, {
    "contact.context": {
      family: "contact.context",
      cardinality: "multi",
      inventoryPolicy: "bounded_multi_value",
      currentStateEligible: false,
      supportOnlyLegacyBehavior: "support_only_visible_on_compatibility_surfaces",
      compatibilityProjection: "support_only_visible",
      episodeSupportEligible: false,
      corroborationMode: "not_required",
      answerModeFallback: "report_ambiguous_contested"
    } satisfies Partial<ProfileMemoryFamilyRegistryEntry>,
    "contact.school_association": {
      family: "contact.school_association",
      cardinality: "singular",
      inventoryPolicy: "single_current_winner",
      currentStateEligible: false,
      supportOnlyLegacyBehavior: "support_only_hidden_on_compatibility_surfaces",
      compatibilityProjection: "support_only_hidden",
      episodeSupportEligible: false,
      corroborationMode: "not_required",
      answerModeFallback: "report_ambiguous_contested"
    } satisfies Partial<ProfileMemoryFamilyRegistryEntry>
  });

  assert.deepEqual(diagnostics.issues, [
    {
      family: "contact.context",
      message:
        "Multi-value families must declare the append_multi_value displacement policy."
    },
    {
      family: "contact.context",
      message:
        "Families with compatibility-visible support-only posture must use report_supporting_history as their answer-mode fallback."
    },
    {
      family: "contact.school_association",
      message:
        "Non-current support-only hidden families must use report_supporting_history as their answer-mode fallback."
    }
  ]);
});

test("computeTemporalMemoryRegistryDiagnostics reports generic sensitive-floor drift", () => {
  const families: readonly ProfileMemoryGovernanceFamily[] = ["generic.profile_fact"];
  const diagnostics = computeTemporalMemoryRegistryDiagnostics(families, {
    "generic.profile_fact": {
      family: "generic.profile_fact",
      cardinality: "singular",
      inventoryPolicy: "single_current_winner",
      currentStateEligible: true,
      displacementPolicy: "preserve_prior_on_conflict",
      supportOnlyLegacyBehavior: "disallowed",
      compatibilityProjection: "ordinary_current_truth",
      episodeSupportEligible: false,
      corroborationMode: "not_required",
      answerModeFallback: "report_ambiguous_contested",
      minimumSensitivityFloor: "inherit"
    } satisfies Partial<ProfileMemoryFamilyRegistryEntry>
  });

  assert.deepEqual(diagnostics.issues, [
    {
      family: "generic.profile_fact",
      message:
        "generic.profile_fact must force sensitivity when the canonical key matches the sensitive-key heuristic."
    }
  ]);
});

test("computeTemporalMemoryRegistryDiagnostics reports missing approved contact projection coverage", () => {
  const families: readonly ProfileMemoryGovernanceFamily[] = ["contact.relationship"];
  const diagnostics = computeTemporalMemoryRegistryDiagnostics(
    families,
    {
      "contact.relationship": {
        family: "contact.relationship",
        cardinality: "singular",
        inventoryPolicy: "single_current_winner",
        currentStateEligible: true,
        displacementPolicy: "preserve_prior_on_conflict",
        supportOnlyLegacyBehavior: "support_only_hidden_on_compatibility_surfaces",
        compatibilityProjection: "ordinary_current_truth",
        episodeSupportEligible: false,
        corroborationMode: "not_required",
        answerModeFallback: "report_ambiguous_contested"
      } satisfies Partial<ProfileMemoryFamilyRegistryEntry>
    },
    {}
  );

  assert.deepEqual(diagnostics.issues, [
    {
      family: "contact.relationship",
      message:
        "Contact families must be mapped in the approved compatibility projection table."
    }
  ]);
});

test("computeTemporalMemoryRegistryDiagnostics reports contact projection drift and rogue contact projection entries", () => {
  const families: readonly ProfileMemoryGovernanceFamily[] = ["contact.school_association"];
  const diagnostics = computeTemporalMemoryRegistryDiagnostics(
    families,
    {
      "contact.school_association": {
        family: "contact.school_association",
        cardinality: "singular",
        inventoryPolicy: "single_current_winner",
        currentStateEligible: false,
        displacementPolicy: "preserve_prior_on_conflict",
        supportOnlyLegacyBehavior: "support_only_hidden_on_compatibility_surfaces",
        compatibilityProjection: "support_only_visible",
        episodeSupportEligible: false,
        corroborationMode: "not_required",
        answerModeFallback: "report_supporting_history"
      } satisfies Partial<ProfileMemoryFamilyRegistryEntry>
    },
    {
      "contact.school_association": "support_only_hidden",
      "contact.rogue": "ordinary_current_truth"
    }
  );

  assert.deepEqual(diagnostics.issues, [
    {
      family: "contact.school_association",
      message:
        "Registry compatibility projection does not match the approved contact projection table."
    },
    {
      family: "contact.rogue",
      message:
        "Approved contact projection table contains a family that is not part of the canonical governance contract."
    }
  ]);
});

test("assertTemporalMemoryRegistry fails closed on registry drift", () => {
  const families: readonly ProfileMemoryGovernanceFamily[] = ["generic.profile_fact"];

  assert.throws(
    () =>
      assertTemporalMemoryRegistry(families, {
        "contact.rogue": {
          family: "contact.name",
          compatibilityProjection: "ordinary_current_truth"
        } satisfies Partial<ProfileMemoryFamilyRegistryEntry>
      }),
    /Temporal memory registry check found issues/i
  );
});
