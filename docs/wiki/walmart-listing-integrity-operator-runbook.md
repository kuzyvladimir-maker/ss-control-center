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
  --env-file="/Users/vladimirkuznetsov/SS Command Center/ss-control-center/.env" \
  "/Users/vladimirkuznetsov/SS Command Center/release-artifacts/walmart-listing-repair-engine-2026-07-27-v13/engine/ss-control-center/scripts/verify-and-run-walmart-listing-repair.mjs" \
  --engine-root "/Users/vladimirkuznetsov/SS Command Center/release-artifacts/walmart-listing-repair-engine-2026-07-27-v13/engine/ss-control-center" \
  --manifest "/Users/vladimirkuznetsov/SS Command Center/release-artifacts/walmart-listing-repair-engine-2026-07-27-v13/evidence-final-v13/release-manifest.json" \
  --manifest-sha256 fb912f22700376ed305887a65015672fd66d9319292cd9c53bfff31237639041 \
  --release-id-sha256 6c74f28d8e3578e8f17c8ab18dce5bd7b0d29ab6072dd25248ddde66450c42c0 \
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
- `recover-accepted` — one pinned v7 crash-window recovery: validate immutable
  accepted HTTP 2xx/feedId custody, record `ACCEPTED`, then use feed GET only;
- `resume-recovered` — GET-only continuation of that already recovered pinned
  predecessor feed after a bounded poll returns nonterminal;
- `resume` — GET-only continuation for the exact durably accepted `feedId`;
- `status` — local ledger/artifact state only;
- `report` — local evidence/next-action report only;
- `qualify` — creates its own fresh authenticated read-only Walmart/buyer/image
  capture and returns fail-closed `PASS`, `PENDING_PROPAGATION` or `FAIL`.

Claude Code executes only the exact `next_command` returned by the previous
receipt. If `next_command` is `null`, it stops and reports the blocker. It does
not edit engine, tests, schemas, release pins, owner trust roots, execution
packages, permits, receipts or custody artifacts.

The owner-side package compiler is a separate Codex/owner operation, not a
Claude Code command. Its zero-write readiness check inside this same frozen
release is:

```bash
cd "/Users/vladimirkuznetsov/SS Command Center/release-artifacts/walmart-listing-repair-engine-2026-07-27-v13/engine/ss-control-center"
/opt/homebrew/Cellar/node@24/24.18.0/bin/node \
  --env-file="/Users/vladimirkuznetsov/SS Command Center/ss-control-center/.env" \
  --import tsx scripts/walmart-listing-repair-owner-package.ts doctor
```

It returns `READY` only for local trust/runtime readiness. `package` is allowed
only after an exact reviewed one-SKU compilation request and its exact owner
confirmation. It deterministically derives a non-reusable one-SKU Product Truth
binding from that SHA-bound review; it no longer accepts an arbitrary external
Product Truth binding file. This canary binding is bound into the owner-signed
sequence and permit, does not require price/COGS, cannot activate the shared
catalog and cannot authorize a mass run. `package` then performs exactly one
OAuth call, one exact item GET and one Get Spec POST, with zero retry, zero
redirect and zero Walmart content write. The emitted data-only package is handed
to the verifier prefix above. Claude Code never creates or signs this package.

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
6. If the result says `RESUME_EXACT_FEED_GET_ONLY`, run only `resume`; it accepts
   only package/hash/GET-only confirmation, performs exactly one feed GET and
   deliberately rejects stale doctor/plan flags. Never re-run `execute` and never
   create another permit for the same accepted/unknown call.
   `recover-accepted` is the one sealed exception for the documented v7
   `REQUESTING` crash window where accepted POST custody already exists; it
   validates that custody and cannot submit a second feed.
7. Run `status`/`report`, then the exact `qualify` command returned by the
   frozen sequence. `qualify` must create its own fresh authoritative capture;
   caller-authored/cached captures and verdicts are rejected. Do not advance the
   sequence before `PASS`.

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

