// Pricing module — Uncrustables data layer. Pulls the Merchant Listings report,
// scores every Uncrustable listing against the cost model, and caches the
// snapshot in the Setting key/value table (no schema migration needed). Also
// applies reprices via SP-API. Shared by the API route and the sync cron.

import { prisma } from "@/lib/prisma";
import { requestAndWaitForReport } from "@/lib/amazon-sp-api/reports";
import { getListing } from "@/lib/amazon-sp-api/listings";
import { setListingPrice } from "@/lib/amazon-sp-api/pricing";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { priceFor, classify, type Priced, type PriceStatus } from "./cost-model";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Authoritative current price for OUR listing: purchasable_offer → audience
 *  ALL → our_price. The Merchant report lags hours after a reprice; this reads
 *  the live value from the Listings Items API. Returns null if unavailable. */
async function currentOurPrice(
  store: number,
  sellerId: string,
  sku: string,
): Promise<number | null> {
  try {
    const listing = await getListing(store, sellerId, sku);
    const po = (listing.attributes as { purchasable_offer?: unknown })
      ?.purchasable_offer as
      | Array<{ audience?: string; our_price?: Array<{ schedule?: Array<{ value_with_tax?: number }> }> }>
      | undefined;
    if (!Array.isArray(po) || !po.length) return null;
    const all = po.find((o) => o.audience === "ALL") ?? po[0];
    const v = all?.our_price?.[0]?.schedule?.[0]?.value_with_tax;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

export const SNAPSHOT_KEY = "pricing_uncrustables_snapshot";
/** Stores with Uncrustable listings reachable for read/write via SP-API. */
export const PRICING_STORES = [1]; // store2=403, store3=0, store4/5 no API

export interface PricingRow {
  store: number;
  sku: string;
  asin: string;
  title: string;
  total: number;
  cooler: string;
  current: number | null;
  target: number;
  ceiling: number;
  floor: number;
  suggested: number;
  deltaPct: number | null; // current vs target
  status: PriceStatus;
}

export interface PricingSnapshot {
  updatedAt: string;
  stores: number[];
  counts: { total: number; high: number; low: number; ok: number; unknown: number };
  rows: PricingRow[];
}

function parseReport(store: number, tsv: string): PricingRow[] {
  const lines = tsv.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  const iName = header.indexOf("item-name");
  const iSku = header.indexOf("seller-sku");
  const iPrice = header.indexOf("price");
  const iAsin = header.indexOf("asin1");
  const rows: PricingRow[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    const title = c[iName] ?? "";
    if (!/uncrustable/i.test(title)) continue;
    const p = priceFor(title);
    if (!p) continue;
    const priceRaw = Number(c[iPrice]);
    const current =
      Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : null;
    rows.push({
      store,
      sku: c[iSku] ?? "?",
      asin: c[iAsin] ?? "?",
      title,
      total: p.total,
      cooler: p.cooler,
      current,
      target: p.target,
      ceiling: p.ceiling,
      floor: p.floor,
      suggested: p.suggested,
      deltaPct:
        current != null
          ? Math.round(((current - p.target) / p.target) * 100)
          : null,
      status: classify(current, p),
    });
  }
  return rows;
}

/** Pull listings for the given stores, score them, persist + return snapshot. */
export async function syncUncrustables(
  stores: number[] = PRICING_STORES,
  now: string = new Date().toISOString(),
): Promise<PricingSnapshot> {
  const rows: PricingRow[] = [];
  for (const store of stores) {
    try {
      const tsv = await requestAndWaitForReport(
        `store${store}`,
        "GET_MERCHANT_LISTINGS_ALL_DATA",
        1,
        8 * 60 * 1000,
      );
      const storeRows = parseReport(store, tsv);
      // Refresh each listing's current price from the live Listings Items API
      // (the report lags hours after a reprice). Best-effort; keep report
      // price on failure.
      try {
        const sellerId = await getMerchantToken(store);
        for (const r of storeRows) {
          const live = await currentOurPrice(store, sellerId, r.sku);
          if (live != null) {
            r.current = live;
            const p = priceFor(r.total) as Priced;
            r.deltaPct = Math.round(((live - r.target) / r.target) * 100);
            r.status = classify(live, p);
          }
          await sleep(120); // stay under the 5 req/s Listings limit
        }
      } catch (e) {
        console.error(`[pricing] store${store} price refresh failed: ${(e as Error).message}`);
      }
      rows.push(...storeRows);
    } catch (e) {
      console.error(`[pricing] store${store} report failed: ${(e as Error).message}`);
    }
  }
  rows.sort((a, b) => (b.deltaPct ?? -999) - (a.deltaPct ?? -999));

  const counts = {
    total: rows.length,
    high: rows.filter((r) => r.status === "HIGH").length,
    low: rows.filter((r) => r.status === "LOW").length,
    ok: rows.filter((r) => r.status === "OK").length,
    unknown: rows.filter((r) => r.status === "UNKNOWN").length,
  };
  const snapshot: PricingSnapshot = { updatedAt: now, stores, counts, rows };

  await prisma.setting.upsert({
    where: { key: SNAPSHOT_KEY },
    update: { value: JSON.stringify(snapshot) },
    create: { key: SNAPSHOT_KEY, value: JSON.stringify(snapshot) },
  });
  return snapshot;
}

/** Read the cached snapshot (null if never synced). */
export async function readSnapshot(): Promise<PricingSnapshot | null> {
  const row = await prisma.setting.findUnique({ where: { key: SNAPSHOT_KEY } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as PricingSnapshot;
  } catch {
    return null;
  }
}

export interface RepriceResult {
  sku: string;
  ok: boolean;
  price?: number;
  status?: string;
  error?: string;
}

/** Apply a new item price to one SKU (productType resolved from the listing). */
export async function applyReprice(
  store: number,
  sku: string,
  price: number,
  opts: { preview?: boolean } = {},
): Promise<RepriceResult> {
  try {
    const sellerId = await getMerchantToken(store);
    const listing = await getListing(store, sellerId, sku);
    const productType = listing.summaries?.[0]?.productType;
    if (!productType) return { sku, ok: false, error: "no productType" };
    const res = await setListingPrice(store, sellerId, sku, productType, price, {
      validationPreview: opts.preview,
    });
    const errs = (res?.issues ?? []).filter(
      (i: { severity?: string }) => i?.severity === "ERROR",
    );
    if (errs.length)
      return { sku, ok: false, error: JSON.stringify(errs).slice(0, 300) };
    return { sku, ok: true, price, status: res?.status ?? "ACCEPTED" };
  } catch (e) {
    return { sku, ok: false, error: (e as Error).message };
  }
}
