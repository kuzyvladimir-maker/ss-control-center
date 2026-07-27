# Walmart Listing Integrity — execution checkpoint 2026-07-21

## 2026-07-22 Phase 6A source update

- Fresh exact-window ITEM v6 read-only evidence is independently verified as
  `ABSENCE_ONLY` under evidence family
  `fdd883fbe5db6067545a010e0b7df4dce7122803f535f0c0b0a2676313f41e57`.
- Actual external effects were OAuth `1` + reportRequests GET `1`; report-create
  POST, retry, cursor, model, DB and listing writes were all `0`.
- The password-free delegated source authorization, one-shot executor and
  capture-session regression suite pass **68/68** focused tests and targeted
  ESLint. The renewal artifact SHA is
  `0c203bef0b14f199c6eca33560257adbf8baf4d17721950a6dfd765333be64a5`.
- The password/private-key requirement for the source-only test is retired. One
  bounded report-create attempt was made at `2026-07-22T12:04:44.047Z`; Walmart
  returned deterministic `HTTP 429` with no request ID. The authorization is
  terminal, retries were `0`, and model/DB/listing writes were `0`.
- Two exact-SKU fall-forward controls then exercised the real seller/catalog/PDP
  path without waiting for a complete ITEM report. `FaisalX-1130` exposed and
  fixed an algorithm false-positive on `Flavor=Grain`. `FaisalX-1183` exposed a
  real quantity-confusion defect: `Pack of 6` in title versus one visible package
  in MAIN. Its proposed exact six-package MAIN clears the image blocker offline.
  Expanded detector/exact-resolution/PDP suite = **37/37 PASS**; Walmart listing
  writes = `0`.

> **Status:** phases 0–6 are complete, including two separately authorized
> one-SKU live canaries with fresh Qualification PASS and factual galleries.
> Phase 7 permanent operations is in progress. Automatic/mass apply remains
> **NO-GO**. This is an
> operational checkpoint, not a replacement for
> [[walmart-listing-integrity-platform]] or [[product-catalog-architecture]].

## Owner goal

Repair the Walmart catalog so that the exact shipped product, variant, package
facts and quantity agree with title, description, bullets, attributes, MAIN and
every gallery image. A repair is complete only after a fresh buyer-facing reread
proves the corrected unified listing while `PUBLISHED`, `ACTIVE` and search
indexability remain intact. The operating objective is to eliminate avoidable
quantity/product-confusion returns, not merely to publish replacement images.

## Permanent owner workflow-visibility rule

Every non-trivial continuation of this work must show the owner, in chat:

1. the preserved final goal;
2. the complete phase checklist;
3. the one current in-progress phase;
4. completed phases marked `[x]` and remaining phases marked `[ ]`;
5. a milestone update after each completed phase, including test counts,
   external effects and the exact next phase;
6. an explicit distinction between local engine readiness, read-only pilot
   readiness, canary readiness and mass-run readiness.

Long streams of commands or code are not a progress report. The checklist must
be updated before starting the next phase and repeated at every handoff or
pause, so subscription usage and remaining work are visible to the owner.

## Master execution checklist

- [x] **Phase 0 — Goal and authority boundary.** Canonical architecture,
  checkpoint, owner gates and mass-run prohibition are explicit.
- [x] **Phase 1 — Safe one-SKU core.** Audit, changed-fields-only surgical
  payload, one-shot writer, durable permit ledger and baseline Qualification
  Officer exist and fail closed.
- [x] **Phase 2A — Durable custody.** Concrete ledger adapter, content-addressed
  immutable artifact custody and route-bound HTTP receipt v2 are implemented.
- [x] **Phase 2B — Exact image certification.** MAIN/gallery bytes, order,
  Product Truth lineage, represented count, rights and signed vision-worker v2
  evidence are verified locally; mixed/variety composition remains fail closed.
- [x] **Phase 2C — Certificate-to-write binding and stabilization.** Exact image-certificate SHA is
  bound by the signed one-SKU permit, surgical manifest and immutable PREPARED
  artifacts. Final READY and Product Truth are reread after asynchronous
  certificate verification, and the exact byte chain is proven with output
  from the real certificate producer.
- [x] **Phase 3 — Custody-only apply evidence and temporal stabilization.** Qualification rejects
  caller-supplied legacy apply bytes and loads the exact surgical request, accepted
  POST, terminal feed, ledger HEAD and support artifacts only through custody;
  caller-supplied qualification time is rejected. Custody proves that `CLAIMED`,
  `REQUESTING`, POST response and `ACCEPTED` remained inside the permit window,
  and revalidates the image certificate at the POST evidence timestamp.
