# Walmart Listing Integrity — operator runbook

> **Role boundary:** Claude Code is an operator of this frozen suite, not its
> developer. Product facts come only from the shared Product Truth Platform.
> This runbook never authorizes a marketplace write by itself.

## Goal

For one exact Walmart SKU at a time, run the already-built closed loop:

`doctor → plan → execute/resume → status → report → fresh reread → Qualification`

The next SKU stays blocked until the current SKU either has a fresh buyer-facing
Qualification `PASS` or has been sealed as `QUARANTINED_UNRESOLVED` after a
terminal Qualification failure. Quarantine never marks the repair complete and
forbids replaying the same payload. Unknown POST outcome is manual review and
never retry.

## Only permitted operator command

Claude Code runs only the verifier-wrapper inside the sealed clean checkout. It
must never invoke the mutable workspace operator file directly. The common
verified prefix is:

```bash
/opt/homebrew/Cellar/node@24/24.18.0/bin/node \
  --env-file="/Users/vladimirkuznetsov/SS Command Center/ss-control-center/.env" \
  "/Users/vladimirkuznetsov/SS Command Center/release-artifacts/walmart-listing-repair-engine-2026-08-01-v50/engine/ss-control-center/scripts/verify-and-run-walmart-listing-repair.mjs" \
  --engine-root "/Users/vladimirkuznetsov/SS Command Center/release-artifacts/walmart-listing-repair-engine-2026-08-01-v50/engine/ss-control-center" \
  --manifest "/Users/vladimirkuznetsov/SS Command Center/release-artifacts/walmart-listing-repair-engine-2026-08-01-v50/release-manifest.json" \
  --manifest-sha256 65f6fff8599a8001a5a3b1dfcdaca149aae2f0456c90cc41a6b164a6ec953aff \
  --release-id-sha256 729f5cc081663b97d09b483dcda5226117dff07a094e978f0774e6c1eeebdd6c \
  --global-admission-root /Users/vladimirkuznetsov/.ss-command-center-owner/walmart/listing-integrity-global-admission-v1 \
  -- <command> <exact flags>
```

Every `next_command` receipt is the suffix after the final `--`; Claude appends
it to this same exact verified prefix. Wrapper verification requires canonical
manifest bytes, the external manifest/release hashes, the clean Git commit/tree,
all sealed source inventory bytes and both production release pins. It strips
test-runtime and Node injection variables before launching the operator. V50
also verifies the private canonical global-admission root and its manifest-pinned
identity before launching any command.

## Codex-only frozen supervisor

Claude Code does not invoke the continuous supervisor. The permanent one-SKU
orchestrator is separately frozen above V50 at release
`9bb2590642faf36dfb627b7d86bd5449fa6b9275635bb3dc7abe98923e6e68ed`, manifest
SHA-256 `46c62544a76e8f40a39ad6be8d08cc8780e919774d0acaddbebfeb001d4fe0f0`:

```bash
/opt/homebrew/Cellar/node@24/24.18.0/bin/node \
  "/Users/vladimirkuznetsov/SS Command Center/release-artifacts/walmart-listing-integrity-control-2026-08-02-v18/engine/ss-control-center/scripts/verify-and-run-walmart-listing-integrity-control.mjs" \
  --engine-root "/Users/vladimirkuznetsov/SS Command Center/release-artifacts/walmart-listing-integrity-control-2026-08-02-v18/engine/ss-control-center" \
  --manifest "/Users/vladimirkuznetsov/SS Command Center/release-artifacts/walmart-listing-integrity-control-2026-08-02-v18/release-manifest.json" \
  --manifest-sha256 46c62544a76e8f40a39ad6be8d08cc8780e919774d0acaddbebfeb001d4fe0f0 \
  --workspace-root "/Users/vladimirkuznetsov/SS Command Center/ss-control-center" \
  -- doctor
```

