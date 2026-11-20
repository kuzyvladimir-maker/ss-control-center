# Shipping Labels: manual rate override refused at buy (2026-11-20)

Owner report (Telegram topic 135), order 113-1827014-8737842: the algorithm
planned FedEx Ground Economy at $6.74; the operator picked "UPS 2nd Day Air®"
at $11.40 in the Carrier dialog and pressed Buy label. Refused with
`"UPS 2nd Day Air®" now costs $11.40 — more than the planned $6.74 (limit $7.74)`.

**Cause.** `/api/shipping/buy` merged the client override (`RateOverride`)
into the plan item but copied only the service fields — not `price` and
`edd`. The requote matcher (`src/lib/shipping/requote-match.ts`, see
[[shipping-package-autofill-and-own-deadline-2026-10-21]]) found the picked
service by title in the live pool, then its price guard compared $11.40 with
the ALGORITHM's $6.74 + max($1, 5%). The algorithm's EDD leaked into the
"base" tier and alternatives the same way. The "no rate match" DIAG and the
"pick one with the Carrier button" advice were consequences of that one guard.

**Fix** (commit `b69a186a2`). The merge lives in
`src/lib/shipping/buy-override.ts` (`applyBuyOverride`): price = override
`price` → override `totalNetCharge` → plan; edd = override `edd` → plan. The
bulk Buy path sends the same `overrides[itemId]` and goes through the same
function. The guard now protects against a real price rise relative to the
rate the operator chose.

Tests: `src/lib/shipping/__tests__/buy-override.test.ts` (override above the
plan buys at live ≤ override + tolerance; refused above it; regression case).

**Read-only check.** `scripts/diag-override-requote.ts <order> "<title>" [rates.json]`
loads the plan item, takes the live GET pool (directly from Veeqo, or a saved
prod `GET /api/shipping/rates?orderId=…` response without `shipDate`), and
prints the match before/after the fix. Never buys. On 2026-11-20 against prod:
before — the exact refusal above; after — `match title → UPS 2nd Day Air® $11.40`.

Note: the Veeqo key in the local `.env` returned 401 on 2026-11-20; use the
saved prod rates file until it is refreshed.