- [x] **Phase 4 — Closed Qualification loop.** The complete offline
  `detect → plan → repair → fresh reread → qualify` cycle, including adversarial
  failures and same-SKU no-write propagation rechecks, is proven through the
  real source-aware compiler/verifier and strict control-artifact parsers.
- [x] **Phase 5 — Frozen production closure.** The fixed dependency factory,
  native zero-retry transport, operator commands, verified launcher and
  clean-checkout release artifact are sealed. Exact
  substeps:
  - [x] 5.1 close the cross-process artifact-inventory race with an atomic
    inventory boundary/lock and end-of-scan equality proof;
  - [x] 5.2 freeze the dependency factory and native one-shot, zero-retry
    transport without caller-injected production dependencies;
  - [x] 5.3 expose bounded operator `doctor → plan → execute/resume → status →
    report` commands with fail-closed `next_command`;
  - [x] 5.4 reproduce the complete release from a clean checkout, seal its
    exact source/tests/runtime/artifact hashes and smoke-test the external
    verifier-wrapper against the sealed manifest.
- [x] **Phase 6 — Controlled proof.** Run a read-only pilot, then only 1–3
  separately owner-approved live canaries. The next SKU remains blocked until
  the current one reaches fresh Qualification PASS.
  - [x] 6A.1 certify the source/observer boundary;
  - [x] 6A.2 freeze the bounded pilot selection and stop conditions;
  - [x] 6A.3a capture and independently verify a fresh exact-window absence
    probe with zero report-create calls;
  - [x] 6A.3b bind the dynamic probe to the frozen incident baseline and replace
    the unnecessary password/key step with bounded source-only authorization;
    - [x] seal and byte-verify the dynamic renewal evidence;
    - [x] certify the no-password delegated authorization and one-shot executor;
    - [x] retire owner password/private-key setup from report acquisition;
  - [x] 6A.3c retire the ITEM v6 report dependency for one-SKU fall-forward
    after the bounded `429`; exact seller/item/spec/PDP evidence became the
    authoritative per-SKU source and no report-create retry was needed;
    - [x] first one-shot attempt ended safely with deterministic Walmart `429`;
    - [x] do not create a successor ITEM session for canary execution; the
      exact-SKU source lane proved sufficient and prevented another catalog-wide
      report dependency;
  - [x] 6A.3d run two bounded exact-SKU fall-forward controls and preserve the
    first real current defect (`FaisalX-1183`, MAIN 1 vs expected 6);
  - [x] 6A.4 run the bounded visual observer and independent Qualification;
    - [x] preserve exact current/target bytes and build the exact two-call shadow plan;
    - [x] add an offline verifier for request bytes, call keys, worker-ledger
      identity, Ed25519 receipts, blind observations and deterministic decisions;
    - [x] prove fail-closed handling of a malformed response with no attestation output;
    - [x] execute exactly two owner-approved subscription calls and verify their
      signatures and effects accounting with no retry/fallback/Walmart writes;
    - [x] replay signed observations against comparator v5: current MAIN `BAD`,
      target MAIN `PASS`, gallery BAD `0`, gallery REVIEW `2`;
    - [x] persist the exact bundle and make the Command Center loader reverify all
      file hashes, both Ed25519 receipts and tamper fail-closed before display;
    - [x] owner visually accepted the target MAIN and both REVIEW gallery images on
      `2026-07-22`; immutable review artifact SHA =
      `919b85f1571e5b229e160957b6c9015c796c4b3ee84ad11051a3a2fa768c480b`;
  - [x] 6B repair and freshly requalify one owner-approved SKU at a time.
    - [x] replace the exposed owner-key ceremony with a password-free local
      service key behind the canonical ordinary exact-diff confirmation flow;
      frozen release v2 `doctor` returns `READY` with one enrolled public key;
    - [x] expose the upstream Product Truth state in Listing Integrity from a
      SHA-bound readiness snapshot; UI confirms all eight migrations applied and
      reports the exact SKU-level truth blockers while keeping execution-package,
      one-SKU write and mass-run gates closed;
    - [x] render one owner-facing `Сейчас → После исправления` gallery for
      `FaisalX-1183`, with current/proposed MAIN shown side by side, the complete
      live gallery, exact description/bullet diff and explicit unchanged fields;
      artifact SHA `1a4ca270…d1b57`, Walmart writes `0`;
    - [x] build a four-SKU owner calibration pool against the updated title/content
      rules: two exact text-repair previews (`FaisalX-1181`, `FaisalX-1183`) and
      two no-mutation controls (`FaisalX-1130` for `15 Grain` vs Pack Count,
      `FaisalX-1208` for legitimate `Hamburger Buns`). Both repair targets pass
      the pure Product Truth precheck; all 12 original buyer image bytes are
      SHA-verified and all 20 gallery references resolve. Focused title/
      Qualification tests `14/14`, targeted ESLint PASS, Walmart writes `0`.
      Pool SHA `1fa045a4…ff44`; gallery SHA `a8e19bc5…c555`; gallery explicitly
      distinguishes unchanged product-first title from quantity-first
      description/bullet copy;
    - [x] owner visually approved the exact four-SKU calibration pool on
      `2026-07-26`; first canary target is `FaisalX-1183`; this review authorizes
      no write by itself;
    - [x] rebuild the refined `FaisalX-1183` review/certification/compilation
      request without reusing the old hash: review file SHA `1c66873a…1c548`,
      certification file SHA `af08b766…97089`, request file SHA
      `3df3e4e4…d95cc`, request body `9d06498e…127f3`; changed fields are exactly
      description/bullets and title/images remain unchanged;
    - [x] receive the request's exact owner confirmation on `2026-07-26`;
    - [x] stop the first v4 package attempt before OAuth on a real compiler
      defect: normalized request dropped legitimate zero-effect `assurance` and
      then failed its second SHA verification; package/network/model/DB/Walmart
      writes all remained `0`;
    - [x] fix the assurance preservation/exact-schema bug, add the repeat-verify
      regression and seal release v5: clean commit `041a8549…a2a`, tree
      `884c3cab…9926`, release ID `e561faa3…1c12d`, manifest
      `ab55cc1f…13667`, suite `136/136`, ESLint/diff-check PASS; both owner and
      frozen-wrapper doctors are `READY` with zero effects;
    - [x] calibrate the second real production boundary: v5 item capture returned
      the current `mart: "WALMART_US"` + `wpid` seller shape without numeric
      `itemId`; v5 stopped after OAuth `1` + reads `2`, retries/content writes `0`;
      v6 now accepts both observed item identity shapes with exact seller identity
      checks and is sealed as release `8a453e96…239d6`, manifest
      `0b15288b…20583`, suite `136/136`, ESLint/diff-check PASS;
    - [x] build and frozen-plan the fresh v6 package: execution package
      `2cfbcf62…1545`, request payload `ce08e24b…0ddd`, plan receipt
      `3828217f…1377c`, status `READY_TO_EXECUTE_ONE_SKU`; title/images/price/
      inventory/status unchanged and Walmart content writes remain `0`;
    - [x] receive the final exact apply confirmation for payload
      `ce08e24b…0ddd`, limited to description/bullets;
    - [x] stop the v6 execute before network/POST with zero Walmart writes:
      terminal `FINAL_PRE_SEND_GATE_FAILED`, `feedId=null`; prove the wrapper
      process lacked store1 credentials and never reuse consumed authorization
      `82848f56…7094`;
    - [x] move credential/account preflight before artifact persistence and
      permit burn, preserve bounded dependency error codes, bind the approved
      product-first title-order check and seal v7: commit `5d7027d6…b986`, tree
      `ffcd7fd8…b5855`, release `bd0f903e…f24100`, manifest
      `db1f3b39…09c26`, suite `137/137`, ESLint/diff-check PASS;
    - [x] build and plan one fresh v7 package, prove the same exact request
      payload SHA `ce08e24b…0ddd` and execute only this one package once;
      Walmart accepted the only POST with HTTP 200 and feed
      `18C5F5E0D07A5E6BB8B1380E4B6C6018@AX8BBgA`;
    - [x] prove the post-acceptance ledger defect (`@` rejected by the generic
      safe identifier), add the exact regression and seal v8: commit
      `7861c2dc…81913c7`, tree `6bb3049a…ad2b6`, release
      `63cf3a86…e34377c`, manifest `5e8484df…27fcc2`, suite `139/139`,
      ESLint/diff-check PASS;
    - [x] finish bounded GET-only reconciliation of the accepted feed, then
      fresh buyer reread, Qualification and factual `До → После`;
      sealed v9 `resume-recovered` (release `bba76d69…ca96fb2`, manifest
      `c84bc8da…96f676`, suite `139/139`) can continue only the same accepted
      predecessor feed without a new permit or POST;
      v10 clamps it to one GET/run (release `bb6c5666…8a27c08`, manifest
      `0fe5cb07…cc27e0d`); fresh buyer capture at `2026-07-26T22:35:43Z`
      still shows the old description/bullets and unchanged title/images, so
      Qualification is honestly `PENDING_PROPAGATION`; the next sealed v10
      one-GET at `2026-07-26T23:03:25Z` remains
      `APPLIED_PROPAGATING / FEED_NOT_TERMINAL` with OAuth `1`, feed GET `1`,
      maintenance POST `0` (receipt SHA-256 `f134cb1f…47f8e82`);
      the next v10 GET reached terminal `SUCCEEDED` at `2026-07-26T23:37Z`.
      Frozen v11 adds an executable fresh-live `qualify` gate (release
      `dbb14ad1…ffe97ac`, manifest `d32dfa46…624c65`, clean suite `142/142`);
      authoritative Qualification at `2026-07-26T23:57Z` returned `PASS` on all
      14 facets with Walmart writes/model calls/DB writes `0`, and explicitly
      unblocked the next SKU. Receipt file SHA-256 `42ffd0d3…02b7c6`,
      Qualification body SHA `6183c327…d1b47`. Final factual gallery checks
      `17/17 PASS`; gallery body SHA `f677d6b9…b75d6`.
    - [x] prepare the second canary review for `FaisalX-1181` from a fresh
      `2026-07-27T00:01Z` read-only capture. All three current image SHA-256
      values match the previously owner-approved calibration, so no repeat
      model call was consumed. Frozen review file SHA `8e6e4e21…7dc48`,
      certification file SHA `dc0ac3ce…f6706`, compilation request file SHA
      `fbdac9c5…9a678`; Qualification precheck and Command Center loader tests
      pass, Walmart writes `0`;
    - [x] receive the exact owner review confirmation for `FaisalX-1181` and
      compile a fresh one-SKU package through the frozen v11 boundary. The
      package retains only the approved `description`/`bullets` mutation,
      omits title/images/price/inventory/status and every unapproved attribute,
      and has execution-package SHA `482132e3…e7a98`. Frozen plan receipt SHA
      `6caa9ad5…de43` is `READY_TO_EXECUTE_ONE_SKU`; exact request payload SHA
      is `d89b1f70…7bcd5`. Package reads were OAuth `1` + Walmart reads `2`,
      retries `0`, model/DB/Walmart writes `0`. A separate exact execute
      confirmation was received before the sole POST;
    - [x] submit the second canary exactly once. Walmart accepted payload
      `d89b1f70…7bcd5` as feed `18C609204E4D5112A3E3306F577A50DA@AX8BBwA`;
      maintenance POSTs `1`, retries `0`, item failures `0`. The initial bounded
      poll ended `APPLIED_PROPAGATING`;
    - [x] close the discovered `20m poll > 15m doctor/permit` continuation
      deadlock without replay. Frozen v13 release `6c74f28d…0c42c0`, manifest
      `fb912f22…639041`, clean suite `142/142`, ESLint/diff-check PASS. Its
      normal resume is one exact GET, accepts only current/v11 package bindings,
      rejects stale doctor/plan flags and has no POST authority. First v13
      continuation receipt SHA `35fd9426…8732` remains
      `APPLIED_PROPAGATING / FEED_NOT_TERMINAL`, continuation writes `0`.
      Bounded follow-ups through `2026-07-27T05:04:19Z` remain the same
      non-terminal state; the latest raw Walmart payload is `INPROGRESS`,
      `itemsReceived=1`, `itemsProcessing=1`, `itemsFailed=0`,
      `internalItemStatus=DP_MODEL_INREVIEW`. Latest receipt SHA
      `4dd9b682…c8b2f26`; every continuation used one feed GET with POST `0`
      and Walmart writes `0`. No replay occurred. The next sparse same-feed GET
      reached terminal `SUCCEEDED` at `2026-07-27T12:09:26Z`; receipt SHA
      `68c6535d…5f6947`, one GET, POST `0`, Walmart writes `0`. Frozen fresh-live
      Qualification at `2026-07-27T12:11:20Z` returned `PASS` on all 14 facets,
      including exact description/bullets, pack count, product/variant,
      published/indexed, unchanged title/images/attributes and exact image
      bytes. Qualification receipt SHA `3ccb0045…5f1d49`, body SHA
      `f231a6bc…758fcb`; Walmart/model/DB writes `0`, and the next SKU is
      unblocked. The factual `До → После` builder is now SKU-agnostic and bound
      to the frozen Qualification receipt; `FaisalX-1181` final gallery is
      `18/18 PASS`, body SHA `51fb1ada…68a957`, HTML SHA
      `12d63964…36c19`.