The wrapper verifies 324 exact files, the 254-file runtime closure, Node runtime
and V50 writer manifest before loading the successor. V18 clean-checkout
certification is `323/323 PASS`, commit `e3573670`. V18 inherits the v9
catalog/diagnosis boundary and does not pin an aging
catalog: at each new pool boundary its frozen catalog reader requires one exact
`DOWNLOADED ITEM_CATALOG` report, equal report/mirror row counts, equal
`downloadedAt/syncedAt`, report age at most 24 hours and snapshot age at most
15 minutes. An independent byte-tamper probe is rejected before successor
startup. Release v1 (`7286c55f…813d06`, manifest
`16740713…4c1e7`) is invalid for operation because it omitted the dynamically
required vision contract and must never be launched. V9 preserves the V3 sealed
reservation `walmart:1:FaisalX-1435` in every pool and replaces the July 28 static
census with the authoritative fail-closed freshness contract;
that SKU cannot enter a controlled epoch. The supervisor remains capped
at one active SKU and at most one writer POST for that SKU; price, inventory,
repricing, delisting, `--all`, retry and unknown-POST replay have no route.
V9 retains the post-SLA MAIN-only failure disposition. If the exact
accepted feed never exposes its target MAIN while every other Qualification facet
and publication/indexing remain PASS, the SKU becomes
`QUARANTINED_UNRESOLVED` without replay. Both crash windows are recoverable from
the already persisted exact Qualification receipt or already published
disposition; recovery performs no Walmart/model/provider call and only releases
the global admission after byte verification.
When every item in a ten-SKU controlled run is terminal and every PASS has its
verified factual gallery, v6 atomically seals `RUN_COMPLETED`, preserves the run
and its evidence, then requires a fresh ITEM_CATALOG-backed pool for the next
epoch. A quarantine never fabricates a gallery. Execution is still strictly one
SKU at a time and at most one writer POST per active SKU. V9 additionally reads
the preserved terminal listing boundary across every epoch. After repair-ready
rows are exhausted, `SOURCE_REQUIRED` rows enter the same one-SKU diagnostic
queue and become documented `QUARANTINED_SOURCE_REQUIRED` without write; they
cannot repeat in a later epoch. A fresh pool with no remaining row seals
`CATALOG_COMPLETE` and requests the final report instead of failing seed.
The catalog boundary is every active `PUBLISHED` ITEM_CATALOG row with exact item
ID and title, not only rows with a preliminary quantity/title signal. Signals and
sales/returns still determine priority, but cannot remove a published SKU from
the denominator.
For a source-blocked row v9 uses the frozen `inspect` mode: exact seller item,
catalog resolution, buyer PDP and every image byte are captured, then the signed
blind observer and conservative live title/text/image self-consistency detector
run. Explicit pack-count, brand, product-class and cross-image contradictions are
therefore recorded even without canonical Product Truth. This evidence cannot
establish truth or authorize a repair; the row remains
`QUARANTINED_SOURCE_REQUIRED` for later enrichment.

The one historical predecessor `FaisalX-1144` predates the Stage A run, so it is
bridged by LaunchAgent
`com.sirius.walmart-listing-integrity-pre-v50-reconcile`. The bridge is pinned to
the v5 disposition verifier and exact imported global claim. It accepts only a
final PASS gallery or one `QUALIFICATION_FAIL` receipt that independently passes
the post-SLA MAIN-only disposition builder while the peer predecessor is already
PASS. Other monitor errors remain fail-closed. Script SHA-256
`09db35366…67cd5d`, plist SHA-256 `927ebdcf…82a13`; live pending-path and
synthetic exact-receipt post-SLA tests pass with zero external effects. Bridge
activation receipt SHA-256 `3f34a93f…014db`.

The active macOS service is LaunchAgent
`com.sirius.walmart-listing-integrity`, plist SHA-256
`c3baa19b3f0aa2383787f5b023c37edb22596a926dac08300197e027f8e7c160`.
Its explicit runtime environment selects the sealed Codex vision contract with
`WALMART_LISTING_TRIAGE_PROVIDER=codex` and the authenticated local helper with
`WALMART_LISTING_TRIAGE_TRANSPORT=ssh-openclaw`. This avoids the currently
rate-limited Claude subscription lane and prevents the unrelated image-generation
`/generate` URL from being interpreted as a vision-analysis endpoint.
Provider activation receipt SHA-256:
`8d3be2a16f1cdb81a303ca8e247eb0921fb6c3525b2260a1b47b70d2c0d2862a`.
It runs v18 at login and restarts only after an unsuccessful exit. Completed
ten-SKU epochs roll into a fresh catalog-backed epoch instead of stopping or
reusing the old population. V18 adds the temporary owner-directed image hold:
any route changing MAIN/gallery becomes terminal deferred quarantine before
candidate/model/owner-package creation, while the exact `DESCRIPTION_BULLETS`
route remains enabled and must still complete execute → reread → Qualification
→ factual gallery. Price, inventory, repricing and delisting remain outside all
routes. Exact readmission of `FaisalX-2554`/`3713` was single-use: the following
fresh pool has `readmission: null` and excludes both listing keys.

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
- `quarantine` — local-only verification of one sealed terminal failure
  disposition; it archives the active global claim as
  `QUARANTINED_UNRESOLVED` and performs no network or Walmart write.

