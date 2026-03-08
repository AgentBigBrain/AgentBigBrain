# Config Runtime

## Responsibility
This subsystem owns canonical runtime configuration contracts and pure env/config parsing helpers
extracted from `config.ts` once they become high-churn or cross-cutting enough to justify a local
edit surface.

The current extracted slice moves configuration contract and parsing ownership behind:
- `envContracts.ts`
- `configParsing.ts`
- `platformProfiles.ts`

The stable compatibility entrypoint remains:
- `config.ts`

Canonical behavior for those contracts now lives here.

## Inputs
- process environment values and runtime configuration overrides
- shared runtime action, governor, and shell-profile contracts from `src/core/`

## Outputs
- canonical runtime configuration contracts reused by the stable config entrypoint
- deterministic env parsing, normalization, and protected-path parsing helpers
- canonical shell-profile defaults, runtime-mode config cloning, and shell env/profile resolution

## Invariants
- `config.ts` remains the stable runtime-config entrypoint unless a dedicated migration changes
  that contract.
- Extraction here changes ownership, not runtime config semantics.
- Shared config contracts and parsing helpers should move here by concern instead of growing
  `config.ts` as one catch-all file.

## Related Tests
- `tests/core/config.test.ts`
- `tests/core/configParsing.test.ts`
- `tests/core/configPlatformProfiles.test.ts`

## When to Update This README
Update this README when:
- a file is added, removed, or renamed under `src/core/configRuntime/`
- canonical config contract or parsing ownership moves
- `config.ts` changes role as the stable compatibility entrypoint
- the related-test surface changes because config ownership moved
