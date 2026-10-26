/**
 * NAN Health (Shopify) label purchase through Shopify's OFFICIAL Admin API
 * mutation `shippingLabelPurchase` (API 2026-07+):
 * https://shopify.dev/docs/apps/build/orders-fulfillment/order-management-apps/purchase-shipping-labels
 *
 * Owner, 2026-10-26: buy NAN labels from the Command Center like every other
 * order instead of retyping everything in Shopify admin. The NAN app already
 * holds write_orders + write_merchant_managed_fulfillment_orders, and a
 * probe on a CLOSED fulfillment order got a business error
 * (FULFILLMENT_ORDER_INVALID), not an access error.
 *
 * Limits that shape the callers:
 *   - FedEx is NOT supported by this mutation → those stay a Shopify-admin buy.
 *   - The rate is chosen by carrierCode + serviceCode, which the rate collector
 *     reads from the admin's own rate list (e.g. ups_shipping/93 = UPS Ground
 *     Saver). They must match a rate Shopify quotes for this shipment, else
 *     RATES_NOT_FOUND — so the package sent here is the one the rates were
 *     quoted for.
 *   - The purchase is asynchronous: PENDING_PURCHASE → PURCHASED | PURCHASE_FAILED.
 *
 * Money moves here: the mutation is sent at most once per call and never
 * retried. Pure transport — the route owns the duplicate guard.
 */

const API_VERSION = "2026-10";
const SHOPIFY_TIMEOUT_MS = 30_000;

export class NanShopifyConfigError extends Error {}

