// Featured-Offer repricer engine.
//
// Mirrors what Vladimir does by hand on the Seller Central dashboard when he
// clicks "Match Featured Offer Price → Update Price": for each of our live
// SKUs, look at the competing offers, and if a competitor holds the Featured
// Offer (Buy Box) at a lower LANDED price (price + shipping) than us, lower
// our listing price just enough to win it back.
//
//   new listing price = competitor featured landed − our shipping − $0.01
//
// Safety rails:
//   • Only ever LOWER the price, never raise.
//   • Never drop more than MAX_DROP_PCT (10%) in one run — if winning would
//     need a bigger cut, skip and flag for manual review (protects against a
//     competitor dumping below our cost).
//   • COGS margin floor: when we have a SkuCost for the SKU, never price below
//     the point that still keeps TARGET_MARGIN (20%) of the sale as margin AFTER
//     Amazon's referral fee. Falls back to a hard $1.00 floor when cost is
//     unknown. This is what turns "match Buy Box" into "match Buy Box, but never
//     below our margin" — Buy Box is a signal, the margin floor is the law.
//   • dryRun mode computes everything and logs, but changes no prices.
//
// Throughput: we scan with a per-run time budget and a Setting-backed cursor
// so a run always finishes inside Vercel's 300s function limit and resumes
// where it left off next time.

import { prisma } from "@/lib/prisma";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { listSkus } from "@/lib/amazon-sp-api/listings";
import {
  getListingOffersBatch,
  setListingPrice,
  type SkuOffers,
} from "@/lib/amazon-sp-api/pricing";

export const MAX_DROP_PCT = 0.1; // never auto-cut more than 10% in one run
const ABS_FLOOR = 1.0; // hard sanity floor used only when we have no cost data
const UNDERCUT = 0.01; // beat the featured offer by a penny

// COGS-backed margin floor. SkuCost.totalCost is the BARE product cost (Dry) or
// product+pkg+ice (Frozen) from Sellerboard/retail — it does NOT include Amazon's
// referral fee. So the lowest sale price that still leaves TARGET_MARGIN of the
// sale as our margin, after Amazon takes its referral cut, is:
//     floor = cost / (1 − referral − margin)
// e.g. cost $4.00 → 4 / (1 − 0.15 − 0.20) = 4 / 0.65 = $6.16.
// Tune these two numbers to change the policy (they are the whole margin model).
export const TARGET_MARGIN = 0.2; // project rule: keep at least 20% margin
export const AMAZON_REFERRAL_PCT = 0.15; // Amazon food/grocery referral fee (items >$15)
export function marginFloorPrice(totalCost: number): number {
  const denom = 1 - AMAZON_REFERRAL_PCT - TARGET_MARGIN;
  if (denom <= 0) return totalCost; // pathological config — fall back to raw cost
  return Math.round((totalCost / denom) * 100) / 100;
}
const BATCH_SIZE = 20; // getListingOffersBatch max
const BATCH_PAUSE_MS = 300; // pacing between batches
const TIME_BUDGET_MS = 240_000; // stop & save cursor before Vercel's 300s cap

export type RepriceAction =
  | "repriced"
  | "skipped_winning"
  | "skipped_raise"
  | "skipped_cap"
  | "skipped_floor" // would dip below the $1 hard floor (no cost data)
  | "skipped_margin_floor" // would dip below the COGS-backed margin floor
  | "no_competition"
  | "error";

export interface SkuMeta {
  sku: string;
  asin?: string;
  title?: string;
  productType?: string;
  status?: string[];
}

