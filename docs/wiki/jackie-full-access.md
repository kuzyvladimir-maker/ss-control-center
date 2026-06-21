# Jackie (OpenClaw agent) — full admin API access

**Updated 2026-06-21.** Jackie now has **full administrator access** to every
Control Center API endpoint using the **token it already has** — no new
credential was created.

## TL;DR

- Jackie authenticates with `Authorization: Bearer <JACKIE_API_TOKEN>` — the
  token already configured in Vercel prod and in Jackie/OpenClaw. **Nothing to
  reconfigure on Jackie's side.**
- That token now resolves to a full **admin** identity (`jackie@openclaw`) on
  the server, so it passes every `requireAuth` / `requireAdmin` /
  `requireModuleAccess` check and the RBAC module gates.
- `SSCC_API_TOKEN` keeps working identically (generic automation). Both are
  admin; Jackie has its own so audit logs can tell them apart.

## What changed (and why it was needed)

Three layers had to agree, and one didn't:

| Layer | Before | After |
|-------|--------|-------|
| `src/proxy.ts` (Edge gate) | already let `JACKIE_API_TOKEN` bearer through on all `/api/*` | unchanged |
| `verifyJackieAuth` (`/api/mcp`, `/api/sscc/manifest`) | already accepted `JACKIE_API_TOKEN` | unchanged |
| `getCurrentUser` (`src/lib/auth-server.ts`) | **only `SSCC_API_TOKEN` → admin identity; Jackie's token was unauthenticated** | **`JACKIE_API_TOKEN` → `jackie@openclaw` admin** |

So previously Jackie's own token worked for MCP but got 401/403 on regular
admin endpoints. Now it's admin everywhere.

## Three ways Jackie can talk to the Control Center

1. **MCP (recommended, structured):** `POST /api/mcp` — JSON-RPC 2.0. 36 curated
   tools with input schemas (`tools/list`, `tools/call`). This is the safe,
   typed surface built for an agent.
2. **REST manifest (non-MCP clients):** `GET /api/sscc/manifest` — the same 36
   tools as a plain JSON document (name, description, `write` flag,
   `input_schema`). **`GET /api/sscc/manifest?full=1`** additionally returns
   `rest_endpoints` — the complete map of all 264 `/api/*` paths the token can
   call as admin (this is how an agent discovers paths without reading this
   doc; the financial module is NOT a curated MCP tool — it's REST under
   `/api/finance/*`).
3. **Direct REST (full admin):** any `/api/*` endpoint below, called directly
   as admin. This is the "everything else" escape hatch beyond the 36 tools.

### Examples

```bash
# whoami — confirms admin identity
curl -H "Authorization: Bearer $JACKIE_API_TOKEN" \
  https://salutemsolutions.info/api/auth/me

# list MCP tools
curl -X POST -H "Authorization: Bearer $JACKIE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  https://salutemsolutions.info/api/mcp

# any admin endpoint, e.g. list roles
curl -H "Authorization: Bearer $JACKIE_API_TOKEN" \
  https://salutemsolutions.info/api/admin/roles
```

## Security notes

- The token = **full admin**. Treat it like a root password. If it leaks,
  rotate it: change `JACKIE_API_TOKEN` in Vercel prod **and** in Jackie's
  config (they must match), then redeploy. The server reads it from env only.