function nanEnv(): { shop: string; clientId: string; clientSecret: string } {
  const clean = (v: string | undefined) =>
    (v ?? "").trim().replace(/^['"]|['"]$/g, "");
  const shop = clean(process.env.NANHEALTH_SHOP);
  const clientId = clean(process.env.NANHEALTH_CLIENT_ID);
  const clientSecret = clean(process.env.NANHEALTH_CLIENT_SECRET);
  if (!shop || !clientId || !clientSecret) {
    throw new NanShopifyConfigError(
      "NAN Shopify app credentials are not configured (NANHEALTH_SHOP / NANHEALTH_CLIENT_ID / NANHEALTH_CLIENT_SECRET)",
    );
  }
  return { shop, clientId, clientSecret };
}

/** True when the NAN app credentials are set (Vercel env). Until then the
 *  page keeps opening Shopify admin instead of offering the API purchase. */
export function nanShopifyConfigured(): boolean {
  try {
    nanEnv();
    return true;
  } catch {
    return false;
  }
}

// Client-credentials tokens live 24 h; refresh well before that.
let cachedToken: { token: string; until: number } | null = null;

async function adminToken(): Promise<string> {
  if (cachedToken && cachedToken.until > Date.now()) return cachedToken.token;
  const { shop, clientId, clientSecret } = nanEnv();
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(SHOPIFY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Shopify token request failed: HTTP ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in?: number };
  const ttlMs = Math.min((j.expires_in ?? 3600) * 1000, 12 * 3600_000) - 300_000;
  cachedToken = { token: j.access_token, until: Date.now() + ttlMs };
  return j.access_token;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const { shop } = nanEnv();
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": await adminToken(),
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(SHOPIFY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Shopify Admin API HTTP ${res.status}`);
  const j = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (j.errors?.length) {
    throw new Error(`Shopify Admin API: ${j.errors.map((e) => e.message).join("; ")}`);
  }
  return j.data as T;
}

export interface NanShopifyOrder {
  name: string;
  displayFulfillmentStatus: string;
  /** The OPEN fulfillment order a label can be bought for, if any. */
  openFulfillmentOrderId: string | null;
  /** Tracking numbers already on the order (a label exists → never buy). */
  trackingNumbers: string[];
}

export async function findNanOrder(orderNumber: string): Promise<NanShopifyOrder | null> {
  const name = `#${orderNumber.replace(/^#/, "")}`;
  const data = await gql<{
    orders: {
      nodes: Array<{
        name: string;
        displayFulfillmentStatus: string;
        fulfillmentOrders: { nodes: Array<{ id: string; status: string }> };
        fulfillments: Array<{ trackingInfo: Array<{ number: string | null }> }>;
      }>;
    };
  }>(
    `query($q: String!) { orders(first: 5, query: $q) { nodes {
        name displayFulfillmentStatus
        fulfillmentOrders(first: 10) { nodes { id status } }
        fulfillments(first: 10) { trackingInfo { number } }
      } } }`,
    { q: `name:${name}` },
  );
  const o = data.orders.nodes.find((n) => n.name === name);
  if (!o) return null;
  return {
    name: o.name,
    displayFulfillmentStatus: o.displayFulfillmentStatus,
    openFulfillmentOrderId:
      o.fulfillmentOrders.nodes.find((f) => f.status === "OPEN")?.id ?? null,
    trackingNumbers: o.fulfillments
      .flatMap((f) => f.trackingInfo.map((t) => t.number))
      .filter((n): n is string => !!n),
  };
}

export interface NanPurchaseInput {
  fulfillmentOrderId: string;
  carrierCode: string;
  serviceCode: string;
  /** The package the rates were quoted for (inches / pounds, total weight). */
  pkg: { l: number; w: number; h: number; weightLb: number };
}

/** Sends the purchase mutation ONCE. `errors` = Shopify refused it
 *  synchronously, so nothing was bought. A thrown error = outcome unknown. */
export async function purchaseNanLabel(
  input: NanPurchaseInput,
): Promise<{ resultId: string } | { errors: string[] }> {
  const data = await gql<{
    shippingLabelPurchase: {
      shippingLabelPurchaseResult: { id: string; status: string } | null;
      userErrors: Array<{ field: string[] | null; code: string | null; message: string }>;
    };
  }>(
    `mutation($i: ShippingLabelPurchaseInput!) {
      shippingLabelPurchase(shippingLabelPurchase: $i) {
        shippingLabelPurchaseResult { id status }
        userErrors { field code message }
      } }`,
    {
      i: {
        fulfillmentOrderId: input.fulfillmentOrderId,
        // Must be in the future (SHIPPING_DATE_IN_THE_PAST otherwise).
        shippingDatetime: new Date(Date.now() + 10 * 60_000).toISOString(),
        // The rates were quoted on the TOTAL weight in this box.
        totalWeight: { value: input.pkg.weightLb, unit: "POUNDS" },
        packageInfo: {
          customPackage: {
            weight: { value: 0.5, unit: "POUNDS" }, // the empty box
            dimensions: {
              length: input.pkg.l,
              width: input.pkg.w,
              height: input.pkg.h,
              unit: "INCHES",
            },
            type: "BOX",
          },
        },
        preferredRateSelection: {
          carrierCode: input.carrierCode,
          serviceCode: input.serviceCode,
        },
        notifyCustomer: true,
      },
    },
  );
  const r = data.shippingLabelPurchase;
  if (r.userErrors.length > 0 || !r.shippingLabelPurchaseResult) {
    return {
      errors: r.userErrors.length
        ? r.userErrors.map((e) => (e.code ? `${e.code}: ${e.message}` : e.message))
        : ["Shopify returned no purchase result"],
    };
  }
  return { resultId: r.shippingLabelPurchaseResult.id };
}

export interface NanPurchaseResult {
  status: "PENDING_PURCHASE" | "PURCHASED" | "PURCHASE_FAILED";
  errors: string[];
  labels: Array<{
    trackingNumber: string | null;
    company: string | null;
    trackingUrl: string | null;
    pdfUrl: string | null;
  }>;
}

export async function readNanPurchase(resultId: string): Promise<NanPurchaseResult> {
  const data = await gql<{
    node: {
      status: NanPurchaseResult["status"];
      errors: Array<{ code: string | null; message: string }>;
      shippingLabels: Array<{
        trackingInfo: { number: string | null; company: string | null; url: string | null } | null;
        shippingDocuments: Array<{ documentType: string; format: string | null; url: string | null }>;
      }>;
    } | null;
  }>(
    `query($id: ID!) { node(id: $id) { ... on ShippingLabelPurchaseResult {
        status
        errors { code message }
        shippingLabels {
          trackingInfo { number company url }
          shippingDocuments { documentType format url }
        }
      } } }`,
    { id: resultId },
  );
  const n = data.node;
  if (!n) throw new Error(`Shopify purchase result ${resultId} not found`);
  return {
    status: n.status,
    errors: n.errors.map((e) => (e.code ? `${e.code}: ${e.message}` : e.message)),
    labels: n.shippingLabels.map((l) => ({
      trackingNumber: l.trackingInfo?.number ?? null,
      company: l.trackingInfo?.company ?? null,
      trackingUrl: l.trackingInfo?.url ?? null,
      pdfUrl:
        l.shippingDocuments.find((d) => d.documentType === "LABEL" && d.format === "PDF")?.url ??
        l.shippingDocuments.find((d) => d.documentType === "LABEL")?.url ??
        null,
    })),
  };
}

/** Polls until Shopify settles the purchase or `timeoutMs` passes. */
export async function waitNanPurchase(
  resultId: string,
  timeoutMs = 45_000,
): Promise<NanPurchaseResult> {
  const until = Date.now() + timeoutMs;
  let last: NanPurchaseResult | null = null;
  while (Date.now() < until) {
    try {
      last = await readNanPurchase(resultId);
      if (last.status !== "PENDING_PURCHASE") return last;
    } catch (e) {
      // A failed READ is safe to repeat — the purchase itself is not re-sent.
      console.warn("[nan-buy] result poll failed:", e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return last ?? { status: "PENDING_PURCHASE", errors: [], labels: [] };
}
