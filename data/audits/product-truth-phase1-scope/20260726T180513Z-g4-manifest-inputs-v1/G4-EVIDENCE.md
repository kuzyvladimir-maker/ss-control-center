# Product Truth G4 / Phase 1 manifest evidence

Status: `AUTHORITATIVE_MANIFEST_V3_BUILT`

Snapshot boundary: `2026-07-26T18:05:57.000Z`

## Exact implementation

- production ITEM v6 parser commit:
  `cfb410788bde34ede524da7b8ac9f20d18bdd7e1`
- Phase 1 manifest policy commit:
  `9090580ead4d57400070797236b186f9425398dc`
- manifest policy:
  `phase1-scope-builder-policy/1.3.0`
- clean Walmart report suite: `229/229`
- clean Product Truth certification: `453/453`
- TypeScript and targeted ESLint: `PASS`

## Walmart store1

- report request ID:
  `019f9f34-9bad-7390-b236-341290db319a`
- report request ID SHA-256:
  `e92d7021f5c8fb4f5e7ec877469c028f1ba4161d89cb861b6dd32a40e23b6d47`
- raw ZIP SHA-256:
  `fa858d5ca65616627acb4578097861c6abcd42fad8332d2f0378ff59baa9c56d`
- decoded CSV SHA-256:
  `07de74f3302ae80970d8f31be9d9ff716d91d379ddddfdbffe5706b44acfefb1`
- complete catalog rows: `5236`
- `PUBLISHED`: `3891`
- `SYSTEM_PROBLEM`: `734`
- `UNPUBLISHED`: `611`
- malformed rows: `0`
- duplicate listing keys: `0`
- conflicting listing keys: `0`
- sanitized published source SHA-256:
  `94aca165a068904b84ad4ec53b699f3cdcc9acf390305e253781a9349ebf8ace`
- sanitized catalog source SHA-256:
  `70684781742ce31b0a3559eb469ee1030874dcbfd70a6ee4656e7c273144f9b2`
- compile checkpoint SHA-256:
  `2e93685762a85c67c31f776c0064795d0ff2225b62009c6ab4ff3c7f7a9366d1`

The only report-create POST was the already consumed G4 request. Continuation,
download, and compile did not create another report. Compile used `0` network
calls. Listing, price, inventory, delist, database, model, and paid-provider
writes/calls were all `0`.

## Amazon reports

### store1 / Salutem Solutions

- existing DONE report ID: `1078925020660`
- report-create calls: `0`
- captured rows: `1571`
- raw TSV SHA-256:
  `b3839047385c010f57dfd08c5bd535f1845ebc1accf9085d2a8fe6a8bb2d5e14`
- live `ACTIVE` rows: `1546`

### store3 / AMZ Commerce

- existing DONE report ID: `425493020660`
- report-create calls: `0`
- captured rows: `502`
- raw TSV SHA-256:
  `51e331edfe22752177d17537202853d52c1e38ce243b152191667ddef33a5842`
- live `ACTIVE` rows: `498`

Both reports were located and downloaded with GET-only Amazon SP-API access.
Marketplace mutations were `0`.

## Authoritative manifest

- schema:
  `phase1-authoritative-scope-manifest/v3`
- canonical JSON SHA-256:
  `94359db196ec3bc73c964edce7a88df56e5e1942fc0ba9824670034609e9062c`
- CSV SHA-256:
  `b9f17c01372fe53b764f7250d469b0324783859f7e1297159442ebedd50e77d8`
- embedded census SHA-256:
  `0230d7bf160f244019eb56bef020e2d493f121dae8b787ee5f446f89840ab6dd`
- required scopes: `6`
- in-scope reports: `3`
- source rows: `7309`
- live listings: `5935`
- Amazon live listings: `2044`
- Walmart live listings: `3891`
- blockers: `0`
- diagnostic collision groups: `12`
- byte-canonical policy validation: `PASS`
- checksum manifest validation: `3/3 PASS`

The 12 collision groups are retained as diagnostics. No raw SKU from different
channels or stores is merged.

## Closed and still-closed gates

- G4 report capture and G4.5 manifest compilation: closed.
- G5 business-data backfill apply: not authorized.
- G6 consumer activation/cutover: not authorized.
- G7 paid enrichment: not authorized.
- G8 marketplace, repricing, delist, inventory, or purchase actions: not authorized.
