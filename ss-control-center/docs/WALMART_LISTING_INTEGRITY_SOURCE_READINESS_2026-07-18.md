# Walmart Listing Integrity — Source Readiness Ledger

Status timestamp: 2026-07-18 America/New_York (capture event is 2026-07-19 UTC)

## Objective

Correct every Walmart listing so the shipped product, bundle/multipack composition and quantity, title, description, bullet points, attributes, MAIN image, and every gallery image are truthful and mutually consistent. The operational outcome is the elimination of expectation-driven customer returns without sacrificing indexing.

## Current gate

`MASS_NO_GO`

The local freezer, observer, adjudication engine, external authorization, freshness gate,
and worker-ledger contract have passed the current controlled-partition certification.
A production family still cannot be frozen because the required authoritative source
artifacts do not exist. Claude BF-Images has reported a successful receipt-v2 deploy,
ledger bootstrap, restart, and authenticated health against the current contract.
The observer will recheck these exact frozen values live before any model POST. See
`WALMART_REMOTE_WORKER_OPERATOR_REPORT_2026-07-19.md`.

No model call, paid PDP call, database mutation, listing mutation, or marketplace content write is authorized by this ledger.

## ITEM v6 capture state

The only real capture session is:

`data/audits/walmart-source-captures/item-v6-store1-20260718-codex-v1`

Retained private artifacts:

- `trusted/00-session-authority.json`
- `capture/10-create-request-manifest.json`
- `checkpoints/10-request-reserved.json`
- `checkpoints/19-request-manual-review.json`

The create attempt was reserved at `2026-07-19T03:57:17.129Z` and terminalized for manual review at `2026-07-19T03:57:17.185Z` with:

- `reason_code=AMBIGUOUS_POST_NETWORK_OUTCOME`
- `retry_forbidden=true`

There is no retained create response, `requestId`, poll result, report download, compiled published source, or sanitized output. The same POST must not be retried.

Walmart documents a read-only `GET /v3/reports/reportRequests` endpoint with filters for report type, version, source, status, and submission interval. A sealed reconciliation adapter may use it to retain a candidate set. Time/type/source matching alone is not exact attribution: without an echoed unique correlation identifier, outcomes must remain `CANDIDATE_ONLY`, `ABSENCE_ONLY`, or `AMBIGUOUS`; they must never auto-adopt a `requestId` or create `REQUEST_COMPLETE`.

**Update 2026-07-19:** the bounded adapter is implemented and tested, but the only live
reconciliation chain is not authoritative. An unidentified parallel process issued one
read-only list GET and retained a zero-result envelope. The canonical parser correctly
terminalized that chain as `PAGINATION_INCOMPLETE`; a later parallel execution then
added conflicting `CAPTURED`/`ABSENCE_ONLY` files on top of the terminal failure. Those
later files are untrusted. No requestId was adopted and the create POST was not
repeated. The whole session and reconciliation source/tests/CLI are quarantined
read-only. Exact timeline and hashes are recorded in
`WALMART_ITEM_RECONCILIATION_PROVENANCE_INCIDENT_2026-07-19.md`.

A later independent operator probe queried all ITEM report requests for the preceding
48 hours and found 18 legacy v2 API requests but no v6 request, including none near the
ambiguous `03:57Z` attempt. Its newest-first first page crossed the full 24-hour cutoff.
This materially corroborates that the ambiguous POST created nothing, but the retained
raw envelope is still in operator scratch custody and the broad query is not the exact
zero-row v6-filtered shape accepted by the current permit verifier. See
`WALMART_ITEM_V6_ABSENCE_PROBE_OPERATOR_REPORT_2026-07-19.md`. No owner disposition or
replacement POST is authorized from the text report alone.

A post-probe audit then reproduced a fail-open in the v1 reissue loader: it accepted
the prohibited conflicting result/completion hashes `d0a18766…` / `d2b1aef9…`
despite the retained terminal page failure. That path has been contained. Any retained
`*-page-*-failed.json` now raises `RETAINED_TERMINAL_PAGE_FAILURE`, and the production
capture CLI hard-retires every live `--phase=request` before owner files, credentials,
session writes, OAuth, or Walmart network. The legacy catalog cron can only
poll/download an already retained request and cannot create ITEM reports.

The old hash-only reissue permit is additionally retired because its
`source_evidence_release_sha256` was not verified against actual release bytes and it
did not authenticate owner authorship. A future replacement requires a new immutable
evidence release bound to exact independent raw probe bytes plus an external Ed25519
owner disposition bound to the exact replacement request and one-shot limits. The
quarantined session cannot satisfy that gate, and no executable report-create CLI path
currently exists.

Primary references:

- <https://developer.walmart.com/us-marketplace/reference/getrequestsstatus>
- <https://developer.walmart.com/us-marketplace/docs/on-request-reports-api-overview>