export interface Decision {
  sku: string;
  asin?: string;
  title?: string;
  action: RepriceAction;
  oldPrice: number;
  newPrice: number | null;
  shipping: number;
  targetLanded: number | null;
  competitors: number;
  reason?: string;
  cost?: number | null; // latest known product cost (SkuCost.totalCost), if any
  floor?: number; // the effective price floor applied to this decision
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure decision: given our parsed offers for one SKU, decide whether (and to
 * what) we should reprice. No side effects — easy to unit test and to run in
 * dryRun. Returns `null` only if there is no usable data at all.
 */
export function decideReprice(
  meta: SkuMeta,
  offers: SkuOffers,
  costInfo?: { cost?: number | null; floor?: number },
): Decision {
  // Effective floor = the higher of the hard $1 sanity floor and the COGS-backed
  // margin floor (when we have a cost for this SKU). No cost → just the $1 floor.
  const effFloor = Math.max(ABS_FLOOR, costInfo?.floor ?? 0);
  const base: Omit<Decision, "action" | "newPrice" | "reason"> = {
    sku: meta.sku,
    asin: meta.asin,
    title: meta.title,
    oldPrice: 0,
    shipping: 0,
    targetLanded: offers.buyBoxLanded,
    competitors: offers.totalOfferCount,
    cost: costInfo?.cost ?? null,
    floor: effFloor,
  };

  const mine = offers.offers.find((o) => o.mine);
  if (!mine) {
    return { ...base, action: "error", newPrice: null, reason: "no own offer in response" };
  }
  base.oldPrice = mine.listingPrice;
  base.shipping = mine.shipping;

  // Already winning the Featured Offer — nothing to do.
  if (mine.isBuyBoxWinner) {
    return { ...base, action: "skipped_winning", newPrice: null };
  }

  // Determine the competitor featured-offer landed price we need to beat.
  // Prefer Summary.BuyBoxPrices; fall back to the lowest competing offer.
  const competitorLanded =
    offers.buyBoxLanded ??
    offers.offers
      .filter((o) => !o.mine)
      .reduce<number | null>(
        (min, o) => (min == null ? o.landed : Math.min(min, o.landed)),
        null,
      );

  if (competitorLanded == null || offers.totalOfferCount <= 1) {
    return { ...base, action: "no_competition", newPrice: null };
  }
  base.targetLanded = competitorLanded;

  // Our new listing price to hit that landed total, beating it by a penny.
  const newPrice = round2(competitorLanded - mine.shipping - UNDERCUT);

  // Only ever lower. If we'd need to raise (we're already cheaper on landed
  // but lost the box for non-price reasons), don't touch the price.
  if (newPrice >= mine.listingPrice) {
    return { ...base, action: "skipped_raise", newPrice: null };
  }

  // Margin floor — never price below what keeps our margin (or, with no cost
  // data, below the $1 hard floor). This is the safety stop that stops the
  // repricer from chasing the Buy Box down into a loss.
  if (newPrice < effFloor) {
    const marginBacked = (costInfo?.floor ?? 0) > ABS_FLOOR;
    return {
      ...base,
      action: marginBacked ? "skipped_margin_floor" : "skipped_floor",
      newPrice: null,
      reason: marginBacked
        ? `computed $${newPrice.toFixed(2)} < margin floor $${effFloor.toFixed(2)} ` +
          `(cost $${(costInfo?.cost ?? 0).toFixed(2)}, keep ${Math.round(TARGET_MARGIN * 100)}% after ${Math.round(AMAZON_REFERRAL_PCT * 100)}% fee)`
        : `computed $${newPrice.toFixed(2)} < $${ABS_FLOOR.toFixed(2)} floor`,
    };
  }

  // 10% max single-drop guard rail.
  const dropPct = (mine.listingPrice - newPrice) / mine.listingPrice;
  if (dropPct > MAX_DROP_PCT) {
    return {
      ...base,
      action: "skipped_cap",
      newPrice: null,
      reason: `needs −${(dropPct * 100).toFixed(1)}% (> ${(MAX_DROP_PCT * 100).toFixed(0)}% cap) — manual review`,
    };
  }

  return { ...base, action: "repriced", newPrice };
}

export interface RunResult {
  storeIndex: number;
  scanned: number;
  repriced: number;
  skippedCap: number;
  skippedFloor: number; // held at the margin/$1 floor — would have lost margin
  noCompetition: number;
  errors: number;
  changes: Decision[]; // only action === "repriced"
  flagged: Decision[]; // only action === "skipped_cap"
  sweepComplete: boolean;
  timedOut: boolean;
}

const CURSOR_KEY = (storeIndex: number) => `reprice:cursor:store${storeIndex}`;

async function readCursor(storeIndex: number): Promise<string | undefined> {
  const row = await prisma.setting.findUnique({
    where: { key: CURSOR_KEY(storeIndex) },
  });
  return row?.value || undefined;
}

async function writeCursor(storeIndex: number, value: string | null) {
  const key = CURSOR_KEY(storeIndex);
  if (value == null) {
    await prisma.setting.deleteMany({ where: { key } });
    return;
  }
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run one repricing pass for a single store. Resumes from the saved cursor
 * and stops (saving the cursor) when it runs low on time, so the next cron
 * tick continues the sweep.
 */
export async function repriceStore(
  storeIndex: number,
  opts: { dryRun: boolean; startedAt?: number } = { dryRun: true },
): Promise<RunResult> {
  const startedAt = opts.startedAt ?? Date.now();
  const sellerId = await getMerchantToken(storeIndex);

  const result: RunResult = {
    storeIndex,
    scanned: 0,
    repriced: 0,
    skippedCap: 0,
    skippedFloor: 0,
    noCompetition: 0,
    errors: 0,
    changes: [],
    flagged: [],
    sweepComplete: false,
    timedOut: false,
  };

  let pageToken = await readCursor(storeIndex);

  while (true) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      result.timedOut = true;
      await writeCursor(storeIndex, pageToken ?? null);
      break;
    }

    const page = await listSkus(storeIndex, sellerId, {
      pageSize: BATCH_SIZE,
      includedData: ["summaries"],
      pageToken,
    });

    // Keep only buyable (live) listings — skip drafts/suppressed.
    const metas: SkuMeta[] = page.items
      .map((it) => {
        const s = it.summaries?.[0];
        return {
          sku: it.sku,
          asin: s?.asin,
          title: s?.itemName,
          productType: s?.productType,
          status: s?.status,
        };
      })
      .filter((m) => m.sku && (!m.status || m.status.includes("BUYABLE")));

    if (metas.length > 0) {
      const offers = await getListingOffersBatch(
        storeIndex,
        metas.map((m) => m.sku),
      );
      const byKey = new Map(offers.map((o) => [o.sku, o]));
      // Latest known product cost → margin floor, for this page's SKUs.
      const floors = await loadCostFloors(metas.map((m) => m.sku));

      for (const meta of metas) {
        result.scanned++;
        const o = byKey.get(meta.sku);
        if (!o || !o.ok) {
          result.errors++;
          await logDecision(storeIndex, {
            sku: meta.sku,
            asin: meta.asin,
            title: meta.title,
            action: "error",
            oldPrice: 0,
            newPrice: null,
            shipping: 0,
            targetLanded: null,
            competitors: 0,
            reason: o?.error ?? "no offers response",
          }, opts.dryRun);
          continue;
        }

        const cf = floors.get(meta.sku);
        const decision = decideReprice(meta, o, { cost: cf?.cost, floor: cf?.floor });

        // Apply the price change (unless dryRun).
        if (decision.action === "repriced" && decision.newPrice != null) {
          if (!opts.dryRun) {
            try {
              await setListingPrice(
                storeIndex,
                sellerId,
                meta.sku,
                meta.productType ?? "PRODUCT",
                decision.newPrice,
              );
            } catch (e) {
              decision.action = "error";
              decision.reason = e instanceof Error ? e.message : String(e);
            }
          }
        }

        // Tally + log.
        switch (decision.action) {
          case "repriced":
            result.repriced++;
            result.changes.push(decision);
            break;
          case "skipped_cap":
            result.skippedCap++;
            result.flagged.push(decision);
            break;
          case "skipped_margin_floor":
          case "skipped_floor":
            result.skippedFloor++;
            break;
          case "no_competition":
            result.noCompetition++;
            break;
          case "error":
            result.errors++;
            break;
        }
        await logDecision(storeIndex, decision, opts.dryRun);
      }
    }

    pageToken = page.pagination?.nextToken;
    if (!pageToken) {
      result.sweepComplete = true;
      await writeCursor(storeIndex, null); // sweep done — restart next time
      break;
    }
    await sleep(BATCH_PAUSE_MS);
  }

