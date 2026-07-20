# Walmart ITEM v6 absence probe — Claude operator report, 2026-07-19

Status: `CORROBORATING_TEXT_REPORT_RECEIVED / RAW CUSTODY PENDING`

This file records the operator report supplied by Claude BF-Images through the
owner in the shared VS Code workspace. It is not yet a source-evidence release,
an `ABSENCE_ONLY` artifact, an owner disposition, or authorization for another
report-create POST.

## Reported execution

- Account: store index 1 / Sirius / seller `10001624309`.
- Transport: OAuth followed only by documented read-only
  `GET /v3/reports/reportRequests`.
- Query: `reportType=ITEM`, 48-hour submission window.
- External effects reported: report-create POST `0`, model calls `0`, database
  writes `0`, Walmart content writes `0`.
- The quarantined capture session was not opened or changed.

## Reported result

- `totalCount=18` ITEM request records in the 48-hour query.
- Page 1 contained 10 records sorted newest-first, spanning
  `2026-07-19T17:02Z` through `2026-07-18T15:01Z`.
- That page crosses the reported 24-hour cutoff of approximately
  `2026-07-18T17:06Z`; page 2 contains only older records.
- Every request visible inside the 24-hour freshness window was reported as
  `reportVersion=v2`, `src=API`, with `READY` or `RECEIVED` status.
- No ITEM v6 request was observed, whether ready, received, or in progress.
- In particular, no request appeared around the quarantined ambiguous create
  attempt at `2026-07-19T03:57Z`; the neighbouring visible requests were at
  approximately `02:00:50Z` and `05:01:37Z`.

This independently corroborates, but does not by itself cryptographically
prove, that the ambiguous create attempt did not create an ITEM v6 report.

## Pagination and custody boundary

- Page 2 was not fully traversed because Walmart returned a repeating page-2
  cursor and then HTTP 429. This does not affect the operator's 24-hour-window
  observation if the advertised newest-first ordering is trusted, because page
  1 already crosses the cutoff.
- The operator reported retaining `report-requests-48h.json` and probe logs in
  a scratchpad outside the repository. Codex has not received or hashed those
  exact bytes.
- No Seller Center UI screenshots exist; the operator had no authorized UI
  session and did not attempt to sign in.

## Why this is not yet the permit basis

The current reissue verifier accepts only a sealed exact query fixed to
`reportType=ITEM`, `reportVersion=v6`, `src=API`, an exact submission interval,
and a literally empty one-page response with complete pagination metadata. The
reported broad ITEM query returned 18 v2 rows. Its human interpretation is
valuable corroboration, but it is not the exact machine shape consumed by the
current permit path.

Before any owner disposition or replacement POST can be considered:

1. preserve the reported raw broad-query envelope and sanitized request/HTTP
   metadata in a new isolated evidence root, with exact sizes and SHA-256;
2. after the endpoint rate limit permits, capture one independently custodied
   exact v6-filtered read-only GET for the original ambiguous submission window;
3. review and seal that evidence without writing into or reinterpreting the
   quarantined session;
4. present the exact disposition and risk acknowledgement to the owner;
5. only after explicit owner approval may a fresh one-shot reissue permit be
   created and consumed.

Until all five steps complete, new ITEM report-create POSTs remain forbidden.

## Subsequent engine finding

After this operator report was recorded, Codex reproduced a separate v1 verifier
defect: the loader accepted the prohibited quarantined conflicting final despite its
retained terminal page failure. The loader now rejects that session with
`RETAINED_TERMINAL_PAGE_FAILURE`, and the production CLI live request phase v1 is
hard-retired. Therefore even a future exact zero-row probe cannot be passed through
the old permit path; a new raw-evidence release plus Ed25519 owner-disposition contract
must be certified first.
