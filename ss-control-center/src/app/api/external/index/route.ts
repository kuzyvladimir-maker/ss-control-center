/**
 * GET /api/external/index
 *
 * Discovery endpoint for external clients (OpenClaw agent etc.).
 * Returns the catalog of every callable API route grouped by module,
 * the authentication scheme, and a curl example. Designed so an LLM
 * agent can introspect "what can I do?" without reading the source.
 *
 * Authentication:
 *   Authorization: Bearer ${SSCC_API_TOKEN}
 *
 * The same token grants access to ALL /api/* routes — see proxy.ts.
 * The token is admin-equivalent; treat it as a root credential.
 */

import { NextRequest, NextResponse } from "next/server";

interface RouteEntry {
  path: string;
  methods: string[];
  description: string;
}

interface RouteGroup {
  group: string;
  routes: RouteEntry[];
}

const CATALOG: RouteGroup[] = [
  {
    group: "Dashboard",
    routes: [
      {
        path: "/api/dashboard/summary",
        methods: ["GET"],
        description: "Top-level numbers across orders, claims, health, Walmart",
      },
    ],
  },
  {
    group: "Customer Hub — buyer messages",
    routes: [
      {
        path: "/api/customer-hub/messages",
        methods: ["GET", "POST"],
        description: "List messages or sync via Gmail",
      },
      {
        path: "/api/customer-hub/messages/{id}",
        methods: ["GET", "PATCH", "DELETE"],
        description: "Single message — read, edit, delete",
      },
      {
        path: "/api/customer-hub/messages/{id}/send",
        methods: ["POST"],
        description: "Mark response sent (or push via Gmail/Seller Central)",
      },
      {
        path: "/api/customer-hub/messages/{id}/translate",
        methods: ["POST"],
        description: "Generate Russian translation of a message",
      },
      {
        path: "/api/customer-hub/related",
        methods: ["GET"],
        description: "Related messages by amazonOrderId",
      },
      {
        path: "/api/customer-hub/stats",
        methods: ["GET"],
        description: "Aggregate counters per period/store",
      },
    ],
  },
  {
    group: "Customer Hub — A-to-Z & chargebacks",
    routes: [
      {
        path: "/api/customer-hub/atoz",
        methods: ["GET", "POST"],
        description: "List or sync A-to-Z claims",
      },
      {
        path: "/api/customer-hub/atoz/{id}",
        methods: ["GET", "PATCH"],
        description: "Single A-to-Z claim",
      },
      {
        path: "/api/customer-hub/atoz/{id}/submit",
        methods: ["POST"],
        description: "Submit response to Amazon",
      },
      {
        path: "/api/customer-hub/chargebacks",
        methods: ["GET"],
        description: "List chargebacks",
      },
    ],
  },
  {
    group: "Customer Hub — feedback",
    routes: [
      {
        path: "/api/customer-hub/feedback",
        methods: ["GET"],
        description: "List seller feedback + product reviews",
      },
      {
        path: "/api/customer-hub/feedback/{id}",
        methods: ["GET", "PATCH"],
        description: "Single feedback record",
      },
      {
        path: "/api/customer-hub/feedback/{id}/remove",
        methods: ["POST"],
        description: "Submit removal request to Amazon",
      },
    ],
  },
  {
    group: "Customer Hub — Walmart",
    routes: [
      {
        path: "/api/customer-hub/walmart/orders/sync",
        methods: ["POST"],
        description: "Sync Walmart orders → BuyerMessage triggers",
      },
      {
        path: "/api/customer-hub/walmart/returns/sync",
        methods: ["POST"],
        description: "Sync Walmart returns",
      },
      {
        path: "/api/customer-hub/walmart/orders/{id}",
        methods: ["GET", "PATCH"],
        description:
          "Get order or perform action (acknowledge/cancel/refund) — body: {action, lines?}",
      },
      {
        path: "/api/customer-hub/walmart",
        methods: ["POST"],
        description: "Analyze Walmart screenshots via AI vision (legacy fallback)",
      },
    ],
  },
  {
    group: "Customer Hub — losses & knowledge base",
    routes: [
      {
        path: "/api/customer-hub/losses",
        methods: ["GET"],
        description: "Aggregated losses dashboard",
      },
      {
        path: "/api/customer-hub/knowledge-base",
        methods: ["GET", "POST"],
        description: "List or add KB entries used by the Decision Engine",
      },
      {
        path: "/api/customer-hub/knowledge-base/seed",
        methods: ["POST"],
        description: "Re-seed canonical KB entries",
      },
    ],
  },
  {
    group: "A-to-Z claims (legacy)",
    routes: [
      { path: "/api/claims/atoz", methods: ["GET"], description: "List claims" },
      {
        path: "/api/claims/atoz/{id}",
        methods: ["GET", "PATCH"],
        description: "Single claim",
      },
    ],
  },
  {
    group: "Feedback (legacy)",
    routes: [
      {
        path: "/api/feedback",
        methods: ["GET"],
        description: "List feedback (?type=reviews for product reviews)",
      },
      {
        path: "/api/feedback/{id}",
        methods: ["GET", "PATCH"],
        description: "Single feedback record",
      },
    ],
  },
  {
    group: "Account Health",
    routes: [
      {
        path: "/api/account-health",
        methods: ["GET"],
        description: "Aggregate health snapshot per store",
      },
      {
        path: "/api/amazon/account-health",
        methods: ["GET"],
        description: "Per-store Amazon SP-API health detail",
      },
      {
        path: "/api/amazon/account-health/sync",
        methods: ["POST"],
        description: "Sync from Amazon SP-API",
      },
      {
        path: "/api/account-health/walmart/sync",
        methods: ["GET", "POST"],
        description: "Walmart Seller Performance — latest snapshot or refresh",
      },
    ],
  },
  {
    group: "Adjustments (shipping cost claims)",
    routes: [
      { path: "/api/adjustments", methods: ["GET"], description: "List adjustments" },
      {
        path: "/api/adjustments/{id}",
        methods: ["GET", "PATCH"],
        description: "Single adjustment",
      },
      {
        path: "/api/adjustments/scan",
        methods: ["POST"],
        description: "Trigger fresh scan",
      },
      {
        path: "/api/adjustments/stats",
        methods: ["GET"],
        description: "Aggregate totals",
      },
      {
        path: "/api/adjustments/sku-profiles",
        methods: ["GET"],
        description: "Per-SKU adjustment profiles",
      },
      {
        path: "/api/adjustments/walmart/sync",
        methods: ["POST"],
        description: "Pull all available Walmart recon reports",
      },
    ],
  },
  {
    group: "Shipping",
    routes: [
      {
        path: "/api/shipping/plan",
        methods: ["GET"],
        description: "Generate the day's shipping plan",
      },
      {
        path: "/api/shipping/buy",
        methods: ["POST"],
        description: "Buy approved labels via Veeqo",
      },
      {
        path: "/api/shipping/fix-sku",
        methods: ["POST"],
        description: "Fix SKU dimensions/weight in a plan row",
      },
      {
        path: "/api/shipping/fix-tag",
        methods: ["POST"],
        description: "Fix Frozen/Dry tag for a Veeqo product",
      },
      {
        path: "/api/shipping-labels/walmart/verify/{orderId}",
        methods: ["GET"],
        description: "Pre-buy safety check for a Walmart order",
      },
    ],
  },
  {
    group: "Shipment monitor",
    routes: [
      {
        path: "/api/shipment-monitor/walmart/sync",
        methods: ["POST"],
        description: "Drift detection for Shipped/Delivered Walmart orders",
      },
    ],
  },
  {
    group: "Frozen analytics",
    routes: [
      {
        path: "/api/frozen/incidents",
        methods: ["GET", "POST"],
        description: "List or create frozen incidents",
      },
      {
        path: "/api/frozen/incidents/{id}",
        methods: ["GET", "PATCH", "DELETE"],
        description: "Single incident",
      },
      {
        path: "/api/frozen/patterns",
        methods: ["GET"],
        description: "Pattern analysis (carrier × service × outcome)",
      },
      {
        path: "/api/frozen/sku-risk",
        methods: ["GET"],
        description: "Per-SKU frozen risk profiles",
      },
    ],
  },
  {
    group: "Orders & inventory",
    routes: [
      {
        path: "/api/veeqo/orders",
        methods: ["GET"],
        description: "Veeqo orders (?status=...)",
      },
      {
        path: "/api/amazon/messages",
        methods: ["GET"],
        description: "Amazon buyer messages from SP-API",
      },
      {
        path: "/api/amazon/stores",
        methods: ["GET"],
        description: "List configured Amazon stores",
      },
      {
        path: "/api/amazon/stores/status",
        methods: ["GET"],
        description: "Per-store status overview",
      },
      {
        path: "/api/sku",
        methods: ["GET"],
        description: "SKU database (dimensions, weights, types)",
      },
    ],
  },
  {
    group: "Sync & settings",
    routes: [
      {
        path: "/api/sync",
        methods: ["GET", "POST"],
        description: "Run or check master sync",
      },
      {
        path: "/api/sync/status",
        methods: ["GET"],
        description: "Current sync state",
      },
      {
        path: "/api/settings",
        methods: ["GET", "POST"],
        description: "App settings KV",
      },
      {
        path: "/api/integrations",
        methods: ["GET"],
        description: "Integration status overview",
      },
      {
        path: "/api/integrations/ai-providers",
        methods: ["GET", "POST"],
        description: "Manage Claude/OpenAI provider config",
      },
    ],
  },
  {
    group: "Analytics",
    routes: [
      {
        path: "/api/analytics/sales",
        methods: ["GET"],
        description: "Sales analytics rollup",
      },
    ],
  },
  {
    group: "Admin (user management)",
    routes: [
      {
        path: "/api/admin/users",
        methods: ["GET"],
        description: "List all users",
      },
      {
        path: "/api/admin/users/{id}",
        methods: ["PATCH", "DELETE"],
        description: "Change role or delete a user",
      },
      {
        path: "/api/admin/invites",
        methods: ["GET", "POST"],
        description: "List or create invitations",
      },
      {
        path: "/api/admin/invites/{id}",
        methods: ["DELETE"],
        description: "Revoke pending invite",
      },
    ],
  },
  {
    group: "Auth",
    routes: [
      {
        path: "/api/auth/me",
        methods: ["GET"],
        description: "Current authenticated identity (returns API token user when called with Bearer)",
      },
    ],
  },
  {
    group: "Legacy /api/external (still works)",
    routes: [
      { path: "/api/external/status", methods: ["GET"], description: "Today's sales summary" },
      { path: "/api/external/orders", methods: ["GET"], description: "Veeqo orders proxy" },
      { path: "/api/external/shipping", methods: ["POST"], description: "Shipping plan/buy proxy" },
    ],
  },
];