As of 2026-07-27, release v13 is sealed. Clean-checkout certification passed
**142/142** declared tests plus targeted ESLint and diff-check. Release ID is
`6c74f28d8e3578e8f17c8ab18dce5bd7b0d29ab6072dd25248ddde66450c42c0`;
manifest SHA-256 is
`fb912f22700376ed305887a65015672fd66d9319292cd9c53bfff31237639041`.
The normalized runtime closure contains 53 files and four sealed entrypoints:
the verifier-wrapper, bounded operator, one-SKU process and owner package
compiler. Automatic retry and caller dependency injection are disabled;
marketplace writes are bounded to one.
V5 superseded v4 because the v4 compiler accepted an exact request containing
the legitimate zero-effect `assurance` object, then dropped that object during
normalization and falsely rejected the second internal SHA verification. V5
validates and preserves the exact assurance schema, rejects unexpected
top-level fields and contains a regression that verifies normalized requests
remain hash-valid.
V6 supersedes v5 because the live Walmart item response uses
`mart: "WALMART_US"` plus `wpid` and no numeric `itemId`, while v5 only accepted
the legacy object form `mart.itemId`. V6 accepts both observed forms while
requiring exact account, SKU, product identifier, product type, active/published
state, marketplace mart and a bounded WPID when the numeric item ID is absent.
The release contains one dedicated production public key; its password-free
private half is outside the repository and is not part of this operator handoff.
V7 supersedes v6 after the first confirmed canary execute proved an operational
ordering defect: the wrapper process had no Walmart credential variables, but
transport construction occurred only after the permit was consumed. V7 resolves
and seller-binds the side-effect-free transport before artifact persistence or
permit burn, preserves the same snapshot for the final synchronous send gate,
and returns bounded dependency error codes instead of collapsing them into a
generic pre-send error. It also includes the approved product-first title-order
precheck. The verified prefix now loads the external workspace `.env` before the
wrapper starts; secrets are never copied into the clean release.
V8 supersedes v7 after Walmart returned a valid real feed ID containing `@`.
V7 had already persisted the exact HTTP 200 response and feed ID but rejected
that character while recording `ACCEPTED`, leaving the ledger at `REQUESTING`.
V8 accepts the observed Walmart feed-ID grammar and adds a sealed
`recover-accepted` route pinned only to the v7 predecessor. It proves the exact
approved request and immutable successful POST response before advancing the
ledger, then performs only bounded GETs for that same feed. Replaying `execute`
remains forbidden.
V9 adds only the matching `resume-recovered` GET-only continuation for the
same pinned v7 package after a bounded recovery poll returns nonterminal. This
prevents a long Walmart review from requiring a new permit or any replay; it
does not add POST authority.
V10 clamps that recovered-feed continuation to exactly one immediate GET per
operator run. This avoids repeated polling during long Walmart model review and
prevents a non-refreshing OAuth token from expiring inside one continuation.
V11 adds the missing executable post-write Qualification stage. It rebuilds the
exact target from the owner-signed plan, verifies terminal apply custody, creates
its own fresh seller/buyer/image capture and checks all 14 product, quantity,
text, attribute, image, publication/indexing and unchanged-field facets. Cached
captures and caller-authored verdicts cannot authorize advancement.
V13 supersedes an unused v12 candidate and closes a continuation deadlock exposed
by the second canary: the initial poll can last 20 minutes while doctor/permit live
15 minutes. Normal `resume` is now a one-GET route that needs no stale write-gate
receipts, accepts only the current release or the exact pinned v11 predecessor,
requires durable `ACCEPTED` ledger custody and has no POST authority.
Both the verified-wrapper `doctor` and owner-package `doctor` return `READY`.
These are local engine readiness checks only and authorize no write.
An exact one-SKU package, ordinary owner confirmation and fresh post-write
Qualification remain mandatory; mass run is still `NO-GO`.

## Related canon

- [[walmart-listing-integrity-platform]]
- [[walmart-listing-integrity-checkpoint-2026-07-21]]
- [[product-catalog-architecture]]
- [[product-truth-operator-runbook]]
