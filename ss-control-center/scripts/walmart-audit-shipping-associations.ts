/**
 * Which listings a shopper cannot buy, and why.
 *
 * A Walmart listing with no shipping-template association offers no delivery
 * option: the page looks published and every purchase button reads "Not
 * available". Nothing complains, so it earns nothing quietly.
 *
 * We believed the platform set that association itself — every publish posts a
 * SKU_TEMPLATE_MAP feed. On 2026-08-09 all EIGHTEEN such feeds ever sent were
 * found to have failed with the same parse error, so the association on older
 * listings arrived by some other route. This reads the truth from Walmart
 * instead of trusting the feed.
 */

import { prisma } from "../src/lib/prisma";
import { getWalmartClient } from "../src/lib/walmart/client";

interface Association {
  shippingTemplate?: { name?: string; id?: string };
  shipNode?: string;
}

async function main(): Promise<void> {
  const listings = await prisma.channelSKU.findMany({
    where: { channel: "WALMART", lifecycle_status: { not: "DRAFT" } },
    select: { sku: true, listing_status: true, live_url: true },
    orderBy: { created_at: "asc" },
  });
  const client = getWalmartClient(1);
  const missing: string[] = [];
  let attached = 0;

  for (const listing of listings) {
    let associations: Association[] = [];
    try {
      const res = await client.requestRaw("POST", "/items/associations", {
        body: { items: [{ sku: listing.sku }] },
      });
      const body = res.body as { items?: Array<{ associations?: Association[] }> };
      associations = body.items?.[0]?.associations ?? [];
    } catch (error) {
      console.log(`  ? ${listing.sku}: could not be read — `
        + `${error instanceof Error ? error.message.slice(0, 80) : error}`);
      continue;
    }
    if (associations.length === 0) {
      missing.push(listing.sku);
      console.log(`  ✗ ${listing.sku}  ${listing.listing_status}  NO shipping template`
        + `${listing.live_url ? ` — ${listing.live_url}` : ""}`);
    } else {
      attached += 1;
      console.log(`  ✓ ${listing.sku}  ${associations[0].shippingTemplate?.name ?? "?"}`);
    }
  }

  console.log(
    `\n${attached} listing(s) can be delivered, ${missing.length} cannot.`,
  );
  if (missing.length > 0) {
    console.log(
      "A listing with no association is published and unbuyable. Attach the "
      + "template in Seller Center, or fix the SKU_TEMPLATE_MAP feed format — "
      + "it has never once been accepted.",
    );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
