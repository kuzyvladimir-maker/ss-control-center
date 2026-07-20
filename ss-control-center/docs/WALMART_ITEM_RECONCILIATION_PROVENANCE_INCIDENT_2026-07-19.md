# Walmart ITEM request reconciliation provenance incident — 2026-07-19

## Status

`QUARANTINED / DO NOT ADOPT THE RETAINED FINAL RESULT`

The original ambiguous ITEM v6 report-create state remains authoritative. A
concurrent process of unknown provenance later added a read-only list-request
exchange and then promoted that exchange offline through a transient code path.
The promotion is contradictory to the retained terminal failure and is not
trusted.

No Walmart listing mutation, report-create retry, request ID adoption, database
call, model call, or original `REQUEST_COMPLETE` transition is evidenced by
this reconciliation chain.

## Timeline (UTC)

- `2026-07-19T03:57:17.129Z`: original one-shot ITEM v6 create request was
  reserved.
- `2026-07-19T03:57:17.185Z`: the create network outcome became
  `MANUAL_REVIEW / AMBIGUOUS_POST_NETWORK_OUTCOME`; retry remained forbidden.
- `2026-07-19T04:34:55.704Z`: an unidentified concurrent process created a
  reconciliation scope for the exact `2026-07-19T03:55:00Z` through
  `2026-07-19T04:00:00Z` submission window.
- `2026-07-19T04:34:56.455Z`: Walmart returned HTTP 200 to the read-only
  `GET /v3/reports/reportRequests`. The sealed body was the observed US empty
  envelope: page 1, limit 0, totalCount 0, zero requests, no nextCursor.
- `2026-07-19T04:34:56.455Z`: the then-current parser retained terminal
  `PARSE_REVIEW_REQUIRED / PAGINATION_INCOMPLETE`.
- `2026-07-19T04:41:24Z`: a second unidentified concurrent execution used a
  transient offline-reparse implementation to add `CAPTURED` and final
  `ABSENCE_ONLY` artifacts on top of that terminal failure.
- After discovery, the complete real session was changed to read-only mode.
  Nothing was deleted or rewritten.

## Custody facts

The four original custody artifacts remained byte-identical:

- create manifest: `fdd21b9cd0028845d96d0b395443195334d37dfbd0809ac75a44931fe85011b9`
- request reservation: `21a099d748e9efa214c251c44f708412a8094932f226a2095314eda817ae6eb9`
- manual-review checkpoint: `91db33f675c07f8b91fe56f33d2d447cf2510d43d48a157778bb4058b900eeb2`
- SessionAuthority: `ec2072fce757fabb0c7cb4ef8e995c9df7be46c127a9c618334aded0a9dcd86e`

The retained read-only GET evidence is useful but not sufficient to overwrite
the terminal state automatically:

- request manifest: `28730ec71da8a73ba9dd4da95bfcbcf9d667342e737668311c12333c40841636`
- response body: `fe1f5edce085101e740636b9a577fa1bdee5c36c33c4971f743cb18933249873`
- HTTP metadata: `9eb0d689c7b9529ade16c232f76ea0a4dfae8213c146287ee634a770cb2139f3`
- exchange seal: `6ac19bcba7cc4314a14f12044c42da491fd2b96d9c785ce56e5f280173214db4`
- terminal failure: `edec40ff96882f659d18b4d3b1e1a4d8407f78f22f6ac126fd8f97f214afb3fc`

The later conflicting promotion must not be consumed as authoritative:

- conflicting page completion: `5f84cc242d13d906595d4ae44594834ab9cd628c919bb8ea7192af90008ee011`
- conflicting final result: `d0a18766a6509d83467d9b8bac4def2e9c7551c9019c782fc46bd23f65950d1a`
- conflicting final checkpoint: `d2b1aef9e5d0fc6be9b6e5d5ef3b73a43a5ab27e14589fedeec34b2773a063a4`

## Current fail-closed rule

The sealed production reconciliation code now:

- accepts the observed empty US envelope only in a fresh, internally
  consistent state machine;
- requires canonical request, exact durable `RESERVED`, response/HTTP/seal,
  exact `CAPTURED`, and exact final checkpoint custody;
- treats every retained failed checkpoint as permanently terminal;
- never upgrades a terminal failure through offline reparsing;
- never retries the ambiguous original create POST or adopts a candidate
  request ID.

## Post-probe containment correction

A later independent audit found that the then-current read-only reissue loader still
accepted the prohibited conflicting completion/result as an `ABSENCE_ONLY` permit
basis. This was reproduced locally against the real quarantined session: it returned
result `d0a18766…` and completion `d2b1aef9…`. The documentation was stricter than the
executable verifier.

The verifier has now been corrected so any retained reconciliation page-failure
checkpoint is permanently terminal and raises
`RETAINED_TERMINAL_PAGE_FAILURE`, regardless of later `CAPTURED`, result, or final
checkpoint files. The real session now fails with that exact code. The production
capture CLI also hard-retires live request phase v1 before reading owner artifacts or
credentials and before any filesystem/network side effect. This is containment, not a
new authorization.

Current containment hashes:

- evidence loader: `bb2650ae0f8b6bc8bb48363434205d9398700eea76230eed9ee89d4f9b3c320c`
- evidence tests: `6ba5673075b5edd2aa3907619729ea78b4fc0072a8058c5c2b59701d383457e2`
- production capture CLI: `85f30b2415fc89cface53911d3ea66b3a161e8486e13a46d9474a012b69483ec`
- capture-session tests: `6ead1b661ac7e46181d2feefae2cc646f4c297de0c9ed3f8df09fb89b2cc1f60`

Focused evidence, capture-session, and permit suites pass 43/43. No network, model,
database, or Walmart call was made during this correction.

Historical reconciliation file hashes, superseded by the containment above:

- module: `f4b8540f438c410fbff8842dd4600951d22c6868972684c5127d78ccd2399891`
- tests: `6d3bfab4f778db3f3469fb92ec4585a0bb82140d5eba07dafbedfa2ce4ab6ed0`
- CLI: `ce00934c7bc983d794a74826f6a9d89d913c554f4d3eb3aecbc30b0caf242333`

The module, tests, CLI, and real incident session are read-only pending an
explicit owner disposition. Do not make another network request from this
session and do not delete the contradictory evidence.

## Provenance conclusion

The process identity could not be proven after completion. All agents in the
active listing-integrity tree denied running the live reconciliation or editing
the real session. Multiple independent Codex/Node sessions were active against
the same workspace at the incident time. Treat cross-session concurrent work as
the leading hypothesis, not as established attribution.
