/**
 * diag-rate-shopping-v1.ts — READ ONLY (POST /rates is a quote, not a mutation).
 * Validate the NEW Veeqo Rate Shopping API: POST /shipping/api/v1/rates with
 * preferred_shipment_date. Fire it for the screenshot order at Today vs Mon
 * Jun 15 and print EDDs — they MUST match Vladimir's web UI (UPS Ground
 * Today→Jun 18, Mon→Jun 19; FedEx 2Day One Rate Tue Jun 16 → Wed Jun 17).
 *
 * Run: cd ss-control-center && npx tsx scripts/diag-rate-shopping-v1.ts
 */
import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });

const KEY = process.env.VEEQO_API_KEY!;
const BASE = process.env.VEEQO_BASE_URL || "https://api.veeqo.com";
const ORDER_NUMBER = "113-3947294-3827449";

async function vf(path: string, options?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(options?.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function findOrder() {
  for (let page = 1; page <= 12; page++) {
    const orders = await vf(`/orders?status=awaiting_fulfillment&page_size=100&page=${page}`);
    if (!orders || orders.length === 0) break;
    const hit = orders.find((o: any) => o.number === ORDER_NUMBER);
    if (hit) return hit;
  }
  return null;
}

function toPacificYMD(d: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(d));
}

async function quote(body: any) {
  // The new rate-shopping endpoint is body-based.
  return vf(`/shipping/api/v1/rates`, { method: "POST", body: JSON.stringify(body) });
}

function summarize(resp: any, label: string) {
  // The response shape may be { quotes: [...] } or { rates: [...] } or { available: [...] }.
  const list: any[] =
    resp?.quotes || resp?.rates || resp?.available || resp?.data || (Array.isArray(resp) ? resp : []);
  console.log(`\n  [${label}] ${list.length} quotes`);
  if (list.length > 0 && label.includes("Today")) {
    console.log("    RAW first quote:\n" + JSON.stringify(list[0], null, 2).slice(0, 900));
  }
  if (list.length === 0) {
    console.log("    (raw keys: " + (resp ? Object.keys(resp).join(", ") : "null") + ")");
    console.log("    raw: " + JSON.stringify(resp).slice(0, 600));
    return;
  }
  const pick = (frag: string) =>
    list.find((r) => JSON.stringify(r).toLowerCase().includes(frag));
  for (const [name, frag] of [
    ["UPS Ground", "ups® ground"],
    ["FedEx 2Day One Rate", "2day® one rate"],
    ["USPS Ground Adv (1-70)", "ground advantage (1"],
  ] as const) {
    const r = pick(frag);
    if (!r) { console.log(`    ${name}: —`); continue; }
    const edd = r.delivery_estimate;
    const price = r.total_charge;
    const title = r.service_name;
    console.log(`    ${name}: ${title} → EDD ${edd ? toPacificYMD(edd) : "?"} (raw ${edd})  $${price}`);
  }
}

async function main() {
  const order = await findOrder();
  if (!order) { console.error("order not found"); process.exit(1); }
  const alloc = order.allocations?.[0];
  const wh = alloc?.warehouse;
  const pkg = alloc?.allocation_package;
  const to = order.deliver_to;
  const li = order.line_items?.[0];

  console.log(`order ${ORDER_NUMBER} id=${order.id}`);
  console.log("FULL warehouse:", JSON.stringify(wh));
  console.log("allocation_package:", JSON.stringify(pkg)?.slice(0, 300));
  console.log("line_item[0] keys:", li ? Object.keys(li).join(", ") : "none");
  console.log("line_item remote_id candidates:", JSON.stringify({
    remote_id: li?.remote_id,
    id: li?.id,
    sellable_remote: li?.sellable?.remote_id,
  }));
  console.log("due_date:", order.due_date);

  // Build addresses
  const toAddr = {
    name: `${to?.first_name ?? ""} ${to?.last_name ?? ""}`.trim(),
    phone: to?.phone || undefined,
    line1: to?.address1,
    line2: to?.address2 || undefined,
    town: to?.city,
    postcode: to?.zip,
    country_code: to?.country || "US",
    county: to?.state,
  };
  const fromAddr = {
    name: wh?.name || "Warehouse",
    company: wh?.name || undefined,
    phone: wh?.phone || "+18137710888",
    line1: wh?.address1 || wh?.address_line_1,
    line2: wh?.address2 || undefined,
    town: wh?.city,
    postcode: wh?.zip || wh?.postcode || wh?.post_code || wh?.region || wh?.zip_code || "33765",
    country_code: wh?.country || "US",
    county: wh?.region || wh?.state || wh?.county || "FL",
  };
  const weightOz = alloc?.total_weight || 160;
  const parcels = [{
    weight: weightOz,
    weight_unit: "oz",
    length: pkg?.depth || 10,
    width: pkg?.width || 8,
    height: pkg?.height || 8,
    dimension_unit: "in",
  }];
  const channel_items = [{ remote_id: String(li?.remote_id ?? li?.id), quantity: li?.quantity ?? 1 }];

  console.log("\nto_address:", JSON.stringify(toAddr));
  console.log("from_address:", JSON.stringify(fromAddr));
  console.log("parcels:", JSON.stringify(parcels));
  console.log("channel_items:", JSON.stringify(channel_items));

  const baseBody = {
    to_address: toAddr,
    from_address: fromAddr,
    parcels,
    customer_reference: ORDER_NUMBER,
    is_amazon_order: true,
    due_date: order.due_date,
    channel_items,
    include_unavailable_quotes: false,
  };

  for (const [label, date] of [
    ["Ship Date = Today (6/12)", "2026-06-12T16:00:00Z"],
    ["Ship Date = Mon 6/15", "2026-06-15T16:00:00Z"],
  ] as const) {
    try {
      const resp = await quote({ ...baseBody, preferred_shipment_date: date });
      summarize(resp, label);
    } catch (e) {
      console.log(`\n  [${label}] ERROR: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
