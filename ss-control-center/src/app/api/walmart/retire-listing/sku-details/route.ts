/**
 * POST /api/walmart/retire-listing/sku-details
 *
 * Body: { items: Array<{ sku: string; itemId?: string }> }
 *
 * For each item, returns:
 *   - currentQty: live qty from Walmart GET /v3/inventory (or null if call failed)
 *   - imageUrl:   cached og:image from walmart.com/ip/{itemId}, scraped on
 *                 demand if missing or older than 7 days (or null if itemId
 *                 absent / scrape failed)
 *
 * Called by the "Снять с продажи" modal AFTER the catalog search finishes,
 * so the search itself stays sub-second. Items render with a skeleton
 * placeholder until this returns.
 *
 * Concurrency: inventory calls hit Walmart Marketplace API (rate-tolerant,
 * 8 in parallel). Image scrapes hit the public walmart.com (bot-detected,
 * 4 in parallel max).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getWalmartClient, WalmartApiError } from "@/lib/walmart/client";
import { fetchVeeqoImageBySku } from "@/lib/veeqo/product-image";

const STORE_INDEX = 1;
const INVENTORY_CONCURRENCY = 8;
const VEEQO_LOOKUP_CONCURRENCY = 6;
const IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface InputItem {
  sku: string;
  itemId?: string | null;
}

interface DetailRow {
  sku: string;
  currentQty: number | null;
  imageUrl: string | null;
  fromCache: boolean;
}

/** Tiny promise pool — N workers consume tasks until the queue drains. */
async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const b = body as { items?: unknown };
  if (!Array.isArray(b.items) || b.items.length === 0) {
    return NextResponse.json(
      { error: "items must be a non-empty array of {sku, itemId}" },
      { status: 400 },
    );
  }
  const inputs: InputItem[] = [];
  for (const raw of b.items as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const sku = typeof r.sku === "string" ? r.sku.trim() : "";
    if (!sku) continue;
    const itemId = typeof r.itemId === "string" ? r.itemId.trim() : "";
    inputs.push({ sku, itemId: itemId || null });
  }
  if (inputs.length === 0) {
    return NextResponse.json(
      { error: "no valid items in body" },
      { status: 400 },
    );
  }
  if (inputs.length > 100) {
    return NextResponse.json(
      { error: "max 100 items per call" },
      { status: 400 },
    );
  }

  const skus = inputs.map((i) => i.sku);

  // 1. Pre-fetch cached image URLs in one query.
  const cached = await prisma.walmartCatalogItem.findMany({
    where: { storeIndex: STORE_INDEX, sku: { in: skus } },
    select: {
      sku: true,
      itemId: true,
      mainImageUrl: true,
      mainImageFetchedAt: true,
    },
  });
  const cacheBySku = new Map(cached.map((r) => [r.sku, r]));

  // 2. Decide which items need a fresh image lookup (no cache OR stale).
  //    Veeqo is the source — see fetchVeeqoImageBySku for why we don't
  //    use Walmart's own product page (datacenter IP captcha wall).
  const now = Date.now();
  const toLookup: string[] = [];
  for (const it of inputs) {
    const c = cacheBySku.get(it.sku);
    const fetchedAt = c?.mainImageFetchedAt?.getTime() ?? 0;
    if (!c?.mainImageUrl || now - fetchedAt > IMAGE_TTL_MS) {
      toLookup.push(it.sku);
    }
  }

  // 3. Run inventory + image work in parallel (independent pools).
  const client = getWalmartClient(STORE_INDEX);

  const inventoryWork = runPool(inputs, INVENTORY_CONCURRENCY, async (it) => {
    try {
      const r = (await client.request<{
        sku?: string;
        quantity?: { unit?: string; amount?: number };
      }>("GET", "/inventory", { params: { sku: it.sku } })) as {
        quantity?: { amount?: number };
      };
      const amt = r?.quantity?.amount;
      return { sku: it.sku, currentQty: typeof amt === "number" ? amt : null };
    } catch (err) {
      // Walmart returns 404 for SKUs without inventory configured — that
      // counts as "unknown", not as zero, so caller can tell them apart.
      if (err instanceof WalmartApiError && err.status !== 404) {
        console.warn(
          `[sku-details] inventory(${it.sku}) failed:`,
          err.status,
          err.errorBody,
        );
      }
      return { sku: it.sku, currentQty: null };
    }
  });

  const imageLookupWork = runPool(toLookup, VEEQO_LOOKUP_CONCURRENCY, async (sku) => {
    const url = await fetchVeeqoImageBySku(sku);
    if (url) {
      try {
        // Cache on the catalog row so the next modal open is instant.
        await prisma.walmartCatalogItem.updateMany({
          where: { storeIndex: STORE_INDEX, sku },
          data: { mainImageUrl: url, mainImageFetchedAt: new Date() },
        });
      } catch (err) {
        console.warn(
          `[sku-details] cache image update(${sku}) failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return { sku, imageUrl: url };
  });

  const [inventoryResults, imageResults] = await Promise.all([
    inventoryWork,
    imageLookupWork,
  ]);

  const invBySku = new Map(inventoryResults.map((r) => [r.sku, r.currentQty]));
  const lookupBySku = new Map(imageResults.map((r) => [r.sku, r.imageUrl]));

  const details: DetailRow[] = inputs.map((it) => {
    const c = cacheBySku.get(it.sku);
    const fresh = lookupBySku.get(it.sku);
    const imageUrl = fresh ?? c?.mainImageUrl ?? null;
    return {
      sku: it.sku,
      currentQty: invBySku.get(it.sku) ?? null,
      imageUrl,
      fromCache: !lookupBySku.has(it.sku) && !!c?.mainImageUrl,
    };
  });

  return NextResponse.json({ details });
}