- [ ] **Phase 7 — Permanent operations.** Add Walmart Growth → Listing Integrity
  UI, scale-certified ledger and controlled waves. No automatic mass apply.
  - [x] 7.1 add the first read-only shadow tab with current/proposed images,
    exact diff, evidence limitations and locked live/mass gates;
  - [x] 7.1a preserve exact current MAIN/gallery bytes and the target MAIN in a
    SHA-bound MAIN-only canary preview consumed and reverified by the tab;
  - [x] 7.1b render fail-closed Product Truth readiness and the exact shared-plan
    identity in the permanent tab; execution-package/write/mass authority remain
    independent, self-asserted `READY` is rejected, loader 7/7 and UI 1/1;
  - [x] 7.1c revalidate Walmart title ordering against official guidance and add
    a deterministic standard-grocery gap for a leading `Pack of N`/`N-Pack`/
    `N Count`; searchable brand/product identity precedes variant/attributes and
    outer Pack Count, exact current Product Type spec retains hard-limit authority,
    content validator plus future-release Qualification precheck focused 13/13
    and targeted ESLint PASS; `FaisalX-1183` title remains unchanged;
  - [ ] 7.2 connect persistent API/state store, scheduler and resumable queue;
    - [x] 7.2a add a deterministic read-only pool builder bound to exact census/
      scan-plan bytes, final Qualification galleries and one `WalmartSkuPerf`
      read. Pool `controlled-pool-e52405490b8ea6604dfd` contains ten new SKU,
      excludes both completed canaries, has strict sequence/max apply in-flight
      `1`, and grants no Walmart/model/paid-provider authority. Pool file SHA
      `14301478…b8783c8`;
    - [x] 7.2b add a fail-closed operations loader plus GET-only API and retire
      the legacy QC POST that could enqueue an unconstrained A-to-Z rewrite in
      `WalmartRemediationQueue`; the retired route now returns HTTP `410`;
    - [ ] 7.2c persist per-SKU state transitions and connect the default-OFF
      scheduler/resumable worker to the frozen one-SKU operator. Unknown POST
      outcomes remain non-replayable and max live apply in-flight remains `1`;
  - [x] 7.3 wire the complete factual post-canary `До → После`, fresh
    Qualification and published/indexing status into the persistent Command
    Center screen. Both final galleries are served through exact-SKU internal
    routes, the screen shows `18/18 PASS` for each canary and the ten-row pool,
    and contains no mutation form. Operations/route/UI focused tests `9/9`,
    TypeScript, targeted ESLint and production build PASS.

