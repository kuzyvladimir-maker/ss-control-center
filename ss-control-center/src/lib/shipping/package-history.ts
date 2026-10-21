/**
 * Package fallback from what we have already shipped.
 *
 * The plan reads an order's weight + box from SkuShippingData (single item)
 * or PackingProfile (multi-item). In July the COGS identify script created
 * ~6k SkuShippingData rows with NO weight and NO dimensions (source
 * "cogs-identify"). Any SKU with such an empty row stopped on
 * "missing weight/dimensions" and the Package cell stayed blank, while SKUs
 * whose row had been filled synced fine — the "sometimes it pulls the
 * package, sometimes it doesn't" the owner saw.
 *
 * Before stopping, we now look at labels we already bought: the same SKU in
 * the same quantity, or the very same product title (same listing sold under
 * another SKU) in the same quantity. A hit is used for the quote AND written
 * back to the catalog, so the next order of that SKU never needs the lookup.
 */

import { resolveBoxDimensions } from "./box-presets";

export interface ShippedPackageRow {
  sku: string | null;
  product: string;
  qty: number;
  weight: number | null;
  boxSize: string | null;
  orderNumber: string;
  createdAt: Date;
}

export interface ShippedPackage {
  weight: number;
  boxSize: string;
  /** Which match produced it — "sku" is stronger than "product". */
  matchedBy: "sku" | "product";
  fromOrder: string;
}

/** Titles shorter than this are too generic to identify a product. */
const MIN_TITLE_LENGTH = 20;

const normTitle = (s: string | null | undefined) =>
  (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

function usable(r: ShippedPackageRow): boolean {
  return (
    r.weight != null &&
    Number.isFinite(r.weight) &&
    r.weight > 0 &&
    !!r.boxSize &&
    resolveBoxDimensions(r.boxSize) != null
  );
}

/**
 * Pick the package to reuse from previously bought plan items. Pure — the
 * caller supplies the rows. Newest wins within a match tier; an exact SKU
 * match always beats a title match.
 */
export function pickShippedPackage(
  rows: ShippedPackageRow[],
  want: { sku: string | null | undefined; product: string | null | undefined; qty: number },
): ShippedPackage | null {
  const newestFirst = rows
    .filter((r) => r.qty === want.qty && usable(r))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const sku = (want.sku ?? "").trim();
  if (sku) {
    const hit = newestFirst.find((r) => (r.sku ?? "").trim() === sku);
    if (hit) {
      return {
        weight: hit.weight!,
        boxSize: hit.boxSize!,
        matchedBy: "sku",
        fromOrder: hit.orderNumber,
      };
    }
  }

  const title = normTitle(want.product);
  if (title.length >= MIN_TITLE_LENGTH) {
    const hit = newestFirst.find((r) => normTitle(r.product) === title);
    if (hit) {
      return {
        weight: hit.weight!,
        boxSize: hit.boxSize!,
        matchedBy: "product",
        fromOrder: hit.orderNumber,
      };
    }
  }
  return null;
}

/** Minimal slice of the Prisma client this module needs. */
export interface ShippedPackageDb {
  shippingPlanItem: {
    findMany(args: {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
      orderBy: Record<string, "asc" | "desc">;
      take: number;
    }): Promise<ShippedPackageRow[]>;
  };
}

/** Query bought plan items for this SKU / title and pick the package. */
export async function findShippedPackage(
  db: ShippedPackageDb,
  want: { sku: string | null | undefined; product: string | null | undefined; qty: number },
): Promise<ShippedPackage | null> {
  const or: Record<string, unknown>[] = [];
  const sku = (want.sku ?? "").trim();
  if (sku) or.push({ sku });
  const product = (want.product ?? "").trim();
  if (product.length >= MIN_TITLE_LENGTH) or.push({ product });
  if (or.length === 0) return null;

  const rows = await db.shippingPlanItem.findMany({
    where: {
      status: "bought",
      qty: want.qty,
      weight: { not: null },
      boxSize: { not: null },
      OR: or,
    },
    select: {
      sku: true,
      product: true,
      qty: true,
      weight: true,
      boxSize: true,
      orderNumber: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return pickShippedPackage(rows, want);
}
