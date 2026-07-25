# Walmart Listing Integrity — Phase 6 controlled proof

> **Status 2026-07-22:** the source-only test no longer requires an owner
> password or private key. The password requirement was an unnecessary
> implementation detour and is retired for report acquisition. A bounded
> delegated authorization was verified locally and used for exactly one ITEM v6
> create attempt. Walmart returned deterministic `HTTP 429`; no request ID was
> created, no retry was made and no listing was changed. Two bounded exact-SKU
> fall-forward controls then proved the real seller/catalog/PDP route without
> waiting for the report bucket: one caught an algorithm false-positive and one
> found a real current MAIN 1-vs-6 quantity defect. The sealed source-aware visual
> Qualification step remains incomplete; no listing has been changed.

## Purpose

Prove the production detector against a small set of **current buyer-facing
listings** before any live repair. The pilot is not a reduced definition of the
catalog goal and is not evidence that the remaining catalog is clean.

The pilot must exercise the same complete listing surface that the permanent
program will use: exact shipped product/variant/count, title, description,
bullets, attributes, MAIN and every ordered gallery image.

## Current proven code boundary

- remediation/Qualification release: clean-checkout **109/109 PASS**, release
  `632bb723…8cc8d8`, manifest `b42c3dc5…f618df`;
- read-only freezer/observer/adjudicator: **56 PASS, 0 FAIL, 1 sandbox-only
  loopback skip**; it has no Walmart/database clients in the audit path;
- the password-free delegated source authorization, one-shot executor and
  capture-session regression suite: **68/68 PASS** with targeted ESLint PASS;
  it burns authorization before OAuth, makes at most one create POST, never
  redirects/retries, and cannot authorize listing writes;
- the historical real-image golden set remains `algorithm_go=true`: all 12
  known-BAD cases were detected in all three layouts, with zero false `PASS`,
  zero false `BAD` and zero technical errors;
- fresh exact-SKU controls now cover `FaisalX-1130` and `FaisalX-1183`.
  The first exposed and fixed the broad-attribute false-positive; the second
  correctly returns `BAD` for title `Pack of 6` with one visible package in MAIN.
  The expanded detector/exact-resolution/public-PDP suite is **37/37 PASS** and the real
  control artifact is
  `ss-control-center/data/audits/walmart-listing-integrity-fresh-controls/FaisalX-1183-20260722T122025Z/manifest.json`;
- remote image worker identity reported by the operator remains build
  `fed5fa5e…`, reservation ledger `2c53fa5f…`, epoch `986b9a13…`; it must be
  authenticated and rechecked before execution.

These results prove code behavior and two current exact-SKU facts only. They do
not provide the complete current catalog denominator or authorize writes.

## Why model execution is not ready yet

The workspace has no fresh authoritative ITEM v6 report for the complete
current `PUBLISHED` population. Legacy v2 cron rows, the historical 743/282
repair cohorts and seller-generated titles/images are risk evidence, not the
current denominator or Product Truth.

The prior ambiguous ITEM-v6 create is retained as `AMBIGUOUS_POST_NETWORK_OUTCOME`.
The independently sealed R4 exact-query evidence found no API-visible v6 request
in that original window, but it does not prove non-delivery. A new renewal
contract binds those frozen incident facts to the fresh 2026-07-22 exact-window
probe. The owner explicitly authorized the bounded test and rejected the added
password/private-key ceremony. A source-only delegated authorization now binds
the exact account, engine, source evidence, replacement session, ledger and
freshness window without granting any listing-write authority.

## Phase 6A fresh-probe evidence — complete

The reusable operator command is
`scripts/capture-walmart-item-v6-absence-probe.mjs plan|execute|inspect|verify`.
Its focused suite is **5/5 PASS** and targeted ESLint/diff-check pass. It has no
report-create command and durably reserves its only GET before transport.

The successful isolated evidence root is:

`ss-control-center/data/audits/walmart-source-intake/item-v6-absence-probe-store1-20260722-codex-v2/`

- verified outcome: `ABSENCE_ONLY`;
- observed at: `2026-07-22T06:39:07.290Z`;
- 24-hour operational freshness deadline: `2026-07-23T06:39:07.290Z`;
- evidence-family SHA-256:
  `fdd883fbe5db6067545a010e0b7df4dce7122803f535f0c0b0a2676313f41e57`;
- result artifact SHA-256:
  `3f2beddc1cfba748f3f8793950e7a043115f30d695bc4bda1b3c23a19dab4f74`;
- actual calls: OAuth `1`, exact `GET` `1`, report-create POST `0`, retries
  `0`, cursor calls `0`, model/DB/listing writes `0`.

An earlier `...-codex-v1/` directory is retained as terminal
`TOKEN_NETWORK_FAILURE` evidence from the restricted sandbox: OAuth attempts
`1`, reportRequests GET `0`. It is not source evidence and must never be retried
or promoted.

The versioned renewal evidence is now sealed at:

`ss-control-center/data/audits/walmart-source-intake/item-v6-reissue-renewal-store1-20260722-codex-v1/source-evidence-renewal.json`

- artifact SHA-256:
  `0c203bef0b14f199c6eca33560257adbf8baf4d17721950a6dfd765333be64a5`;
- renewal release SHA-256:
  `52589f5f2266124c851d8a46204e5ae272e0b8da85eca79ef614fa88960ee78c`;
- renewal body SHA-256:
  `5c9c10f42b61e4f9599ab865e00bcd72c3226526cbdbef46e22349946966b52f`;
- frozen R4 source-evidence SHA-256:
  `3efd693468f9c0761d6091d379c06e2daddb7d8dadc908228eb282ddeab4fa31`;