## Phase 0–5 verification

- combined remediation authority/payload/writer/ledger/custody/image/apply/
  qualification/closed-loop/native-transport/operator/wrapper suite:
  **136/136 PASS**, **0 failed** in both the working projection and the clean checkout;
- targeted ESLint: **PASS**;
- `git diff --check`: **PASS**;
- independent final audit: **0 Critical, 0 High and 0 Medium** findings for the
  Phase 4 boundary;
- an adversarial certificate drift after durable `REQUESTING` produces terminal
  `FAILED` with **0 transport opens, 0 OAuth calls and 0 Walmart POSTs**;
- the closed-loop proof uses the real source-aware report compiler/verifier,
  real run-lock/preflight/Ed25519 permit parsers and a fail-fast network tripwire;
  its three transport observations are deterministic in-memory test doubles,
  not external calls;
- external effects during this continuation: **0 network calls, 0 model calls,
  0 database writes and 0 Walmart content writes**.

The current sealed release is
`release-artifacts/walmart-listing-repair-engine-2026-07-23-v2`:

- normalized runtime release ID:
  `0d21ffcd5bf55c6e781daba80b3a750613f2d21bb89690a73ccbd66326aa246d`;
- clean Git commit: `9e737e4b0aba7464c89e7769552552353e657ae2`;
- clean Git tree: `2c58cfe99594e6ea88c8925f2247b62bbc2c08af`;
- final manifest SHA-256:
  `387d4093e86a35a200304cbad4a92cd9ef75204ad936e562641f6e17c3da7c74`;
