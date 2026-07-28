// Pricing module — Uncrustables data layer. Pulls the Merchant Listings report,
// scores every Uncrustable listing against the cost model, and caches the
// snapshot in the Setting key/value table (no schema migration needed).
// Base-price mutation is intentionally disabled: the canonical .99 offer is
// repaired through the sealed surgical workflow and promotions use coupons.

import { prisma } from "@/lib/prisma";
import { requestAndWaitForReport } from "@/lib/amazon-sp-api/reports";
import { getListing } from "@/lib/amazon-sp-api/listings";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { priceFor, type PriceStatus } from "./cost-model";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Authoritative current price + structured count for OUR listing. The Merchant
 * report lags and titles can contain misleading retail-carton counts. */
async function currentListingPricing(
  store: number,
  sellerId: string,
  sku: string,
): Promise<{ price: number | null; total: number | null } | null> {
  try {
    const listing = await getListing(store, sellerId, sku);
    const attrs = listing.attributes as Record<string, unknown> | undefined;
    const po = attrs?.purchasable_offer as
      | Array<{ audience?: string; our_price?: Array<{ schedule?: Array<{ value_with_tax?: number }> }> }>
      | undefined;
    const all = Array.isArray(po)
      ? po.find((o) => o.audience === "ALL") ?? po[0]
      : undefined;
    const rawPrice = all?.our_price?.[0]?.schedule?.[0]?.value_with_tax;
    const price = typeof rawPrice === "number" && Number.isFinite(rawPrice)
      ? rawPrice
      : null;
    const countFrom = (key: "number_of_items" | "unit_count"): number | null => {
      const rows = attrs?.[key];
      if (!Array.isArray(rows) || !rows[0] || typeof rows[0] !== "object") {
        return null;
      }
      const n = Number((rows[0] as { value?: unknown }).value);
      return Number.isInteger(n) && n > 0 ? n : null;
    };
    return {
      price,
      total: countFrom("number_of_items") ?? countFrom("unit_count"),
    };
  } catch {
    return null;
  }
}

/** The allowed consumer base is one exact value, not the whole floor/ceiling
 * corridor. The corridor exists only as a marketplace safety bound. */
export function classifyCanonicalBase(
  current: number | null,
  suggested: number,
): PriceStatus {
  if (current == null || !Number.isFinite(current)) return "UNKNOWN";
  if (Math.abs(current - suggested) < 0.005) return "OK";
  return current > suggested ? "HIGH" : "LOW";
}

export const SNAPSHOT_KEY = "pricing_uncrustables_snapshot";
export const SNAPSHOT_SCHEMA_VERSION = "uncrustables-pricing-snapshot/v2" as const;
/** Stores with Uncrustable listings reachable for live read via SP-API. */
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
  /** True only when Listings Items supplied a positive structured count. */
  liveCountVerified: boolean;
}

export interface PricingSnapshot {
  schema_version: typeof SNAPSHOT_SCHEMA_VERSION;
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
      target: p.suggested,
      ceiling: p.suggested,
      floor: p.floor,
      suggested: p.suggested,
      deltaPct:
        current != null
          ? Math.round(((current - p.suggested) / p.suggested) * 100)
          : null,
      status: classifyCanonicalBase(current, p.suggested),
      liveCountVerified: false,
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
          const live = await currentListingPricing(store, sellerId, r.sku);
          if (live != null) {
            const canonical = priceFor(live.total ?? r.total);
            r.liveCountVerified = live.total != null;
            if (canonical) {
              r.total = canonical.total;
              r.cooler = canonical.cooler;
              r.target = canonical.suggested;
              r.ceiling = canonical.suggested;
              r.floor = canonical.floor;
              r.suggested = canonical.suggested;
            }
            if (live.price != null) r.current = live.price;
            r.deltaPct = r.current != null
              ? Math.round(((r.current - r.suggested) / r.suggested) * 100)
              : null;
            r.status = classifyCanonicalBase(r.current, r.suggested);
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
  const snapshot: PricingSnapshot = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    updatedAt: now,
    stores,
    counts,
    rows,
  };

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
  return parsePricingSnapshot(row.value);
}

/** Reject legacy cached shapes so pre-policy targets can never silently feed
 * the UI or an artifact generator after deployment. */
export function parsePricingSnapshot(raw: string): PricingSnapshot | null {
  try {
    const value = JSON.parse(raw) as Partial<PricingSnapshot>;
    if (
      value.schema_version !== SNAPSHOT_SCHEMA_VERSION ||
      !Array.isArray(value.rows) ||
      !Array.isArray(value.stores) ||
      typeof value.updatedAt !== "string"
    ) {
      return null;
    }
    return value as PricingSnapshot;
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

/** Compatibility endpoint for old callers. It is permanently non-mutating. */
export async function applyReprice(
  store: number,
  sku: string,
  price: number,
  opts: { preview?: boolean } = {},
): Promise<RepriceResult> {
  void store;
  void price;
  void opts;
  return {
    sku,
    ok: false,
    error:
      "Direct Uncrustables repricing is disabled: canonical base prices are locked; use the sealed surgical repair for corrections and Amazon Coupons for promotions",
  };
}
