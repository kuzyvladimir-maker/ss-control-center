/**
 * scripts/backfill-orders.ts
 *
 * Pull the last N days (default 90) of orders from every configured store
 * and upsert into AmazonOrder / WalmartOrder. Designed to be safe to re-run:
 * upserts on the natural unique key.
 *
 * Usage:
 *   npx tsx scripts/backfill-orders.ts --days=90
 *   npx tsx scripts/backfill-orders.ts --days=30 --channel=walmart
 *   npx tsx scripts/backfill-orders.ts --days=45 --channel=amazon --store=2
 *
 * Env required (depending on channel):
 *   AMAZON_SP_CLIENT_ID / AMAZON_SP_CLIENT_SECRET / AMAZON_SP_REFRESH_TOKEN_STORE{1..5}
 *   WALMART_CLIENT_ID / WALMART_CLIENT_SECRET
 *   TURSO_DATABASE_URL + TURSO_AUTH_TOKEN  (or DATABASE_URL)
 *
 * Notes:
 * - Amazon SP-API throttles aggressively. The existing getOrders pagination
 *   helper already sleeps between pages; this script just calls it per store.
 * - Walmart Marketplace Orders API supports up to 1000 results / cursor walk.
 *   We page until no nextCursor.
 */

import { prisma } from "../src/lib/prisma";
import { getOrders as getAmazonOrders } from "../src/lib/amazon-sp-api/orders";
import { WalmartClient, WalmartOrdersApi } from "../src/lib/walmart";

interface Args {
  days: number;
  channel: "amazon" | "walmart" | "both";
  storeIndex: number | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (k: string): string | undefined => {
    const f = argv.find((a) => a.startsWith(`--${k}=`));
    return f ? f.split("=")[1] : undefined;
  };
  const days = parseInt(get("days") || "90", 10);
  const channelRaw = (get("channel") || "both").toLowerCase();
  const channel =
    channelRaw === "amazon" || channelRaw === "walmart" ? channelRaw : "both";
  const storeArg = get("store");
  const storeIndex = storeArg ? parseInt(storeArg, 10) : null;
  return { days, channel, storeIndex };
}

async function backfillAmazon(args: Args) {
  // Walk every active Amazon store. If --store=N was passed, narrow to that.
  const stores = await prisma.store.findMany({
    where: {
      active: true,
      channel: "Amazon",
      ...(args.storeIndex != null ? { storeIndex: args.storeIndex } : {}),
    },
    orderBy: { storeIndex: "asc" },
  });

  if (stores.length === 0) {
    console.log("  (no Amazon stores configured)");
    return;
  }

  const sinceIso = new Date(Date.now() - args.days * 86400000).toISOString();

  for (const store of stores) {
    if (store.storeIndex == null) continue;
    const storeIdParam = `store${store.storeIndex}`;
    console.log(
      `\n→ Amazon: ${store.name} (${storeIdParam}) — fetching since ${sinceIso}`
    );
    try {
      const orders = await getAmazonOrders({
        storeId: storeIdParam,
        createdAfter: sinceIso,
        maxResults: 100,
      });
      console.log(`  fetched ${orders.length} orders, upserting…`);

      let inserted = 0;
      let updated = 0;
      // SP-API returns many fields not declared on our trimmed AmazonOrder
      // interface (FulfillmentChannel etc). Cast to a permissive shape so the
      // upsert can use them when present.
      type SpApiOrder = (typeof orders)[number] & {
        FulfillmentChannel?: string;
        CancellationReason?: string;
      };
      for (const o of orders as SpApiOrder[]) {
        const existing = await prisma.amazonOrder.findUnique({
          where: { amazonOrderId: o.AmazonOrderId },
          select: { id: true },
        });
        await prisma.amazonOrder.upsert({
          where: { amazonOrderId: o.AmazonOrderId },
          create: {
            amazonOrderId: o.AmazonOrderId,
            storeIndex: store.storeIndex!,
            status: o.OrderStatus || "Unknown",
            purchaseDate: new Date(o.PurchaseDate),
            lastUpdateDate: o.LastUpdateDate
              ? new Date(o.LastUpdateDate)
              : null,
            orderTotal: parseFloat(o.OrderTotal?.Amount || "0"),
            currency: o.OrderTotal?.CurrencyCode || "USD",
            buyerName: o.BuyerInfo?.BuyerName,
            buyerEmail: o.BuyerInfo?.BuyerEmail,
            shipCity: o.ShippingAddress?.City,
            shipState: o.ShippingAddress?.StateOrRegion,
            shipZip: o.ShippingAddress?.PostalCode,
            shipCountry: o.ShippingAddress?.CountryCode,
            latestShipDate: o.LatestShipDate
              ? new Date(o.LatestShipDate)
              : null,
            latestDeliveryDate: o.LatestDeliveryDate
              ? new Date(o.LatestDeliveryDate)
              : null,
            numberOfItems:
              (o.NumberOfItemsShipped || 0) +
              (o.NumberOfItemsUnshipped || 0),
            fulfillmentChannel: o.FulfillmentChannel,
            salesChannel: o.SalesChannel,
          },
          update: {
            status: o.OrderStatus || "Unknown",
            lastUpdateDate: o.LastUpdateDate
              ? new Date(o.LastUpdateDate)
              : null,
            orderTotal: parseFloat(o.OrderTotal?.Amount || "0"),
          },
        });
        if (existing) updated++;
        else inserted++;
      }
      console.log(
        `  ✓ ${store.name}: ${inserted} new, ${updated} updated (${orders.length} total)`
      );
    } catch (err) {
      console.error(`  ✗ ${store.name} failed:`, err);
    }
  }
}

