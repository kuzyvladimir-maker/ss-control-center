# Walmart Listing Integrity — operator runbook

> **Role boundary:** Claude Code is an operator of this frozen suite, not its
> developer. Product facts come only from the shared Product Truth Platform.
> This runbook never authorizes a marketplace write by itself.

## Goal

For one exact Walmart SKU at a time, run the already-built closed loop:

`doctor → plan → execute/resume → status → report → fresh reread → Qualification`

The next SKU stays blocked until the current SKU has a fresh buyer-facing
Qualification `PASS`. Unknown POST outcome is manual review and never retry.

## Only permitted operator command

Claude Code runs only the verifier-wrapper inside the sealed clean checkout. It
must never invoke the mutable workspace operator file directly. The common
verified prefix is:

```bash
/opt/homebrew/Cellar/node@24/24.18.0/bin/node \
  "/Users/vladimirkuznetsov/SS Command Center/release-artifacts/walmart-listing-repair-engine-2026-07-23-v2/engine/ss-control-center/scripts/verify-and-run-walmart-listing-repair.mjs" \
  --engine-root "/Users/vladimirkuznetsov/SS Command Center/release-artifacts/walmart-listing-repair-engine-2026-07-23-v2/engine/ss-control-center" \
  --manifest "/Users/vladimirkuznetsov/SS Command Center/release-artifacts/walmart-listing-repair-engine-2026-07-23-v2/evidence-final-v2/release-manifest.json" \
  --manifest-sha256 387d4093e86a35a200304cbad4a92cd9ef75204ad936e562641f6e17c3da7c74 \
  --release-id-sha256 0d21ffcd5bf55c6e781daba80b3a750613f2d21bb89690a73ccbd66326aa246d \
  -- <command> <exact flags>
```

Every `next_command` receipt is the suffix after the final `--`; Claude appends
it to this same exact verified prefix. Wrapper verification requires canonical
manifest bytes, the external manifest/release hashes, the clean Git commit/tree,
all sealed source inventory bytes and both production release pins. It strips
test-runtime and Node injection variables before launching the operator.

Allowed commands are exactly:

- `doctor` — zero-network, zero-write release/trust readiness;
- `plan` — read-only verification of one canonical execution package and its
  exact owner permit/request bytes;
- `execute` — one owner-approved SKU, maximum one `MP_MAINTENANCE` POST;
- `resume` — GET-only continuation for the exact durably accepted `feedId`;
- `status` — local ledger/artifact state only;
- `report` — local evidence/next-action report only.

Claude Code executes only the exact `next_command` returned by the previous
receipt. If `next_command` is `null`, it stops and reports the blocker. It does
not edit engine, tests, schemas, release pins, owner trust roots, execution
packages, permits, receipts or custody artifacts.

## Mandatory sequence

1. Run `doctor` and save its exclusive 0400 receipt in a private existing
   directory. A doctor receipt is valid for at most 15 minutes.
2. Stop if doctor returns `NO_GO`. Never synthesize a `READY` receipt.
3. Run `plan` only with an exact canonical execution-package path and its
   externally supplied artifact SHA-256, plus the fresh doctor receipt and SHA.
4. Show the owner the one SKU, full target/diff, request hashes and exact
   confirmation string. `plan` authorizes zero writes.
5. Run `execute` only after the owner supplies the separately Ed25519-signed
   one-SKU permit already bound inside that exact execution package and gives
   the exact confirmation. A package/doctor/plan/permit mismatch stops.
6. If the result says `RESUME_EXACT_FEED_GET_ONLY`, run only `resume`; never
   re-run `execute` and never create another permit for the same unknown call.
7. Run `status`/`report`, obtain a fresh authoritative buyer reread, and run
   Qualification. Do not advance the sequence before `PASS`.

## Hard prohibitions

- no `--all`, implicit scope, schedule, cron or unattended mass run;
- no legacy `multipack/remediate.ts`, generic retrying `WalmartClient`, manual
  POST, token refresh, redirect or retry around the operator;
- no caller-supplied transport, payload builder, verifier, ledger or clock;
- no direct `scripts/walmart-listing-repair-operator.ts`, mutable workspace or
  release artifact named `INVALID-*`;
- no mutation/deletion of append-only ledger or immutable artifact custody;
- no delist, reprice, purchase or unrelated listing write;
- no paid/model batch without its separate owner gate.

## Current release state

As of 2026-07-23, Phase 5 release v2 is sealed. Clean-checkout certification passed
**109/109** tests plus targeted ESLint and diff-check. Release ID is
`0d21ffcd5bf55c6e781daba80b3a750613f2d21bb89690a73ccbd66326aa246d`;
manifest SHA-256 is
`387d4093e86a35a200304cbad4a92cd9ef75204ad936e562641f6e17c3da7c74`.
The release contains one dedicated production public key; its password-free
private half is outside the repository and is not part of this operator handoff.
The verified-wrapper smoke `doctor` returns `READY` with zero network/model/DB/
Walmart effects. This is local engine readiness only: it authorizes no write.
An exact one-SKU package, ordinary owner confirmation and fresh post-write
Qualification remain mandatory; mass run is still `NO-GO`.

## Related canon

- [[walmart-listing-integrity-platform]]
- [[walmart-listing-integrity-checkpoint-2026-07-21]]
- [[product-catalog-architecture]]
- [[product-truth-operator-runbook]]