- final manifest: `evidence-final-v2/release-manifest.json` (`0400`), with
  private `0700` evidence directory and exact certification logs;
- verified-wrapper smoke receipt:
  `data/audits/walmart-listing-integrity-fresh-controls/FaisalX-1183-20260722T122025Z/live-canary-v2-20260723T0135Z/doctor-receipt.json`, SHA-256
  `bb87e2840f2f75dabd55c6860295175cd416bc29a6abc4e4113629cc76710bd6`;
- production Product Truth schema gate is closed: exact v3 approval was consumed once,
  all 8 migrations are applied/tracked, both ledgers are ready and an independent
  post-commit plan has no blockers. Schema after SHA-256 is
  `8c9fc783e53fe4a94b7433eb1b06ac8b36ce03226100bfe4500d3e896367d511`;
- current runtime blocker moved to SKU-level canonical truth. A read-only point query
  for `walmart:1:FaisalX-1183` through Product Truth contract `3.2.0` returns
  `LISTING_SCOPE_NOT_REGISTERED` and `CURRENT_SCOPED_SKU_COST_MISSING`. No business-data
  backfill or marketplace write was performed.
- exact legacy donor audit proves the current component is incorrectly linked to
  Pepperidge Farm Chessmen Butter Cookies. The matching buns donor remains
  `legacy_unverified` and cannot be promoted manually. Existing fresh Amazon all-listing
  reports for store1/store3/store5 were downloaded read-only and sealed; store2/store4
  still need owner connectivity disposition and Walmart store1 still needs a fresh
  owner-authorized ITEM v6. The consolidated review packet is
  `ss-control-center/data/audits/product-truth-source-readiness/faisalx-1183-20260723T014559Z-codex-v1/OWNER_REVIEW.md`.