### Shared-workspace source search, 2026-07-19

A read-only search of the full shared Codex/Claude workspace, including ignored and
untracked files, inspected 5,445 data-like files and found no existing Walmart Seller
Center full Item Report, ITEM v6 download, or other plausible authoritative
PUBLISHED-population export. The only generic active-listings export found was
`data/imports/Active_Listings_Report_2026-05-22.txt`; its Amazon columns (`ASIN`,
Amazon marketplace flag and fulfillment channel) show that it is not a Walmart
source. Walmart-named JSON/JSONL files are historical visual-pilot fixtures,
snapshots/replays, code tests, or the quarantined capture session described above.
Release `.patch.gz` files are code/artifact patches, not marketplace reports.

The closest local files are also ineligible: workspace-root `audit-live-listings.json`
is a 318-row partial audit, `_newwork.json` is a 2,240-row derived worklist,
`_gen_enriched_state.json` is generated state for 2,763 SKUs, `_final_audit.json` is a
743-row remediation subset, and `_reqc_published.json` is a 220-row QC subset. None has
the full store/SKU/item identity, lifecycle/publish state, and raw report provenance
required to establish the authoritative denominator.

Therefore the production family cannot be derived by rediscovering an existing raw
report in this workspace. A new independently custodied authoritative source is still
required. This search does not authorize a replacement report POST and does not alter
the quarantined session.

## Missing production evidence

No real artifacts were found for the following required schemas or gates:

- authoritative compiled ITEM v6 published source;
- approved, versioned Product Truth snapshot that dispositions every current PUBLISHED listing;
- catalog truth export compiled against Product Truth and buyer snapshots;
- exact SKU to GTIN to numeric Walmart buyer item resolution reports;
- buyer-facing PDP snapshots with title/content/attributes plus MAIN and every ordered gallery image byte;
- trusted exact 180-day performance/returns source and source-qualified prior/remediation evidence;
- Shadow-50 selection, independent human labels, conflict adjudication, model shadow results, or gallery pilot;
- production freeze spec, frozen family, or READY marker.

Existing seller WPIDs are not substitutes for numeric buyer item IDs. Legacy donor, SKU component, SKU cost, listing, or cached PDP records are not automatically Product Truth and must not be promoted to shipment truth without owner approval and revision evidence.

## Dependency order

1. **Done — code only:** build and test the sealed read-only reconciliation adapter. The quarantined live chain is not an authoritative `ABSENCE_ONLY` result.
2. **Done — containment:** make terminal reconciliation failure irreversible and retire the executable unsigned/unbound reissue-v1 CLI path. Focused evidence/capture/permit suites pass 43/43; the real quarantined session now fails with `RETAINED_TERMINAL_PAGE_FAILURE`.
3. **In progress — independent evidence:** import the operator's exact raw broad-query bytes into isolated custody and capture one exact v6/API zero-row probe for `03:55Z..04:00Z`. Neither may be written into the quarantined session.
4. **Not built:** create and certify an immutable raw-evidence release plus external Ed25519 owner-disposition/reissue-v2 contract. Only an explicit owner signature on exact fresh bytes may restore one report-create path.
5. **Blocked:** after that separate approval, complete and compile one authoritative ITEM v6 capture for the full current PUBLISHED population.
6. Build the owner-gated, versioned Product Truth workflow and disposition every PUBLISHED row as `auditable`, `truth_review`, or `unsupported`.
7. Capture trusted performance/returns evidence needed for frozen selection.
8. Resolve selected SKUs to exact GTINs and numeric buyer item IDs.
9. Perform one explicitly budgeted PDP schema calibration, then implement the production read-only PDP and image-byte capture adapter.
10. Capture title/content/attributes plus MAIN and all gallery bytes; build the sealed buyer snapshot index and catalog truth export.
11. Run Shadow-50, independent labels/adjudication, model shadow, and gallery pilot.
12. **Done — local code only:** certify engine/freezer/observer v4, external owner authorization, hard freshness, one-shot ledgers, immutable observation/attempt pairs, and canonical cross-partition path namespace.
13. **Done — operator report:** Claude BF-Images updated/restarted the remote worker, bootstrapped and pinned the ledger, and reported authenticated health with build `fed5fa5e…`. The observer will repeat authenticated health before execution; do not use old build `080d3a50…` artifacts.
14. Freeze a fresh family, issue one owner-signed one-shot partition allowance, run the six-call controlled batch, audit it, and only then consider scaling.

## Execution handoff rule

Claude Code may execute a completed frozen engine and its exact authorized partition. Claude must not invent, redesign, weaken, or silently repair the engine during the production run. Any failed invariant returns the family to engineering and requires a new sealed authorization rather than an improvised retry.
