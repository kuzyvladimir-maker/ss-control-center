// Read-only replay of /api/shipping/buy's requote match for a manual rate
// override. Loads the latest plan item for an order, GETs the live Veeqo rate
// pool for its allocation, builds the override the PickRateDialog would send
// for the chosen service, and runs matchLiveRate before/after the fix.
// Never buys, never writes.
//
//   npx tsx scripts/diag-override-requote.ts <orderNumber> "<service title>" [rates.json]
//
// rates.json: optional saved response of prod GET /api/shipping/rates?orderId=…
// (no shipDate → the same GET /shipping/rates pool the buy re-quotes), for
// when the local Veeqo key is not the production one.
import "dotenv/config";
import { readFileSync } from "fs";
import { prisma } from "@/lib/prisma";
import { getShippingRates } from "@/lib/veeqo";
import { applyBuyOverride } from "@/lib/shipping/buy-override";
import { matchLiveRate, normTitle, type LiveRate } from "@/lib/shipping/requote-match";
import { utcToPacificYMD } from "@/lib/shipping/dates";

async function main() {
  const [orderNumber, title, ratesFile] = process.argv.slice(2);
  if (!orderNumber || !title) throw new Error("usage: <orderNumber> <service title>");
  const raw = await prisma.shippingPlanItem.findFirst({
    where: { orderNumber },
    orderBy: { createdAt: "desc" },
  });
  if (!raw?.allocationId) throw new Error(`no plan item with allocation for ${orderNumber}`);
  console.log("plan:", raw.service, raw.price, "edd", raw.edd, "alloc", raw.allocationId);

  const live: LiveRate[] = ratesFile
    ? JSON.parse(readFileSync(ratesFile, "utf8")).rates
    : (((await getShippingRates(raw.allocationId))?.available as LiveRate[]) || []);
  const picked = live.find((r) => normTitle(r.title) === normTitle(title));
  console.log("live rates:", live.length, "picked:", picked?.title, picked?.total_net_charge);
  if (!picked) return;

  // Same shape the client RateOverride carries (id = new-API quote id that is
  // never in the GET pool, so the match has to go through title).
  const ov = {
    carrier: String(picked.sub_carrier_id),
    service: String(picked.title),
    serviceType: "new-api-quote-id-not-in-pool",
    subCarrierId: String(picked.sub_carrier_id),
    totalNetCharge: String(picked.total_net_charge),
    price: parseFloat(String(picked.total_net_charge)),
    edd: picked.delivery_promise_date ? utcToPacificYMD(String(picked.delivery_promise_date)) : null,
  };
  const wantOf = (it: { serviceType: string | null; service: string | null; subCarrierId: string | null; price: number | null; totalNetCharge: string | null; edd: string | null }) => ({
    serviceType: it.serviceType,
    service: it.service,
    subCarrierId: it.subCarrierId,
    price: it.price ?? (Number.isFinite(parseFloat(it.totalNetCharge ?? "")) ? parseFloat(it.totalNetCharge!) : null),
    edd: it.edd,
  });
  const fixed = applyBuyOverride(raw, ov);
  const old = { ...fixed, price: raw.price, edd: raw.edd }; // pre-fix merge
  const before = matchLiveRate(live, wantOf(old));
  const after = matchLiveRate(live, wantOf(fixed));
  console.log("BEFORE fix:", before.rate ? `match ${before.tier}` : `refused — ${before.reason ?? ""}`);
  console.log("AFTER  fix:", after.rate ? `match ${after.tier} → ${after.rate.title} $${after.rate.total_net_charge}` : `refused — ${after.reason ?? ""}`);
}

main().finally(() => prisma.$disconnect());