- a subsequent one-shot GET-only Walmart list probe covered the full latest 24-hour
  window and found ten ITEM v2 requests, zero v6. It used one OAuth token call and
  one GET with zero retries, report creates or listing writes; the exact response
  SHA-256 is `33e43fad59fe1eb45fa76a3ef06c73d3d375b8457c32f3a8fb50e50385aceebb`.

The earlier release evidence is explicitly renamed
`INVALID-evidence-pre-git-root-wrapper-fix`; it must never be used.

Independent review deliberately reopened Phase 2C because the isolated green
tests did not yet prove the real certificate producer end to end, and mutable
READY/Product Truth snapshots were taken before an awaited certificate check.
Both Phase 2C findings are now closed. Qualification also rejects legacy raw apply
bundles, caller-authored `qualified_at`, stale custody references and forged
verified-proof bindings. A subsequent Phase 3 audit reopened the historical
timestamp proof; it is now closed. The real offline cycle now proves an initial
BAD report, one exact repair, propagation without a duplicate write, a fresh
buyer-facing PASS and advancement eligibility only after Qualification PASS.

The cross-process artifact-inventory append race is closed by an OS-visible
exclusive custody-operation lock and a final complete-inventory rescan. The
production writer now accepts one snapshot-safe data package only; payload,
exact-byte verification, ledger, artifact custody, image certificate and the
native transport are selected by one fixed factory. The transport performs at
most one OAuth call, one maintenance POST and bounded exact-feed GETs, with zero
redirect, retry or token refresh. Mixed/variety composition remains fail closed
until its exact Product Truth and image-composition contract is certified.

## Current hard boundary

Phase 5 correctness is not permission to execute. The bounded operator
`doctor → plan → execute/resume → status → report` is now callable only through
the manifest-verifying clean-checkout wrapper. Its smoke `doctor` honestly
returns `NO_GO` because no fresh authoritative ITEM v6 report has been created
for the read-only pilot. The
fresh incident-window absence probe and its frozen R4 renewal binding are
complete and verified, but neither is a catalog report and neither contains
listing rows. The first bounded source attempt returned deterministic Walmart
`HTTP 429`, no request ID and zero retries. Two bounded exact-SKU buyer controls
have now run: one negative control caught an algorithm false-positive and one
real defect correctly produced `BAD`. The fresh current image evidence is not yet
a sealed source-aware Qualification artifact, and no one-SKU repair has been
approved. Claude Code
remains an operator of the frozen suite, not an engine author or a substitute
approval authority. The next technical action is one sealed source-aware visual
and gallery pass for the exact controls; a later complete-catalog source session
can resume after Walmart's report-request rate bucket permits it. No owner password
or key setup is required. Live canary and mass run remain separate later gates.

The exact Phase 6 source order, six-shard budget, stop conditions and owner
decision are frozen in [[walmart-listing-integrity-phase6-pilot]].