Claude Code executes only the exact `next_command` returned by the previous
receipt. If `next_command` is `null`, it stops and reports the blocker. It does
not edit engine, tests, schemas, release pins, owner trust roots, execution
packages, permits, receipts or custody artifacts.

The owner-side package compiler is a separate Codex/owner operation, not a
Claude Code command. Its zero-write readiness check inside this same frozen
release is:

```bash
cd "/Users/vladimirkuznetsov/SS Command Center/release-artifacts/walmart-listing-repair-engine-2026-08-01-v50/engine/ss-control-center"
/opt/homebrew/Cellar/node@24/24.18.0/bin/node \
  --env-file="/Users/vladimirkuznetsov/SS Command Center/ss-control-center/.env" \
  --import tsx scripts/walmart-listing-repair-owner-package.ts doctor
```

It returns `READY` only for local trust/runtime readiness. `package` is allowed
only after an exact reviewed one-SKU compilation request and a consumed explicit
owner decision for that scope; it must not create a second chat-confirmation
ceremony. It deterministically derives a non-reusable one-SKU Product Truth
binding from that SHA-bound review; it no longer accepts an arbitrary external
Product Truth binding file. This canary binding is bound into the owner-signed
sequence and permit, does not require price/COGS, cannot activate the shared
catalog and cannot authorize a mass run. `package` then performs exactly one
OAuth call, one exact item GET and one Get Spec POST, with zero retry, zero
redirect and zero Walmart content write. The emitted data-only package is handed
to the verifier prefix above. The frozen operator never creates or signs this
package; the machine-side owner-control path does so without asking the owner to
copy strings or hashes.

## Mandatory sequence

0. Inspect
   `ss-control-center/data/audits/walmart-listing-integrity-coordination/ACTIVE-RUNS-*.md`
   and the named durable ledgers. A session must not prepare or submit a new SKU
   owned by another active session, and no new POST may start while the shared
   register says an accepted feed is nonterminal. V50 additionally performs an
   atomic filesystem claim before the writer can reach its one POST. A second
   tab/process fails closed even if it read an older advisory register.
1. Run `doctor` and save its exclusive 0400 receipt in a private existing
   directory. A doctor receipt is valid for at most 15 minutes.
2. Stop if doctor returns `NO_GO`. Never synthesize a `READY` receipt. A doctor
   may report engine `READY` while `global_admission.status=OCCUPIED`; in that
   state read-only status/monitoring may continue but a new `execute` is closed.
3. Run `plan` only with an exact canonical execution-package path and its
   externally supplied artifact SHA-256, plus the fresh doctor receipt and SHA.
4. Record the one SKU, full target/diff and request hashes in the consumed owner
   decision artifact. Do not ask the owner to copy an exact confirmation string
   or repeat an explicit instruction. `plan` authorizes zero writes.
5. Run `execute` only after the machine-side owner-control path supplies the
   separately Ed25519-signed one-SKU permit already bound inside that exact
   execution package. The originating explicit owner instruction supplies the
   business decision; the permit supplies cryptographic binding, not a second
   chat approval. A package/doctor/plan/permit mismatch stops. If the signer is
   unavailable, return `AUTOMATION_GAP_NO_CHAT_CEREMONY` and do not turn the
   owner into copy/paste transport.
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

- no `--all`, implicit scope, ad-hoc schedule/cron or multi-SKU write batch. The
  only continuous exception is the manifest-pinned Codex supervisor described
  above under the persistent owner goal: it admits one sealed ten-SKU diagnostic
  epoch at a time, keeps only one SKU active, and still permits at most one exact
  one-SKU POST followed by Qualification before advancement;
