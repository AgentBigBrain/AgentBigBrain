import assert from "node:assert/strict";
import { test } from "node:test";

import { createSchemaEnvelopeV1 } from "../../src/core/schemaEnvelope";
import { collectProjectedCurrentSurfaceClaimsForEntity } from "../../src/core/projections/policy";
import type { ProfileMemoryGraphClaimRecord } from "../../src/core/profileMemoryRuntime/profileMemoryGraphContracts";
import type { EntityNodeV1 } from "../../src/core/types";
import { buildProjectionSnapshotFixture } from "./projectionTestSupport";

function createCurrentSurfaceClaim(input: {
  claimId: string;
  family: string;
  normalizedKey: string;
  normalizedValue: string;
}): ProfileMemoryGraphClaimRecord {
  return createSchemaEnvelopeV1(
    "ProfileMemoryGraphClaimV1",
    {
      claimId: input.claimId,
      stableRefId: null,
      family: input.family,
      normalizedKey: input.normalizedKey,
      normalizedValue: input.normalizedValue,
      sensitive: false,
      sourceTaskId: "task_projection_policy",
      sourceFingerprint: `fingerprint_${input.claimId}`,
      sourceTier: "explicit_user_statement",
      assertedAt: "2026-04-12T18:00:00.000Z",
      validFrom: "2026-04-12T18:00:00.000Z",
      validTo: null,
      endedAt: null,
      endedByClaimId: null,
      timePrecision: "day",
      timeSource: "user_stated",
      derivedFromObservationIds: [`obs_${input.claimId}`],
      projectionSourceIds: [`projection_${input.claimId}`],
      entityRefIds: [],
      active: true
    },
    "2026-04-12T18:00:00.000Z"
  );
}

test("collectProjectedCurrentSurfaceClaimsForEntity bridges contact token claims through current name claims", () => {
  const entity: EntityNodeV1 = {
    entityKey: "entity_billy_smith",
    canonicalName: "Billy Smith",
    entityType: "person",
    disambiguator: null,
    domainHint: "relationship",
    aliases: ["Billy Smith"],
    firstSeenAt: "2026-04-12T18:00:00.000Z",
    lastSeenAt: "2026-04-12T18:00:00.000Z",
    salience: 1,
    evidenceRefs: ["trace:billy"]
  };
  const claims = [
    createCurrentSurfaceClaim({
      claimId: "claim_billy_name",
      family: "contact.name",
      normalizedKey: "contact.billy.name",
      normalizedValue: "Billy Smith"
    }),
    createCurrentSurfaceClaim({
      claimId: "claim_billy_work",
      family: "contact.organization_association",
      normalizedKey: "contact.billy.work_association",
      normalizedValue: "Crimson Analytics"
    })
  ];

  const matchedClaims = collectProjectedCurrentSurfaceClaimsForEntity(
    buildProjectionSnapshotFixture({ currentSurfaceClaims: claims }),
    entity
  );

  assert.deepEqual(
    matchedClaims.map((claim) => claim.payload.claimId),
    ["claim_billy_name", "claim_billy_work"]
  );
});

test("collectProjectedCurrentSurfaceClaimsForEntity keeps organization and location association fields distinct", () => {
  const placeEntity: EntityNodeV1 = {
    entityKey: "entity_detroit",
    canonicalName: "Detroit",
    entityType: "place",
    disambiguator: null,
    domainHint: "relationship",
    aliases: ["Detroit"],
    firstSeenAt: "2026-04-12T18:00:00.000Z",
    lastSeenAt: "2026-04-12T18:00:00.000Z",
    salience: 1,
    evidenceRefs: ["trace:detroit"]
  };
  const claims = [
    createCurrentSurfaceClaim({
      claimId: "claim_work_detroit",
      family: "contact.organization_association",
      normalizedKey: "contact.owen.work_association",
      normalizedValue: "Detroit"
    }),
    createCurrentSurfaceClaim({
      claimId: "claim_location_detroit",
      family: "contact.location_association",
      normalizedKey: "contact.owen.location_association",
      normalizedValue: "Detroit"
    })
  ];

  const matchedClaims = collectProjectedCurrentSurfaceClaimsForEntity(
    buildProjectionSnapshotFixture({ currentSurfaceClaims: claims }),
    placeEntity
  );

  assert.deepEqual(
    matchedClaims.map((claim) => claim.payload.claimId),
    ["claim_location_detroit"]
  );
});
