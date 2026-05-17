# Timezone for Veeqo dates (EDD / ship-by)

## Symptom

Comparing our Shipping Labels card against Veeqo's Pick Rate dialog, the same carrier rate showed:

- **Veeqo UI:** UPS Ground Saver, EDD Fri May 22 → meets the 5/22 deadline → $7.73 wins
- **Our service:** UPS Ground Saver, EDD Sat May 23 → fails the deadline → algorithm jumps to FedEx Express Saver at $23.02

A one-day skew in EDD pushed cheaper rates out of the deadline filter, costing $15+ per label.

## Root cause

Veeqo returns `delivery_promise_date` as a UTC ISO timestamp. Its own UI converts to **America/Los_Angeles** (Pacific) for display. We had two converters, both wrong in different ways:

1. `veeqoDateToLocal` in `src/lib/veeqo/client.ts`: used `setHours(getHours() - 7)`. Broke on Vercel's UTC runtime (any timestamp before 07:00 UTC rendered as the previous day) AND ignored DST (off by one Nov–Mar).
2. `eddNYDate` in `src/app/api/shipping/plan/route.ts`: workaround that used `Intl.DateTimeFormat` with `America/New_York`. DST-safe, but New York is one hour ahead of Pacific, so any UTC timestamp between 04:00–07:00 UTC fell on different dates in NY vs LA — which is exactly the window where the bug bit.

## Fix

`veeqoDateToLocal` now uses:

```ts
new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d)
```

Matches Veeqo's UI down to the day, regardless of host TZ and DST.

The `eddNYDate` workaround was removed — all callers go through `veeqoDateToLocal`. See [`src/app/api/shipping/plan/route.ts`](../../ss-control-center/src/app/api/shipping/plan/route.ts).

## Why Pacific and not NY

Vladimir is on Eastern Time but Veeqo (a UK-origin product running on US carrier APIs) anchors all marketplace-facing timestamps in Pacific, the standard TZ used by US e-commerce platforms (Amazon, etc.). The goal is to match Veeqo's rendering, not the operator's wall clock — otherwise our deadline checks disagree with what the carrier's own promise looks like in Veeqo.