- no legacy `multipack/remediate.ts`, generic retrying `WalmartClient`, manual
  POST, token refresh, redirect or retry around the operator;
- no caller-supplied transport, payload builder, verifier, ledger or clock;
- no direct `scripts/walmart-listing-repair-operator.ts`, mutable workspace or
  release artifact named `INVALID-*`;
- no mutation/deletion of append-only ledger or immutable artifact custody;
- no delist, reprice, purchase or unrelated listing write;
- no paid/model batch without its separate owner gate.

## Current release state

As of 2026-08-01, certification v50 seals the one-SKU runtime at commit
`f6a4d4bc95a8fc57979f4ea0e21929f2543e55bb` and tree
`0906be08154d3c3f9a07179af900bb170047de57`. Clean-checkout certification passed
**203/203** tests plus targeted ESLint and diff-check. Release ID is
`729f5cc081663b97d09b483dcda5226117dff07a094e978f0774e6c1eeebdd6c`;
manifest SHA-256 is
`65f6fff8599a8001a5a3b1dfcdaca149aae2f0456c90cc41a6b164a6ec953aff`.
The normalized runtime closure contains 83 files and twenty sealed entrypoints.

V50 preserves every v49 exact-payload and Qualification rule and adds a real
cross-process admission boundary. The wrapper pins both the canonical private
root path and identity bytes. `execute` atomically creates one active claim
before the writer can reach Walmart; concurrent tabs cannot both acquire it.
The claim binds exact SKU/item, package, permit, plan and frozen release. It is
not auto-evicted after a crash or timeout. `resume`, recovery and `qualify` must
match that same claim. It is archived, never deleted, only after fresh
Qualification `PASS` or a verified terminal quarantine disposition. Unknown
POST outcome remains fail-closed and cannot replay. Automatic retry and caller
dependency injection remain disabled; marketplace writes remain bounded to one.

The root identity file SHA-256 is
`971d12097b154220d0818a03af8d78679aac26bf42a024ac654e7f4256232650`.
An imported legacy claim for `FaisalX-1144` currently keeps V50
`global_admission.status=OCCUPIED` while the already-accepted pre-V50 `1144` and
parallel `1434` feeds finish fresh Qualification. This hold is deliberate: V50
must not start a new SKU until both predecessor cycles have PASS or documented
disposition. V49 is the only accepted live-Qualification predecessor for V50;
that permits GET/readback of its already accepted feed and grants no second POST.

### Full-surface Maruchan successor is not an operator release

The developer clean candidate for exact `FaisalX-1433/1434/1435` full-surface
repair is not a replacement for the v47 verifier prefix above. Candidate commit
`cd76c4235474d2ea783eaa08ae3ecb5b548da912`, tree
`63c787a576197b1674618a5bfaa704d4713b6697`, passed `npm ci`, TypeScript,
targeted ESLint and `24/24` focused tests. It adds operation-bound
title/gallery/attributes/weight/shipping/price capabilities, exact terminal
feed diagnostics and a mandatory three-probe post-Support catalog-clearance
gate.

The first exact maintenance feed for these three SKU,
`18C6CF32F63A56F8BA927F7E31D85C90@AX8BBwA`, is terminal `0/3` with
`ERR_EXT_DATA_0101119` / `QARTH`. It must never be replayed. The candidate
creates no new repair plan unless fresh sealed seller/global-catalog probes
prove the exact corrected title and changed MAIN for all three SKU after Walmart
Catalog Support arbitration. Until a new checksum-bound production release and
verified prefix are added here, Claude Code must not invoke the candidate,
mutable workspace operator, temp checkout or owner signer.