- Token auth **bypasses the RBAC module gates entirely** (Jackie is admin), and
  bypasses the page/login gate (it's API-only). Crons use their own
  `CRON_SECRET`; `SSCC_API_TOKEN` is the other admin token.
- Audit: Jackie's writes are attributed to `jackie@openclaw`
  (`id: system:jackie`).

## Financial Plan — `/api/finance/*` (most-requested)

The Financial Plan module is **REST, not an MCP tool**. There is no
`/api/financial-plan` or `/api/debts` — it all lives under `/api/finance/`
(the bare `/api/finance` has no handler → 404; use the sub-paths).

**Funds** (each debt is attached to a fund):
- `GET /api/finance/funds` → `{ funds: [{ id, name, group, balance, … }] }`
- Stable system-fund ids: `fund_debt_expansion` ("Debt repayment / Expansion"),
  `fund_installments` ("Installments / Loans"), `fund_reserve`, `fund_taxes`,
  `fund_free`.

**Debts** — `/api/finance/debts`:
- `GET /api/finance/debts` (optional `?fundId=`) → `{ debts, totalOriginal, totalRemaining, monthlyDue, owedNow }`. With no `fundId` it returns ALL debts (each row carries its `fundId`).
- `POST` add: `{ "action":"add", "fundId":"fund_debt_expansion", "amount":1234.56, "description":"…", "dateIncurred":"2026-06-21", "monthlyPayment":100, "paymentFrequency":"monthly" }` (`monthlyPayment`/`paymentFrequency` optional → makes it an installment; use `fund_installments`).
- `POST` pay: `{ "action":"pay", "debtId":"…", "amount":100 }` (debits the fund + reduces the debt).
- `PATCH`: `{ "id":"…", "amount"?, "description"?, "dateIncurred"?, "monthlyPayment"?, "paymentFrequency"? }`
- `DELETE /api/finance/debts?id=…`

**Other finance routes:** `config`, `expenses`, `funds/[id]`,
`funds/auto-allocate`, `funds/history`, `funds/needs`, `payouts`, `receipts`,
`run`, `timesheet` (see inventory below).

```bash
# list funds → find fund_debt_expansion, then read its debts
curl -H "Authorization: Bearer $JACKIE_API_TOKEN" \
  https://salutemsolutions.info/api/finance/funds
curl -H "Authorization: Bearer $JACKIE_API_TOKEN" \
  "https://salutemsolutions.info/api/finance/debts?fundId=fund_debt_expansion"
# add a debt
curl -X POST -H "Authorization: Bearer $JACKIE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"add","fundId":"fund_debt_expansion","amount":1500,"description":"Supplier invoice","dateIncurred":"2026-06-21"}' \
  https://salutemsolutions.info/api/finance/debts
```

## Full endpoint inventory (264 routes)

Jackie can call all of these as admin. Auto-generated from `route.ts` files —
regenerate after route changes with:

```bash
# from ss-control-center/, lists every endpoint + its HTTP methods
node -e 'const fs=require("fs"),p=require("path");(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())w(f);else if(e.name.startsWith("route.")){const m=[...fs.readFileSync(f,"utf8").matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)/g)].map(x=>x[1]);if(m.length)console.log([...new Set(m)].join(","),"/"+p.relative("src/app",p.dirname(f)))}}})("src/app/api")'
```

> The curated, schema-rich list for agent use is always live at
> `GET /api/sscc/manifest`. The list below is the raw REST surface.

<!-- BEGIN auto-generated endpoint list -->
### `/api/account-health` — 7 endpoint(s)
- `GET` /api/account-health
- `GET` /api/account-health/amazon
- `POST,GET` /api/account-health/amazon/poll
- `POST` /api/account-health/amazon/sync
- `GET` /api/account-health/amazon/violations/[storeId]/[category]
- `GET` /api/account-health/walmart
- `POST,GET` /api/account-health/walmart/sync

### `/api/adjustments` — 8 endpoint(s)
- `GET,POST` /api/adjustments
- `GET,PATCH` /api/adjustments/[id]
- `POST` /api/adjustments/scan
- `POST` /api/adjustments/settlement-sync
- `GET` /api/adjustments/sku-profiles
- `GET` /api/adjustments/stats
- `GET` /api/adjustments/sync-log
- `POST,GET` /api/adjustments/walmart/sync

### `/api/admin` — 7 endpoint(s)
- `POST` /api/admin/bootstrap-frozen-v2
- `GET,POST` /api/admin/invites
- `DELETE` /api/admin/invites/[id]
- `GET,POST` /api/admin/roles
- `PATCH,DELETE` /api/admin/roles/[key]
- `GET` /api/admin/users
- `PATCH,DELETE` /api/admin/users/[id]

### `/api/alerts` — 5 endpoint(s)
- `GET` /api/alerts
- `POST` /api/alerts/[id]/acknowledge
- `POST` /api/alerts/[id]/resolve
- `POST` /api/alerts/acknowledge-all
- `GET` /api/alerts/unacknowledged

### `/api/amazon` — 25 endpoint(s)
- `GET` /api/amazon/account-health
- `POST` /api/amazon/account-health/sync
- `GET,POST` /api/amazon/aplus
- `POST` /api/amazon/growth/advisor
- `POST,GET` /api/amazon/growth/advisor-bulk
- `POST` /api/amazon/growth/advisor-bulk/drain
- `POST` /api/amazon/growth/advisor/apply
- `GET` /api/amazon/growth/advisor/attribute-form
- `POST,GET` /api/amazon/growth/bulk-fix
- `POST` /api/amazon/growth/bulk-fix/drain
- `GET` /api/amazon/growth/buybox
- `GET` /api/amazon/growth/changelog
- `POST` /api/amazon/growth/changelog/rollback
- `GET` /api/amazon/growth/diagnosis
- `GET,POST` /api/amazon/growth/history
- `GET` /api/amazon/growth/learnings
- `GET` /api/amazon/growth/listing-health
- `POST` /api/amazon/growth/listing-health/sync
- `GET` /api/amazon/growth/optimizer
- `POST` /api/amazon/growth/optimizer/apply
- `POST` /api/amazon/growth/optimizer/preview
- `GET` /api/amazon/messages
- `GET` /api/amazon/stores
- `GET` /api/amazon/stores/status
- `GET` /api/amazon/test

### `/api/analytics` — 1 endpoint(s)
- `GET` /api/analytics/sales

### `/api/auth` — 7 endpoint(s)
- `GET` /api/auth/gmail
- `GET` /api/auth/gmail/callback
- `GET,POST` /api/auth/invite/[token]
- `POST` /api/auth/login
- `POST` /api/auth/logout
- `GET` /api/auth/me
- `GET,POST` /api/auth/register

### `/api/bundle-factory` — 43 endpoint(s)
- `POST` /api/bundle-factory/audit/remediate
- `GET` /api/bundle-factory/audit/results
- `GET` /api/bundle-factory/audit/results/[id]
- `POST` /api/bundle-factory/audit/scan
- `GET` /api/bundle-factory/audit/scans
- `GET,POST` /api/bundle-factory/briefs
- `GET,PATCH,DELETE` /api/bundle-factory/briefs/[id]
- `POST` /api/bundle-factory/briefs/[id]/approve-research
- `POST` /api/bundle-factory/briefs/[id]/generate-variations
- `POST` /api/bundle-factory/briefs/[id]/select-variation
- `GET,POST` /api/bundle-factory/channel-skus
- `GET` /api/bundle-factory/compliance/audit-log
- `GET` /api/bundle-factory/compliance/blocked-drafts
- `GET,POST` /api/bundle-factory/compliance/brand-conflicts
- `POST` /api/bundle-factory/compliance/check
- `GET` /api/bundle-factory/compliance/checks
- `POST` /api/bundle-factory/distribution/poll-pending
- `GET,POST,PATCH` /api/bundle-factory/drafts
- `GET` /api/bundle-factory/drafts/[id]
- `GET` /api/bundle-factory/drafts/[id]/distribution-status
- `POST` /api/bundle-factory/drafts/[id]/generate-content
- `POST` /api/bundle-factory/drafts/[id]/generate-images
- `POST` /api/bundle-factory/drafts/[id]/publish
- `POST` /api/bundle-factory/drafts/[id]/regenerate-content
- `POST` /api/bundle-factory/drafts/[id]/regenerate-image
- `POST` /api/bundle-factory/drafts/[id]/validate
- `GET` /api/bundle-factory/drafts/[id]/validation-status
- `GET,POST,PATCH` /api/bundle-factory/generation-jobs
- `GET` /api/bundle-factory/lifecycle-logs
- `GET` /api/bundle-factory/marketplace-rules
- `GET,POST` /api/bundle-factory/master-bundles
- `GET,POST` /api/bundle-factory/research
- `PATCH,DELETE` /api/bundle-factory/research/[id]
- `POST` /api/bundle-factory/research/run
- `POST` /api/bundle-factory/skus/[id]/poll-status
- `POST` /api/bundle-factory/skus/[id]/publish
- `POST` /api/bundle-factory/skus/[id]/validate
- `GET` /api/bundle-factory/stores
- `POST` /api/bundle-factory/studio
- `POST` /api/bundle-factory/studio/[id]/seed
- `POST` /api/bundle-factory/studio/[id]/tick
- `POST` /api/bundle-factory/studio/generate
- `GET,POST` /api/bundle-factory/upc-pool

### `/api/claims` — 2 endpoint(s)
- `GET,POST` /api/claims/atoz
- `GET,PATCH` /api/claims/atoz/[id]

### `/api/cron` — 28 endpoint(s)
- `GET` /api/cron/account-health-amazon
- `GET` /api/cron/account-health-walmart
- `GET` /api/cron/adjustments-amazon
- `GET` /api/cron/amazon-auto-improve
- `GET` /api/cron/amazon-daily-history
- `GET` /api/cron/amazon-listing-health
- `GET` /api/cron/amazon-remediation
- `GET` /api/cron/amazon-reports
- `GET` /api/cron/amazon-snapshots
- `GET` /api/cron/drive-backfill
- `GET` /api/cron/finance-accrual
- `GET` /api/cron/finance-funds
- `GET` /api/cron/frozen-analysis
- `GET` /api/cron/orders-amazon
- `GET` /api/cron/orders-shipments-amazon
- `GET` /api/cron/orders-walmart
- `GET` /api/cron/pricing-sync
- `GET` /api/cron/procurement-priority
- `GET` /api/cron/reference-enrichment-worker
- `GET` /api/cron/reference-harvest-worker
- `GET` /api/cron/reprice-amazon
- `GET` /api/cron/walmart
- `GET` /api/cron/walmart-cancellation-watchdog
- `GET` /api/cron/walmart-listing-quality
- `GET` /api/cron/walmart-quantity-inquiry-poll
- `GET` /api/cron/walmart-remediation-worker
- `GET` /api/cron/walmart-reports
- `GET` /api/cron/walmart-ship-confirm

### `/api/customer-hub` — 21 endpoint(s)
- `GET` /api/customer-hub
- `GET,POST` /api/customer-hub/atoz
- `GET,POST,PATCH` /api/customer-hub/atoz/[id]
- `POST` /api/customer-hub/atoz/[id]/submit
- `GET` /api/customer-hub/chargebacks
- `GET,POST` /api/customer-hub/feedback
- `GET,POST,PATCH` /api/customer-hub/feedback/[id]
- `POST` /api/customer-hub/feedback/[id]/remove
- `GET,POST` /api/customer-hub/knowledge-base
- `POST` /api/customer-hub/knowledge-base/seed
- `GET` /api/customer-hub/losses
- `GET,POST` /api/customer-hub/messages
- `GET,POST,PATCH` /api/customer-hub/messages/[id]
- `POST` /api/customer-hub/messages/[id]/send
- `POST` /api/customer-hub/messages/[id]/translate
- `GET` /api/customer-hub/related
- `GET` /api/customer-hub/stats
- `POST` /api/customer-hub/walmart
- `GET,PATCH` /api/customer-hub/walmart/orders/[orderId]
- `POST,GET` /api/customer-hub/walmart/orders/sync
- `POST,GET` /api/customer-hub/walmart/returns/sync

### `/api/dashboard` — 2 endpoint(s)
- `GET` /api/dashboard/sales
- `GET` /api/dashboard/summary

### `/api/debug` — 3 endpoint(s)
- `GET` /api/debug/veeqo-order
- `GET` /api/debug/veeqo-tag-test
- `GET` /api/debug/veeqo-tags-list

### `/api/diag` — 1 endpoint(s)
- `GET` /api/diag/tz

### `/api/economics` — 1 endpoint(s)
- `GET` /api/economics/skus

### `/api/external` — 4 endpoint(s)
- `GET` /api/external/index
- `GET` /api/external/orders
- `POST` /api/external/shipping
- `GET` /api/external/status

### `/api/feedback` — 2 endpoint(s)
- `GET,POST` /api/feedback
- `GET,PATCH` /api/feedback/[id]

### `/api/finance` — 12 endpoint(s)
- `GET,POST` /api/finance/config
- `GET,POST,PATCH,DELETE` /api/finance/debts
- `GET,POST,PATCH,DELETE` /api/finance/expenses
- `GET,POST,PATCH,DELETE` /api/finance/funds
- `GET,POST,PATCH` /api/finance/funds/[id]
- `POST` /api/finance/funds/auto-allocate
- `GET` /api/finance/funds/history
- `GET` /api/finance/funds/needs
- `GET,POST` /api/finance/payouts
- `GET,POST` /api/finance/receipts
- `POST` /api/finance/run
- `GET,POST` /api/finance/timesheet

### `/api/frozen` — 10 endpoint(s)
- `GET` /api/frozen/alerts
- `PATCH` /api/frozen/alerts/[id]
- `GET,POST` /api/frozen/incidents
- `GET,PATCH` /api/frozen/incidents/[id]
- `GET` /api/frozen/morning-summary
- `GET` /api/frozen/patterns
- `GET,PUT` /api/frozen/rules
- `POST` /api/frozen/rules/seed
- `POST` /api/frozen/run-analysis
- `GET` /api/frozen/sku-risk

### `/api/integrations` — 7 endpoint(s)
- `GET` /api/integrations
- `GET` /api/integrations/ai-providers
- `POST` /api/integrations/drive-backfill
- `POST` /api/integrations/drive-backfill/delete-orphans
- `GET` /api/integrations/drive-status
- `GET,DELETE` /api/integrations/gmail
- `GET` /api/integrations/gmail/test

### `/api/mcp` — 1 endpoint(s)
- `POST,GET` /api/mcp

### `/api/pricing` — 1 endpoint(s)
- `GET,POST` /api/pricing/uncrustables

### `/api/procurement` — 12 endpoint(s)
- `POST` /api/procurement/clean-title
- `POST` /api/procurement/inquire-quantity
- `POST` /api/procurement/inquiry-status
- `GET` /api/procurement/items
- `POST` /api/procurement/items/[lineItemId]/bought
- `POST` /api/procurement/items/[lineItemId]/partial
- `POST` /api/procurement/items/[lineItemId]/undo
- `POST` /api/procurement/pack-size
- `GET` /api/procurement/sku-stores
- `GET,PUT` /api/procurement/sku-stores/[sku]
- `POST` /api/procurement/walmart-cancel-order
- `POST` /api/procurement/walmart-cancellations

### `/api/rbac` — 1 endpoint(s)
- `GET` /api/rbac/modules

### `/api/reference-catalog` — 4 endpoint(s)
- `GET` /api/reference-catalog
- `GET` /api/reference-catalog/detail
- `POST,GET` /api/reference-catalog/enqueue
- `POST` /api/reference-catalog/harvest

### `/api/sales-overview` — 2 endpoint(s)
- `GET` /api/sales-overview
- `GET` /api/sales-overview/periods

### `/api/settings` — 4 endpoint(s)
- `GET,PUT` /api/settings
- `GET,PUT` /api/settings/integrations
- `GET` /api/settings/telegram-discover
- `POST` /api/settings/walmart-diagnose

### `/api/shipment-monitor` — 1 endpoint(s)
- `POST,GET` /api/shipment-monitor/walmart/sync

### `/api/shipping` — 24 endpoint(s)
- `GET,POST` /api/shipping/box-presets
- `DELETE` /api/shipping/box-presets/[id]
- `POST` /api/shipping/buy
- `POST` /api/shipping/classify-ai
- `GET` /api/shipping/dashboard
- `POST` /api/shipping/discard-label
- `POST` /api/shipping/edit-package
- `POST` /api/shipping/fix-sku
- `POST` /api/shipping/fix-tag
- `POST` /api/shipping/label-drive-retry
- `GET` /api/shipping/label-pdf
- `POST` /api/shipping/mark-label-printed
- `POST` /api/shipping/mark-placed
- `GET` /api/shipping/mergeable
- `GET,POST` /api/shipping/packing-profile
- `GET` /api/shipping/plan
- `POST` /api/shipping/product-type
- `POST` /api/shipping/product-type/retry-sync
- `GET` /api/shipping/rates
- `POST` /api/shipping/rollback-procurement
- `POST` /api/shipping/walmart/buy
- `POST` /api/shipping/walmart/check-label
- `POST` /api/shipping/walmart/mark-shipped
- `POST` /api/shipping/walmart/rates

### `/api/shipping-labels` — 1 endpoint(s)
- `GET` /api/shipping-labels/walmart/verify/[orderId]

### `/api/sku` — 1 endpoint(s)
- `GET` /api/sku

### `/api/spapi-test` — 1 endpoint(s)
- `GET` /api/spapi-test

### `/api/sscc` — 1 endpoint(s)
- `GET` /api/sscc/manifest

### `/api/stores` — 1 endpoint(s)
- `GET` /api/stores

### `/api/sync` — 2 endpoint(s)
- `POST,GET` /api/sync
- `GET` /api/sync/status

### `/api/veeqo` — 1 endpoint(s)
- `GET` /api/veeqo/orders

### `/api/walmart` — 10 endpoint(s)
- `GET` /api/walmart/growth/buybox
- `POST` /api/walmart/growth/buybox/sync
- `GET` /api/walmart/growth/diagnosis
- `GET` /api/walmart/growth/listing-quality
- `POST` /api/walmart/growth/listing-quality/sync
- `GET,POST` /api/walmart/growth/remediation
- `POST` /api/walmart/growth/remediation/analyze
- `POST` /api/walmart/retire-listing/execute
- `POST` /api/walmart/retire-listing/search
- `POST` /api/walmart/retire-listing/sku-details
<!-- END auto-generated endpoint list -->

See also: [[external-api-auth]], [[rbac-roles-permissions]].
