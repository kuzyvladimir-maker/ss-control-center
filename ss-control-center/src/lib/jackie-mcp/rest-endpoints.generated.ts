// AUTO-GENERATED — do not edit by hand.
// Snapshot of the REST API surface for Jackie/agent discovery via
// GET /api/sscc/manifest?full=1. Regenerate with scripts/gen-rest-endpoints.mjs
// after adding/removing routes.

export interface RestEndpoint { path: string; methods: string[] }

export const REST_ENDPOINTS: RestEndpoint[] = [
  {
    "path": "/api/account-health",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/account-health/amazon",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/account-health/amazon/poll",
    "methods": [
      "POST",
      "GET"
    ]
  },
  {
    "path": "/api/account-health/amazon/sync",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/account-health/amazon/violations/[storeId]/[category]",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/account-health/walmart",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/account-health/walmart/sync",
    "methods": [
      "POST",
      "GET"
    ]
  },
  {
    "path": "/api/adjustments",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/adjustments/[id]",
    "methods": [
      "GET",
      "PATCH"
    ]
  },
  {
    "path": "/api/adjustments/scan",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/adjustments/settlement-sync",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/adjustments/sku-profiles",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/adjustments/stats",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/adjustments/sync-log",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/adjustments/walmart/sync",
    "methods": [
      "POST",
      "GET"
    ]
  },
  {
    "path": "/api/admin/bootstrap-frozen-v2",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/admin/invites",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/admin/invites/[id]",
    "methods": [
      "DELETE"
    ]
  },
  {
    "path": "/api/admin/roles",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/admin/roles/[key]",
    "methods": [
      "PATCH",
      "DELETE"
    ]
  },
  {
    "path": "/api/admin/users",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/admin/users/[id]",
    "methods": [
      "PATCH",
      "DELETE"
    ]
  },
  {
    "path": "/api/alerts",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/alerts/[id]/acknowledge",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/alerts/[id]/resolve",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/alerts/acknowledge-all",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/alerts/unacknowledged",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/amazon/account-health",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/amazon/account-health/sync",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/amazon/aplus",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/amazon/growth/advisor",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/amazon/growth/advisor-bulk",
    "methods": [
      "POST",
      "GET"
    ]
  },
  {
    "path": "/api/amazon/growth/advisor-bulk/drain",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/amazon/growth/advisor/apply",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/amazon/growth/advisor/attribute-form",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/amazon/growth/bulk-fix",
    "methods": [
      "POST",
      "GET"
    ]
  },
  {
    "path": "/api/amazon/growth/bulk-fix/drain",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/amazon/growth/buybox",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/amazon/growth/changelog",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/amazon/growth/changelog/rollback",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/amazon/growth/diagnosis",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/amazon/growth/history",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/amazon/growth/learnings",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/amazon/growth/listing-health",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/amazon/growth/listing-health/sync",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/amazon/growth/optimizer",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/amazon/growth/optimizer/apply",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/amazon/growth/optimizer/preview",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/amazon/messages",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/amazon/stores",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/amazon/stores/status",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/amazon/test",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/analytics/sales",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/auth/gmail",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/auth/gmail/callback",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/auth/invite/[token]",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/auth/login",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/auth/logout",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/auth/me",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/auth/register",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/audit/remediate",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/audit/results",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/bundle-factory/audit/results/[id]",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/bundle-factory/audit/scan",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/audit/scans",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/bundle-factory/briefs",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/briefs/[id]",
    "methods": [
      "GET",
      "PATCH",
      "DELETE"
    ]
  },
  {
    "path": "/api/bundle-factory/briefs/[id]/approve-research",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/briefs/[id]/generate-variations",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/briefs/[id]/select-variation",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/channel-skus",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/compliance/audit-log",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/bundle-factory/compliance/blocked-drafts",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/bundle-factory/compliance/brand-conflicts",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/compliance/check",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/compliance/checks",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/bundle-factory/distribution/poll-pending",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/drafts",
    "methods": [
      "GET",
      "POST",
      "PATCH"
    ]
  },
  {
    "path": "/api/bundle-factory/drafts/[id]",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/bundle-factory/drafts/[id]/distribution-status",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/bundle-factory/drafts/[id]/generate-content",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/drafts/[id]/generate-images",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/drafts/[id]/publish",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/drafts/[id]/qualify",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/bundle-factory/drafts/[id]/regenerate-content",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/drafts/[id]/regenerate-image",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/drafts/[id]/ship-specs",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/drafts/[id]/validate",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/drafts/[id]/validation-status",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/bundle-factory/generation-jobs",
    "methods": [
      "GET",
      "POST",
      "PATCH"
    ]
  },
  {
    "path": "/api/bundle-factory/lifecycle-logs",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/bundle-factory/marketplace-rules",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/bundle-factory/master-bundles",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/pricing",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/pricing/preview",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/research",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/research/[id]",
    "methods": [
      "PATCH",
      "DELETE"
    ]
  },
  {
    "path": "/api/bundle-factory/research/run",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/skus/[id]/poll-status",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/skus/[id]/publish",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/skus/[id]/validate",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/stores",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/bundle-factory/studio",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/studio/[id]/seed",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/studio/[id]/tick",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/studio/generate",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/bundle-factory/upc-pool",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/catalog-status",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/claims/atoz",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/claims/atoz/[id]",
    "methods": [
      "GET",
      "PATCH"
    ]
  },
  {
    "path": "/api/cogs/catalog",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/account-health-amazon",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/account-health-walmart",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/adjustments-amazon",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/amazon-auto-improve",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/amazon-daily-history",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/amazon-listing-health",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/amazon-remediation",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/amazon-reports",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/amazon-snapshots",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/bundle-factory-poll-pending",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/bundle-factory-tick",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/catalog-snapshot",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/cogs-sweep",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/drive-backfill",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/finance-accrual",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/finance-funds",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/frozen-analysis",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/orders-amazon",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/orders-shipments-amazon",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/orders-walmart",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/pricing-sync",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/procurement-priority",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/reference-enrichment-worker",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/reference-harvest-worker",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/reprice-amazon",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/walmart",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/walmart-cancellation-watchdog",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/walmart-catalog-report",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/walmart-listing-quality",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/walmart-quantity-inquiry-poll",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/walmart-remediation-worker",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/walmart-reports",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/cron/walmart-ship-confirm",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/customer-hub",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/customer-hub/atoz",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/customer-hub/atoz/[id]",
    "methods": [
      "GET",
      "POST",
      "PATCH"
    ]
  },
  {
    "path": "/api/customer-hub/atoz/[id]/submit",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/customer-hub/chargebacks",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/customer-hub/feedback",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/customer-hub/feedback/[id]",
    "methods": [
      "GET",
      "POST",
      "PATCH"
    ]
  },
  {
    "path": "/api/customer-hub/feedback/[id]/remove",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/customer-hub/knowledge-base",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/customer-hub/knowledge-base/seed",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/customer-hub/losses",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/customer-hub/messages",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/customer-hub/messages/[id]",
    "methods": [
      "GET",
      "POST",
      "PATCH"
    ]
  },
  {
    "path": "/api/customer-hub/messages/[id]/send",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/customer-hub/messages/[id]/translate",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/customer-hub/related",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/customer-hub/stats",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/customer-hub/walmart",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/customer-hub/walmart/orders/[orderId]",
    "methods": [
      "GET",
      "PATCH"
    ]
  },
  {
    "path": "/api/customer-hub/walmart/orders/sync",
    "methods": [
      "POST",
      "GET"
    ]
  },
  {
    "path": "/api/customer-hub/walmart/returns/sync",
    "methods": [
      "POST",
      "GET"
    ]
  },
  {
    "path": "/api/dashboard/sales",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/dashboard/summary",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/debug/veeqo-order",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/debug/veeqo-tag-test",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/debug/veeqo-tags-list",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/diag/tz",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/economics/skus",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/external/index",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/external/orders",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/external/shipping",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/external/status",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/feedback",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/feedback/[id]",
    "methods": [
      "GET",
      "PATCH"
    ]
  },
  {
    "path": "/api/finance/config",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/finance/debts",
    "methods": [
      "GET",
      "POST",
      "PATCH",
      "DELETE"
    ]
  },
  {
    "path": "/api/finance/expenses",
    "methods": [
      "GET",
      "POST",
      "PATCH",
      "DELETE"
    ]
  },
  {
    "path": "/api/finance/funds",
    "methods": [
      "GET",
      "POST",
      "PATCH",
      "DELETE"
    ]
  },
  {
    "path": "/api/finance/funds/[id]",
    "methods": [
      "GET",
      "POST",
      "PATCH"
    ]
  },
  {
    "path": "/api/finance/funds/auto-allocate",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/finance/funds/history",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/finance/funds/needs",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/finance/funds/transfer",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/finance/payouts",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/finance/receipts",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/finance/run",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/finance/timesheet",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/frozen/alerts",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/frozen/alerts/[id]",
    "methods": [
      "PATCH"
    ]
  },
  {
    "path": "/api/frozen/incidents",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/frozen/incidents/[id]",
    "methods": [
      "GET",
      "PATCH"
    ]
  },
  {
    "path": "/api/frozen/morning-summary",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/frozen/patterns",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/frozen/rules",
    "methods": [
      "GET",
      "PUT"
    ]
  },
  {
    "path": "/api/frozen/rules/seed",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/frozen/run-analysis",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/frozen/sku-risk",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/integrations",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/integrations/ai-providers",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/integrations/drive-backfill",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/integrations/drive-backfill/delete-orphans",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/integrations/drive-status",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/integrations/gmail",
    "methods": [
      "GET",
      "DELETE"
    ]
  },
  {
    "path": "/api/integrations/gmail/test",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/mcp",
    "methods": [
      "POST",
      "GET"
    ]
  },
  {
    "path": "/api/openclaw/channelmax/jobs",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/openclaw/channelmax/jobs/[id]",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/openclaw/channelmax/jobs/[id]/approve",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/openclaw/channelmax/jobs/[id]/complete",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/openclaw/channelmax/jobs/[id]/event",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/openclaw/channelmax/jobs/[id]/heartbeat",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/openclaw/channelmax/jobs/claim",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/personal/calendar",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/personal/cards",
    "methods": [
      "GET",
      "POST",
      "PATCH",
      "DELETE"
    ]
  },
  {
    "path": "/api/personal/cards/[id]",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/personal/income",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/pricing/uncrustables",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/procurement/clean-title",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/procurement/inquire-quantity",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/procurement/inquiry-status",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/procurement/items",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/procurement/items/[lineItemId]/bought",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/procurement/items/[lineItemId]/partial",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/procurement/items/[lineItemId]/undo",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/procurement/pack-size",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/procurement/sku-stores",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/procurement/sku-stores/[sku]",
    "methods": [
      "GET",
      "PUT"
    ]
  },
  {
    "path": "/api/procurement/walmart-cancel-order",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/procurement/walmart-cancellations",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/rbac/modules",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/reference-catalog",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/reference-catalog/detail",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/reference-catalog/enqueue",
    "methods": [
      "POST",
      "GET"
    ]
  },
  {
    "path": "/api/reference-catalog/harvest",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/sales-overview",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/sales-overview/periods",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/settings",
    "methods": [
      "GET",
      "PUT"
    ]
  },
  {
    "path": "/api/settings/integrations",
    "methods": [
      "GET",
      "PUT"
    ]
  },
  {
    "path": "/api/settings/telegram-discover",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/settings/walmart-diagnose",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/shipment-monitor/walmart/sync",
    "methods": [
      "POST",
      "GET"
    ]
  },
  {
    "path": "/api/shipping-labels/walmart/verify/[orderId]",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/shipping/box-presets",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/shipping/box-presets/[id]",
    "methods": [
      "DELETE"
    ]
  },
  {
    "path": "/api/shipping/buy",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/shipping/classify-ai",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/shipping/dashboard",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/shipping/discard-label",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/shipping/edit-package",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/shipping/fix-sku",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/shipping/fix-tag",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/shipping/label-drive-retry",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/shipping/label-pdf",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/shipping/mark-label-printed",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/shipping/mark-placed",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/shipping/mergeable",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/shipping/packing-profile",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/shipping/plan",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/shipping/product-type",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/shipping/product-type/retry-sync",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/shipping/rates",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/shipping/rollback-procurement",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/shipping/walmart/buy",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/shipping/walmart/check-label",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/shipping/walmart/mark-shipped",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/shipping/walmart/rates",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/sku",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/spapi-test",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/sscc/manifest",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/stores",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/sync",
    "methods": [
      "POST",
      "GET"
    ]
  },
  {
    "path": "/api/sync/status",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/veeqo/orders",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/walmart/compliance-removals",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/walmart/growth/buybox",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/walmart/growth/buybox/sync",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/walmart/growth/diagnosis",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/walmart/growth/listing-quality",
    "methods": [
      "GET"
    ]
  },
  {
    "path": "/api/walmart/growth/listing-quality/sync",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/walmart/growth/remediation",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/walmart/growth/remediation/analyze",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/walmart/growth/remediation/apply-generated",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/walmart/growth/remediation/generate-image",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/walmart/growth/remediation/review",
    "methods": [
      "GET",
      "POST"
    ]
  },
  {
    "path": "/api/walmart/retire-listing/execute",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/walmart/retire-listing/search",
    "methods": [
      "POST"
    ]
  },
  {
    "path": "/api/walmart/retire-listing/sku-details",
    "methods": [
      "POST"
    ]
  }
];

export const REST_ENDPOINTS_COUNT = 291;