  return result;
}

/**
 * Latest known product cost per SKU → its margin-protected price floor.
 * SkuCost rows are dated; we take the most recent effectiveDate per SKU.
 * SKUs with no cost row are simply absent from the map (→ $1 hard floor).
 */
async function loadCostFloors(
  skus: string[],
): Promise<Map<string, { cost: number; floor: number }>> {
  const m = new Map<string, { cost: number; floor: number }>();
  if (skus.length === 0) return m;
  const rows = await prisma.skuCost.findMany({
    where: { sku: { in: skus } },
    orderBy: { effectiveDate: "desc" }, // ISO date strings sort correctly
    select: { sku: true, totalCost: true },
  });
  for (const r of rows) {
    // newest-first → the first row we see for a SKU is its latest cost.
    if (!m.has(r.sku) && r.totalCost != null && r.totalCost > 0) {
      m.set(r.sku, { cost: r.totalCost, floor: marginFloorPrice(r.totalCost) });
    }
  }
  return m;
}

async function logDecision(
  storeIndex: number,
  d: Decision,
  dryRun: boolean,
) {
  // Only persist actionable rows (changes, flags, errors) to keep the table
  // small — "winning"/"no_competition" are the vast majority and uninteresting.
  if (
    d.action === "skipped_winning" ||
    d.action === "skipped_raise" ||
    d.action === "no_competition"
  ) {
    return;
  }
  try {
    await prisma.repriceLog.create({
      data: {
        storeIndex,
        sku: d.sku,
        asin: d.asin ?? null,
        title: d.title ?? null,
        oldPrice: d.oldPrice,
        newPrice: d.newPrice,
        shipping: d.shipping,
        targetLanded: d.targetLanded,
        competitors: d.competitors,
        action: d.action,
        reason: d.reason ?? null,
        dryRun,
      },
    });
  } catch {
    // Logging must never break a run.
  }
}
