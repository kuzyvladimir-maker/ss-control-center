/**
 * Jackie MCP tools — the cost/donor research pool (READ-ONLY).
 *
 *   research_pool_search — the product pool itself (DonorProduct + DonorOffer)
 *   sku_cost_get         — the per-SKU COGS rollup (SkuCost)
 *
 * WHY DonorProduct and not the `ResearchPool` table. `draft_components[]`
 * carries a field literally named `research_pool_id`, which reads like a
 * pointer into `ResearchPool` — it is not. Verified 2026-08-08: the
 * `ResearchPool` table holds 3 smoke-test rows from 2026-05-19 (cuid ids,
 * no UPCs) while the ids in `draft_components` (e.g.
 * 03eba512-c138-4942-bd34-177fae87c91b) resolve against `DonorProduct`.
 * The Product Truth catalog — DonorProduct (identity + content) with
 * DonorOffer (per-retailer price evidence) — is the real pool, so that is
 * what these tools expose. The field name is legacy; the data is not.
 *
 * Both tools are read-only and paginate on the same contract as
 * drafts_list / listings_search: `{ items…, total, next_offset }`.
 */

import { prisma } from "@/lib/prisma";
import { optionalNumber, optionalString, requireString } from "../channels";
import type { JackieTool } from "../registry";

/** Page cap — same reasoning as the other read tools: protect the agent's
 *  context, and let `offset` reach the rest. */
const POOL_PAGE_MAX = 200;

/** Batch cap for sku_cost_get. 100 keeps one MCP response readable. */
const MAX_COST_SKUS = 100;

const researchPoolSearch: JackieTool = {
  name: "research_pool_search",
  description:
    "Search the donor/cost research pool — the Product Truth catalog of real retail products (DonorProduct) with their per-retailer price evidence (DonorOffer). Filter by `upc` (exact), `query` (substring over title/brand/productLine/flavor), `brand`, and/or `category` (Dry|Frozen). Returns identity (brand, title, size, upc, category), the best clean per-unit price (best_price / best_retailer / price_per_measure) and, with include_offers=true, every retailer offer behind it. PAGINATION: `limit` capped at 200; response carries `total` and `next_offset` — page until next_offset is null. NOTE: `research_pool_id` on draft_components is a DonorProduct id — pass it as `id` here to resolve a bundle component to its source product. Read-only.",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Exact DonorProduct id — the value stored as `research_pool_id` on draft_components." },
      upc: { type: "string", description: "Exact UPC or GTIN match." },
      query: { type: "string", description: "Substring over title / brand / productLine / flavor." },
      brand: { type: "string", description: "Substring over brand." },
      category: { type: "string", description: "Dry | Frozen." },
      has_price: { type: "boolean", description: "When true, only products with a resolved best_price." },
      include_offers: { type: "boolean", default: false, description: "Attach each product's retailer offers (price, pack size, per-unit, in-stock, url)." },
      limit: { type: "number", default: 25, description: "Page size, capped at 200." },
      offset: { type: "number", default: 0, description: "Rows to skip. Pass the previous response's `next_offset`." },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const id = optionalString(args, "id");
    const upc = optionalString(args, "upc")?.trim();
    const query = optionalString(args, "query")?.trim();
    const brand = optionalString(args, "brand")?.trim();
    const category = optionalString(args, "category")?.trim();
    const includeOffers = args.include_offers === true;
    const limit = Math.min(optionalNumber(args, "limit") ?? 25, POOL_PAGE_MAX);
    const offset = Math.max(optionalNumber(args, "offset") ?? 0, 0);

    const and: Record<string, unknown>[] = [];
    if (id) and.push({ id });
    // UPC is stored bare and as GTIN (leading zero) — match either so a
    // 12-digit scan finds the 14-digit row and vice versa.
    if (upc) and.push({ OR: [{ upc }, { gtin: upc }, { upc: upc.replace(/^0+/, "") }] });
    if (query) {
      and.push({
        OR: [
          { title: { contains: query } },
          { brand: { contains: query } },
          { productLine: { contains: query } },
          { flavor: { contains: query } },
        ],
      });
    }
    if (brand) and.push({ brand: { contains: brand } });
    if (category) and.push({ category });
    if (args.has_price === true) and.push({ bestPrice: { not: null } });
    const where = and.length ? { AND: and } : {};

    const [total, rows] = await Promise.all([
      prisma.donorProduct.count({ where }),
      prisma.donorProduct.findMany({
        where,
        // identityKey is @unique — a total order, so paging can't drop rows.
        orderBy: [{ brand: "asc" }, { identityKey: "asc" }],
        skip: offset,
        take: limit,
        select: {
          id: true,
          brand: true,
          productLine: true,
          flavor: true,
          title: true,
          size: true,
          unitMeasure: true,
          unitAmount: true,
          containerType: true,
          category: true,
          upc: true,
          gtin: true,
          mainImageUrl: true,
          bestPrice: true,
          bestRetailer: true,
          pricePerMeasure: true,
          currency: true,
          identityStatus: true,
          confidence: true,
          needsReview: true,
          updatedAt: true,
          offers: includeOffers
            ? {
                orderBy: { pricePerUnit: "asc" },
                select: {
                  retailer: true,
                  via: true,
                  price: true,
                  packSizeSeen: true,
                  pricePerUnit: true,
                  currency: true,
                  zip: true,
                  inStock: true,
                  isFirstParty: true,
                  productUrl: true,
                  sourceApi: true,
                  fetchedAt: true,
                },
              }
            : false,
        },
      }),
    ]);

    const products = rows.map((r) => ({
      // `research_pool_id` is the historical name for this same id — echo it
      // so a caller holding a draft_component can match on either key.
      id: r.id,
      research_pool_id: r.id,
      brand: r.brand,
      product_line: r.productLine,
      flavor: r.flavor,
      title: r.title,
      size: r.size,
      unit_measure: r.unitMeasure,
      unit_amount: r.unitAmount,
      container_type: r.containerType,
      category: r.category,
      upc: r.upc,
      gtin: r.gtin,
      main_image_url: r.mainImageUrl,
      best_price: r.bestPrice,
      best_retailer: r.bestRetailer,
      price_per_measure: r.pricePerMeasure,
      currency: r.currency,
      identity_status: r.identityStatus,
      confidence: r.confidence,
      needs_review: r.needsReview,
      updated_at: r.updatedAt,
      ...(includeOffers
        ? {
            offers: (r as { offers?: unknown[] }).offers ?? [],
          }
        : {}),
    }));

    const nextOffset = offset + rows.length;
    return {
      count: products.length,
      total,
      offset,
      next_offset: nextOffset < total && rows.length > 0 ? nextOffset : null,
      products,
    };
  },
};