The v25 `FaisalX-1140` content/image feed
`18C689CE7F4F50BCBC0E931360F8D73F@AX8BBwA` is terminal `SUCCEEDED`; fresh
buyer rereads prove exact title, description, bullets, MAIN, Pack of 4,
publication and indexing. Walmart dropped buyer-visible `Total count` during
that maintenance update. V28 therefore submitted one separately signed
attribute-only payload containing only `count=4` and `countPerPack=1`; feed
`18C693DEE51E5DD8A2D5A0A65924E778@AX8BBgA` is terminal `SUCCEEDED`, retry `0`.
Fresh v30 Qualification at `2026-07-28T23:26:17.570Z` is
`PENDING_PROPAGATION` because Walmart has not yet exposed `Total count`; every
continuation is GET-only. Exact identity, publication/indexing, product/variant,
Pack of 4, title, description, bullets, MAIN and gallery all pass. Title, text,
images, price, inventory, publication and listing status are outside this
recovery payload. A one-shot v31 launchd monitor, without `KeepAlive`, performs
one intermediate reread and one post-SLA reread, stops on PASS/FAIL, then either
builds the factual gallery and successor pool or seals terminal quarantine and
builds the successor pool. It cannot perform a maintenance POST. This does not
authorize a second SKU or any wave.

`FaisalX-2768` is sealed as `QUARANTINED_UNRESOLVED`, disposition body
`5b007cfa7d04558e95d45d2412032d223b41281d76e69ee4d6a774b6a7915539`.
Its v22 feed was technically successful but the fresh buyer surface remained
wrong after the full SLA. The same payload may not be replayed. Content
Ownership/Walmart Support evidence and a new plan are required to repair that
listing; other SKU may proceed through the strict one-at-a-time queue.
V21 supersedes v20 because a fresh seller response can identify a requested
Walmart attribute as an active `variantGroupInfo.groupingAttributes` key.
The ordinary one-SKU attribute lane now fails closed with
`VARIANT_GROUP_REPAIR_REQUIRED` when a mapped field controls the live variant
group, or when variant-group evidence is incomplete. It does not synthesize a
group envelope and adds no POST authority. V20's six-hour propagation boundary
and exact historical v18 Qualification predecessor remain unchanged.
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
V14 adds the missing production path for an owner-reviewed MAIN replacement.
It accepts only the exact `description + bullets + MAIN` diff, preserves every
gallery slot, rebuilds the 2200×2200 multipack PNG from the exact SHA-bound
single-unit source, independently verifies the signed blind-worker receipt and
PASS decision, binds the content-addressed public bytes, Product Truth and owner
review into a separate evidence certificate, and still requires a distinct
one-SKU Ed25519 permit. Price, inventory, title, attributes, status, delisting,
retry and mass apply remain outside the write authority.
V18 adds the exact attributes-only lane used by `FaisalX-2768`. It accepts only
the four reviewed Product Truth mappings `flavor`, `count`, `countPerPack` and
`multipackQuantity`, preserves every opaque attribute by omission and keeps
title, description, bullets, MAIN, gallery, price, inventory and listing state
outside the payload. The first bounded POST received a definite Walmart
`HTTP 520 / SYSTEM_ERROR.GMP_GATEWAY_API` with no `feedId`; its permit is
terminal and was not replayed. A new owner-bound plan reread the same live item,
submitted the same exact payload once and reached terminal `SUCCEEDED`.
V19 fixed the subsequently exposed read-only Qualification gap: the earlier
live verifier only understood text-only and reviewed-MAIN plans. V19 accepts
v18 as its sole predecessor for post-write inspection, validates the exact
buyer-visible attribute target, proves opaque attributes and all unchanged
text/image bytes are preserved, and returns `PENDING_PROPAGATION` until Walmart
actually exposes the new values. V19 adds no POST authority.
V20 corrects the post-write failure boundary from two hours to six hours from
terminal feed success, matching Walmart's published Item Management SLA for
catalog/Walmart.com availability. An unchanged live surface before that
boundary remains no-write `PENDING_PROPAGATION`; a regression proves the old
three-hour false-FAIL path is closed. V20 adds no POST authority.
Both the v39 verified-wrapper `doctor` and owner-package `doctor` return `READY`.
These are local engine readiness checks only and authorize no write.
An exact one-SKU package, a machine-bound consumed owner decision and fresh
post-write Qualification remain mandatory; mass run is still `NO-GO`. Per
[[product-truth-owner-gates]], an explicit owner instruction is not followed by
another confirmation prompt.

## Related canon

- [[walmart-listing-integrity-platform]]
- [[walmart-listing-integrity-checkpoint-2026-07-21]]
- [[product-catalog-architecture]]
- [[product-truth-operator-runbook]]