async function backfillWalmart(args: Args) {
  // Walmart has a single account in this project — but keep the loop so a
  // future second account doesn't need a refactor.
  const stores = await prisma.store.findMany({
    where: { active: true, channel: "Walmart" },
  });

  if (stores.length === 0) {
    console.log("  (no Walmart stores configured)");
    return;
  }

  let client: WalmartClient;
  try {
    // WalmartClient reads WALMART_CLIENT_ID_STORE{n} from env itself.
    client = new WalmartClient(stores[0].storeIndex ?? 1);
  } catch (err) {
    console.error("  ✗ Walmart client init failed — skipping:", err);
    return;
  }
  const ordersApi = new WalmartOrdersApi(client);

  const since = new Date(Date.now() - args.days * 86400000);
  const until = new Date();
  const sinceIso = since.toISOString();

  for (const store of stores) {
    console.log(
      `\n→ Walmart: ${store.name} (sellerId ${store.sellerId}) — since ${sinceIso}`
    );

    let inserted = 0;
    let updated = 0;
    let seen = 0;
    try {
      for await (const order of ordersApi.paginate({
        createdStartDate: since.toISOString(),
        createdEndDate: until.toISOString(),
        limit: 200,
        productInfo: false,
      })) {
        seen++;
        const purchaseOrderId = String(order.purchaseOrderId);
        const customerOrderId = String(order.customerOrderId);

        const existing = await prisma.walmartOrder.findUnique({
          where: { purchaseOrderId },
          select: { id: true },
        });
        await prisma.walmartOrder.upsert({
          where: { purchaseOrderId },
          create: {
            purchaseOrderId,
            customerOrderId,
            customerEmailId: order.customerEmailId ?? null,
            storeIndex: store.storeIndex ?? 1,
            status: order.status,
            shipNodeType: order.shipNodeType ?? null,
            orderType: order.orderType ?? null,
            orderDate: order.orderDate
              ? new Date(order.orderDate)
              : new Date(),
            estimatedShipDate: order.shippingInfo?.estimatedShipDate
              ? new Date(order.shippingInfo.estimatedShipDate)
              : null,
            estimatedDeliveryDate: order.shippingInfo?.estimatedDeliveryDate
              ? new Date(order.shippingInfo.estimatedDeliveryDate)
              : null,
            orderTotal: order.orderTotal ?? 0,
            currency: order.currency ?? "USD",
            shipCity: order.shippingInfo?.postalAddress?.city ?? null,
            shipState: order.shippingInfo?.postalAddress?.state ?? null,
            shipZip: order.shippingInfo?.postalAddress?.postalCode ?? null,
            shipCountry: order.shippingInfo?.postalAddress?.country ?? null,
            numberOfItems: order.orderLines?.length ?? 0,
            rawData: JSON.stringify(order.raw ?? order),
          },
          update: {
            status: order.status,
            orderTotal: order.orderTotal ?? 0,
            rawData: JSON.stringify(order.raw ?? order),
          },
        });
        if (existing) updated++;
        else inserted++;

        if (seen % 100 === 0) {
          console.log(`  …${seen} processed (${inserted} new, ${updated} updated)`);
        }
      }
      console.log(
        `  ✓ ${store.name}: ${inserted} new, ${updated} updated (${seen} total)`
      );
    } catch (err) {
      console.error(`  ✗ ${store.name} failed at ~${seen} orders:`, err);
    }
  }
}

async function main() {
  const args = parseArgs();
  console.log(
    `🔄 Backfill orders — ${args.days} day(s), channel=${args.channel}${
      args.storeIndex != null ? `, store=${args.storeIndex}` : ""
    }`
  );

  if (args.channel === "amazon" || args.channel === "both") {
    await backfillAmazon(args);
  }
  if (args.channel === "walmart" || args.channel === "both") {
    await backfillWalmart(args);
  }

  // Report what the DB now covers so the next operator can sanity-check.
  const a = await prisma.amazonOrder.aggregate({
    _min: { purchaseDate: true },
    _max: { purchaseDate: true },
    _count: true,
  });
  const w = await prisma.walmartOrder.aggregate({
    _min: { orderDate: true },
    _max: { orderDate: true },
    _count: true,
  });
  console.log("\n📊 Final coverage:");
  console.log(
    `  AmazonOrder:  ${a._count} rows · ${a._min.purchaseDate?.toISOString() ?? "—"} → ${a._max.purchaseDate?.toISOString() ?? "—"}`
  );
  console.log(
    `  WalmartOrder: ${w._count} rows · ${w._min.orderDate?.toISOString() ?? "—"} → ${w._max.orderDate?.toISOString() ?? "—"}`
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Backfill failed:", e);
  process.exit(1);
});
