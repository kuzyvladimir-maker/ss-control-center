# Walmart feeds: settle items individually, don't wait for the feed

**2026-07-10.** A batched `MP_MAINTENANCE` feed keeps `feedStatus: INPROGRESS` until its
**last** item settles. Our `checkFeedItems()` returned `null` for anything that was not
`PROCESSED`/`ERROR`, so a single slow item held every other item in the batch hostage.

Observed live on feed `18C0B21CCFC951…`:

```
feedStatus      INPROGRESS
itemsReceived   47
itemsSucceeded  45
itemsFailed     0
itemsProcessing 2
```

and `itemDetails.itemIngestionStatus` already listed **all 47** rows — 45 `SUCCESS`,
2 `INPROGRESS`. The per-item truth was sitting there the whole time. Those 45 tiles had
been live on Walmart for ~10 hours while our state file still called them `submitted`.

## The fix

`checkFeedItemsPartial(client, feedId)` in
[`src/lib/walmart/multipack/remediate.ts`](../../ss-control-center/src/lib/walmart/multipack/remediate.ts)
returns every item regardless of feed status, with a `settled` flag
(`ingestionStatus !== "INPROGRESS"`) and `done` for the feed itself.

Re-pollers (`_repoll_gen.ts`, `_repoll_fix.ts`) now record the settled items each tick and
leave the rest for the next one. First run after the change resolved **46 stranded SKUs**
across three feeds.

`checkFeedItems()` is unchanged: publishers still use it as a "is the whole batch done"
barrier during their 15-minute drain window, where the all-or-nothing semantics are what
you want.

## Rules

- **Never infer item outcome from feed status.** `feedStatus` is a batch aggregate;
  `itemDetails.itemIngestionStatus[].ingestionStatus` is the per-item verdict, and it is
  populated incrementally.
- A feed that never reaches `PROCESSED` is not a stuck publish — check `itemsSucceeded`
  before assuming anything is wrong.
- Transient `"It looks like there was a glitch on our end"` per-item errors are retryable:
  record them as `failed` (not terminal) so the next publish pass re-submits them.

See also [[walmart-multipack-remediation]], [[amazon-listing-rejections]].
