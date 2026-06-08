/**
 * Parse a downloaded Buy Box report and persist per-SKU rows.
 *
 * Columns (case/space-insensitive match): SKU, Item ID, Product Name,
 * Product Category, Seller Item Price, Seller Ship Price,
 * isSellerBuyBoxWinner (Yes/No), BuyBox Item Price, BuyBox Ship Price.
 *
 * priceGap = sellerTotal - buyBoxTotal. Positive ⇒ we're priced above the Buy
 * Box by $X (the lever: drop to win, if margin allows — see pricing model).
 */

import type { PrismaClient } from "@/generated/prisma/client";
import { parseCsv, col } from "./reports-insights";

export interface BuyBoxParseResult {
  rowsParsed: number;
  upserted: number;
  pruned: number;
  losing: number;
}

export async function persistBuyBoxReport(
  prisma: PrismaClient,
  storeIndex: number,
  csvText: string
): Promise<BuyBoxParseResult> {
  const records = parseCsv(csvText);
  const syncedAt = new Date();
  let upserted = 0;
  let losing = 0;

  for (const rec of records) {
    const sku = col(rec, "SKU", "Seller SKU", "sku");
    if (!sku) continue;

    const sellerItem = money(col(rec, "Seller Item Price", "sellerItemPrice"));
    const sellerShip = money(col(rec, "Seller Ship Price", "sellerShipPrice"));
    const bbItem = money(col(rec, "BuyBox Item Price", "Buy Box Item Price", "buyBoxItemPrice"));
    const bbShip = money(col(rec, "BuyBox Ship Price", "Buy Box Ship Price", "buyBoxShipPrice"));
    const winnerRaw = (col(rec, "isSellerBuyBoxWinner", "Buy Box Winner", "isWinner") ?? "").toLowerCase();
    const isWinner = winnerRaw === "yes" || winnerRaw === "true" || winnerRaw === "y";

    const sellerTotal = sumOrNull(sellerItem, sellerShip);
    const bbTotal = sumOrNull(bbItem, bbShip);
    const priceGap =
      sellerTotal != null && bbTotal != null ? round2(sellerTotal - bbTotal) : null;
    if (!isWinner) losing++;

    const data = {
      storeIndex,
      itemId: col(rec, "Item ID", "itemId") || null,
      productName: col(rec, "Product Name", "productName") || null,
      productCategory: col(rec, "Product Category", "productCategory") || null,
      sellerItemPrice: sellerItem,
      sellerShipPrice: sellerShip,
      sellerTotalPrice: sellerTotal,
      isWinner,
      buyBoxItemPrice: bbItem,
      buyBoxShipPrice: bbShip,
      buyBoxTotalPrice: bbTotal,
      priceGap,
      capturedAt: syncedAt,
      syncedAt,
    };

    await prisma.walmartBuyBoxItem.upsert({
      where: { walmart_buybox_dedup: { storeIndex, sku } },
      create: { sku, ...data },
      update: data,
    });
    upserted++;
  }

  // Prune rows not in this report (SKU left the catalog / report).
  const pruned = await prisma.walmartBuyBoxItem.deleteMany({
    where: { storeIndex, syncedAt: { lt: syncedAt } },
  });

  return { rowsParsed: records.length, upserted, pruned: pruned.count, losing };
}

function money(v: string | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v.replace(/[$,]/g, "").trim());
  return Number.isFinite(n) ? n : null;
}
function sumOrNull(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return round2((a ?? 0) + (b ?? 0));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
