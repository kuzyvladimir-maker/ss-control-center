# Product Truth G5 read-only backfill-plan evidence

Captured at 2026-07-26 from the exact production Turso target.

## Immutable inputs

- engine commit:
  `0fdbc0c9665714ba2c965496ae311ea5acd89ca8`
- migration activation contract SHA-256:
  `7b8ca99284ffdb229d488474ab9570595fd4829965b7a66d784ab4c83fe8df7e`
- canonical migration set SHA-256:
  `2eb39e0cff00a9044c466318f8ca5f1cccc94887514b323d02c4bec31e4f96e0`
- migration certification SHA-256:
  `d26f57023230f6c2145a7bd09c2d9c4c2028dd80521082dda4da5f3d310b8093`
- migration report SHA-256:
  `9039f22612ed76a7efeaf473c5b94f1e151109b962c91b361558dfc8dd22a1db`
- authoritative Phase 1 manifest SHA-256:
  `94359db196ec3bc73c964edce7a88df56e5e1942fc0ba9824670034609e9062c`
- exact target fingerprint:
  `57ff2af9adb3e963dbaf944c047130132dcd9cbb2e35ed789d6100b0f7e30003`

## Live migration continuity

- protected Product Truth migrations: `8/8` applied and tracked
- Product Truth receipt ledger: `ready`
- Prisma migration ledger: `ready`
- activation schema fingerprint:
  `8c9fc783e53fe4a94b7433eb1b06ac8b36ce03226100bfe4500d3e896367d511`
- current shared-database fingerprint:
  `21e8898e4a2de6001bd1e98e90aa1bdcf2a23110933e1cd2ffa23359f4eb7a5b`
- continuity mode: `PROTECTED_PRODUCT_TRUTH_SCHEMA`
- accepted global drift:
  `MIGRATION_RECEIPT_SCHEMA_AFTER_DRIFT`
- protected write surface `ProductTruthListingScope`: exact canonical table,
  indexes and triggers; unexpected objects: `0`

The global fingerprint changed only because the shared database gained separately
governed additive Walmart new-SKU schema. The backfill engine accepts that global
additive drift only while all eight Product Truth migrations, both ledgers and the
complete `ProductTruthListingScope` write surface remain exact. Apply also rechecks
the sealed full live fingerprint before and inside its write transaction.

## Sealed preview

- plan ID: `g5-authoritative-scope-backfill-20260726t1840z`
- plan semantic SHA-256:
  `162b2dbd35eba6b239b1e643543ee585deb6fbd7d9045081a4ea10b9ee53cf78`
- `plan.json` byte SHA-256:
  `392668d7123d9c58316f85b75565228e14950b6441ba5a238afcb4ec01072b2c`
- `approval-instructions.json` byte SHA-256:
  `ee73dacf5db536358f05cc0df6a1fb641dfe39c466e1f4e13d28fbf652637a31`
- manifest denominator: `5935`
- immutable listing-scope inserts previewed: `5935`
- artifact-only manual review tasks: `5935`
- existing manifest scope rows: `0`
- existing canonical outcomes for this manifest: `0`
- canonical cost recomputes: `0`
- writer activity rows: `0`
- foreign-key violations: `0`
- writers quiescent: `true`
- provider calls: `0`
- paid calls: `0`
- database writes during planning: `0`

The plan permits only an atomic import into `ProductTruthListingScope`. It does not
promote legacy truth, write COGS, call a provider, mutate a marketplace, perform
procurement or activate a consumer.

## Verification

- focused backfill/CLI tests: `18/18`
- full Product Truth certification: `454/454`
- TypeScript: pass
- targeted ESLint: pass
- clean-checkout execution: pass
- plan artifacts: exclusive, canonical and hash-bound

An earlier attempt from commit `c02d0e46` failed closed with
`MIGRATION_BRIDGE_RELEASE_MISMATCH` because exporting the inspector from the
activation planner changed its byte-bound activation contract. It created no output
directory and performed no database write. Commit `0fdbc0c9` restored the activation
planner byte-for-byte and moved the read-only inspector outside that immutable
boundary.

## Owner gate

This evidence does **not** authorize `backfill-apply`. The plan expires at
`2026-07-27T18:35:00.000Z`. Any apply requires a separate exact owner approval
artifact, the plan SHA above, a fresh precondition/fingerprint match and the exact
confirmation string from `approval-instructions.json`.