export function GET(request: NextRequest) {
  const baseUrl = `${request.nextUrl.protocol}//${request.nextUrl.host}`;
  const totalRoutes = CATALOG.reduce((s, g) => s + g.routes.length, 0);

  return NextResponse.json({
    service: "SS Control Center",
    baseUrl,
    auth: {
      scheme: "Bearer",
      header: "Authorization: Bearer ${SSCC_API_TOKEN}",
      scope:
        "Token is admin-equivalent and accepted on every /api/* route. Treat as a root credential.",
    },
    totalRoutes,
    catalog: CATALOG,
    examples: [
      {
        title: "Today's summary",
        curl: `curl -H "Authorization: Bearer $SSCC_API_TOKEN" ${baseUrl}/api/dashboard/summary`,
      },
      {
        title: "List open Customer Hub messages",
        curl: `curl -H "Authorization: Bearer $SSCC_API_TOKEN" "${baseUrl}/api/customer-hub/messages?status=NEW"`,
      },
      {
        title: "Sync Walmart orders",
        curl: `curl -X POST -H "Authorization: Bearer $SSCC_API_TOKEN" -H "Content-Type: application/json" -d '{"daysBack":30}' ${baseUrl}/api/customer-hub/walmart/orders/sync`,
      },
    ],
  });
}