- fresh probe family SHA-256:
  `fdd883fbe5db6067545a010e0b7df4dce7122803f535f0c0b0a2676313f41e57`;
- freshness deadline: `2026-07-23T06:39:07.290Z`.

The optional external signer remains available for workflows that truly require
a cryptographic owner signature, but it is not part of the source-only test and
the owner does not need to create a password or private key to acquire the ITEM
report. `scripts/walmart-item-report-reissue-v2-authority.mjs` now provides the
bounded `ledger-bootstrap` and `delegated-authorization` commands for this lane.

The first delegated attempt is permanently terminal at:

`ss-control-center/data/audits/walmart-source-captures/item-v6-store1-20260722-pilot-codex-v1/`

- one create POST, sent at `2026-07-22T12:04:44.047Z`;
- Walmart response: `HTTP 429 REQUEST_THRESHOLD_VIOLATED.GMP_GATEWAY_API`;
- request ID: none;
- retries: `0`;
- model, database and Walmart listing/content writes: `0`;
- authorization `3066bd76…bac050` is consumed and must never be reused.

## Exact Phase 6A sequence

1. **[COMPLETE] Fresh disposition evidence — no create.** Perform one bounded exact-v6
   `GET /v3/reports/reportRequests` for the original incident window and seal
   exact request/response bytes in a new isolated custody root. Stop on any
   candidate, pagination ambiguity, account mismatch or HTTP uncertainty.
2. **[COMPLETE] Renewal bridge.** Bind the fresh six-file family to the frozen
   R4 incident baseline and verify both byte families.
3. **[COMPLETE] Password-free source authorization.** Bind the exact source-only
   request to a one-shot ledger without owner credentials and explicitly forbid
   model, database and listing writes.
4. **[ATTEMPT TERMINAL — HTTP 429] One-shot ITEM v6 capture.** Make
   at most one `POST /v3/reports/reportRequests?reportType=ITEM&reportVersion=v6`.
   Burn the authorization before OAuth; no retry on any unknown outcome. Poll
   and download only the exact returned request ID. The 2026-07-22 attempt is
   terminal and cannot be reused; a later attempt requires a new session and
   authorization after the Walmart report-request rate bucket permits it.
4A. **[COMPLETE] Exact-SKU fall-forward controls.** Resolve two seller SKUs to
   exact numeric buyer items, inspect current public PDP text and all three image
   slots, run the detector and freeze the real defect regression. This does not
   replace the complete ITEM population source.
5. **Authoritative source compilation.** Compile the report into the exact
   `(WALMART_US, store_index, raw SKU)` `PUBLISHED + ACTIVE` population and
   preserve the raw report/exchange family.
6. **Shared Product Truth and buyer sources.** Read the common versioned Product
   Truth contract; do not create a Walmart-specific truth catalog. Exact buyer
   resolution must bind seller SKU → product ID/GTIN → one numeric Walmart item
   → PDP payload → MAIN/all gallery bytes.
7. **Deterministic pilot selection.** Select whole listings, never isolated
   images, in stable severity/listing-key order. When current evidence contains
   them, include:
   - one quantity-confusion/multipack risk;
   - one product/variant identity-image risk;
   - one MAIN/gallery inconsistency risk;
   - one source-verified negative control.
   Fill remaining capacity by the same stable risk order. Do not use stale sales
   or returns as a tie-breaker.
8. **Hard call budget.** Include every image of each selected listing and admit
   listings only while the complete family fits in at most **6 certified shards
   / 24 image inputs**. Never truncate a gallery to fit the budget. This is up to
   six model calls, not necessarily six SKUs.
9. **Frozen read-only execution.** Freeze exact sources, listings, image bytes,
   worker identity, deterministic shards and hard 24-hour freshness. Run offline
   `plan`, then the owner-authorized observer partition with zero retries or
   fallbacks.
10. **Independent result verification.** Run offline `audit` and `verify`; publish
   an issue register with exact evidence and separate `PASS/BAD/REVIEW/UNSUPPORTED/
   TECH_ERROR` counts. No repair plan is permitted to infer facts from a model
   verdict alone.

## Stop conditions

Stop without model calls when any authoritative scope, Product Truth row, buyer
identity/PDP/image byte, worker health binding, freshness timestamp or exact hash
is missing or changes. Stop after an ambiguous model POST and never retry it.
`REVIEW`, `UNSUPPORTED` and `TECH_ERROR` do not become `PASS`.

External-effect ceilings for the completed read-only pilot are:

- Walmart report create POST: `0 or 1`, separately owner-authorized;
- Walmart listing/content writes: `0`;
- model calls: `0..6`, separately owner-authorized after the exact plan;
- paid provider calls: `0` unless an additional explicit calibration gate is
  approved;
- database/R2 writes: `0`;
- local writes: immutable capture, attempt, observation and report artifacts only.

## Owner gates

No password or owner key is required for the source-only test. The remaining
owner decisions are intentionally simple:

1. after a successful source capture, approve the exact small read-only visual
   plan and its at-most-six subscription vision calls;
2. after the read-only report, approve one exact SKU for a live canary;
3. only after fresh Qualification `PASS`, approve the next SKU or a controlled
   wave size;
4. inspect the factual `До → После` gallery, text/attribute diff, buyer reread,
   Qualification and published/indexing status before controlled waves begin.

Live remediation remains another later gate: one SKU, one signed permit, at most
one maintenance POST, then fresh buyer reread and Qualification `PASS` before the
next SKU.

## Related canon

- [[walmart-listing-integrity-platform]]
- [[walmart-listing-integrity-checkpoint-2026-07-21]]
- [[walmart-listing-integrity-operator-runbook]]
- [[product-catalog-architecture]]
- [[product-truth-operator-runbook]]