interface CostRow {
  sku: string;
  source: string;
  effective_date: string | null;
  total_cost: number | null;
  product_cost: number | null;
  packaging_cost: number | null;
  ice_cost: number | null;
  cost_per_unit: number | null;
  pack_size: number | null;
  includes_packaging: boolean;
  currency: string;
  confidence: number | null;
  needs_review: boolean;
  evidence_outcome: string | null;
  notes: string | null;
  created_at: Date;
}

const skuCostGet: JackieTool = {
  name: "sku_cost_get",
  description:
    "Read our COGS for one SKU (`sku`) or a batch (`skus`, up to 100) from the SkuCost ledger — the same numbers the unit-economics engine uses. Per SKU it returns `cost` = the most recent observation that actually carries a cost, and `latest` = the most recent observation of any kind (which may be UNSOURCEABLE, i.e. the last re-pricing attempt found no live retail offer — the older cost is then stale, not wrong). Set include_history=true for the full observation trail. SKUs with no row at all come back under `missing`. Read-only.",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      sku: { type: "string", description: "Single seller SKU (Walmart or Amazon)." },
      skus: {
        type: "array",
        items: { type: "string" },
        description: `Batch of seller SKUs (max ${MAX_COST_SKUS}).`,
      },
      include_history: { type: "boolean", default: false, description: "Return every SkuCost observation per SKU, newest first." },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const batchRaw = Array.isArray(args.skus) ? args.skus : null;
    let skus: string[];
    if (batchRaw) {
      skus = [
        ...new Set(batchRaw.map((s) => String(s ?? "").trim()).filter(Boolean)),
      ];
      if (skus.length === 0) {
        throw new Error("'skus' was provided but contains no non-empty SKU.");
      }
      if (skus.length > MAX_COST_SKUS) {
        throw new Error(
          `'skus' has ${skus.length} entries; max is ${MAX_COST_SKUS} per call. Split the batch.`,
        );
      }
    } else {
      skus = [requireString(args, "sku").trim()];
    }
    const includeHistory = args.include_history === true;

    const rows = await prisma.skuCost.findMany({
      where: { sku: { in: skus } },
      // effectiveDate is a free-form ISO string (some rows are dates, some
      // full timestamps) so it can't be the sole sort key; createdAt is the
      // reliable "when did we learn this" axis.
      orderBy: [{ createdAt: "desc" }],
      select: {
        sku: true,
        source: true,
        effectiveDate: true,
        productCost: true,
        packagingCost: true,
        iceCost: true,
        totalCost: true,
        costPerUnit: true,
        packSize: true,
        includesPackaging: true,
        currency: true,
        confidence: true,
        needsReview: true,
        evidenceOutcome: true,
        notes: true,
        createdAt: true,
      },
    });

    const bySku = new Map<string, CostRow[]>();
    for (const r of rows) {
      const row: CostRow = {
        sku: r.sku,
        source: r.source,
        effective_date: r.effectiveDate,
        total_cost: r.totalCost,
        product_cost: r.productCost,
        packaging_cost: r.packagingCost,
        ice_cost: r.iceCost,
        cost_per_unit: r.costPerUnit,
        pack_size: r.packSize,
        includes_packaging: r.includesPackaging,
        currency: r.currency,
        confidence: r.confidence,
        needs_review: r.needsReview,
        evidence_outcome: r.evidenceOutcome,
        notes: r.notes,
        created_at: r.createdAt,
      };
      const list = bySku.get(r.sku);
      if (list) list.push(row);
      else bySku.set(r.sku, [row]);
    }

    const costs = [];
    const missing: string[] = [];
    for (const sku of skus) {
      const history = bySku.get(sku);
      if (!history || history.length === 0) {
        missing.push(sku);
        continue;
      }
      // The newest observation may be UNSOURCEABLE (a re-price attempt that
      // found nothing live). Report it, but hand back the newest observation
      // that actually carries a number as the usable cost.
      const cost =
        history.find((h) => h.total_cost !== null || h.cost_per_unit !== null) ??
        null;
      costs.push({
        sku,
        cost,
        latest: history[0],
        observations: history.length,
        stale: cost !== null && cost !== history[0],
        ...(includeHistory ? { history } : {}),
      });
    }

    return {
      count: costs.length,
      missing_count: missing.length,
      missing,
      costs,
    };
  },
};

export const tools: JackieTool[] = [researchPoolSearch, skuCostGet];
