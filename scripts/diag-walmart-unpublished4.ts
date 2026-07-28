// Page ALL UNPUBLISHED items for STARFITSTORE, tally the distinct reason
// strings, and isolate the Trust-&-Safety / compliance removals (the
// "flagged by our internal team" + prohibited/compliance phrasings).
//   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/diag-walmart-unpublished4.ts
import { getWalmartClient } from "@/lib/walmart/client";

function classify(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("flagged by our internal team")) return "TRUST_SAFETY_FLAG";
  if (r.includes("prohibited") || r.includes("trust") || r.includes("compliance") || r.includes("regulat") || r.includes("hazard") || r.includes("intellectual property") || r.includes("counterfeit")) return "COMPLIANCE";
  if (r.includes("end date")) return "END_DATE";
  if (r.includes("pricing rule") || r.includes("price gouging") || r.includes("reasonable price")) return "PRICE_RULE";
  if (r.includes("primary image")) return "IMAGE_MISSING";
  if (r.includes("upc") || r.includes("product id")) return "ID_MISMATCH";
  return "OTHER";
}

async function main() {
  const client = getWalmartClient(1);
  let total = 0;
  const byClass = new Map<string, number>();
  const reasonSamples = new Map<string, string>();
  const flagged: Array<{ sku: string; itemId: string; name: string; reason: string }> = [];

  const LIMIT = 200;
  let offset = 0;
  let totalItems = Infinity;
  while (offset < totalItems) {
    const res = await client.requestRaw("GET", "/items", {
      params: { publishedStatus: "UNPUBLISHED", limit: LIMIT, offset },
    });
    const b = res.body as any;
    totalItems = Number(b?.totalItems ?? 0) || totalItems;
    const items: any[] = (Array.isArray(b?.ItemResponse) && b.ItemResponse) || (Array.isArray(b?.items) && b.items) || [];
    if (items.length === 0) break;
    offset += items.length;
    for (const it of items) {
      total++;
      const reasons: string[] = it?.unpublishedReasons?.reason ?? [];
      const reason = reasons.join(" | ") || "(none)";
      const cls = classify(reason);
      byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
      if (!reasonSamples.has(cls)) reasonSamples.set(cls, reason);
      if (cls === "TRUST_SAFETY_FLAG" || cls === "COMPLIANCE") {
        flagged.push({ sku: it?.sku, itemId: it?.wpid, name: it?.productName, reason });
      }
    }
  }

  console.log(`TOTAL UNPUBLISHED SCANNED: ${total}\n`);
  console.log("=== BY CLASS ===");
  for (const [k, v] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(v).padStart(4)}  ${k}`);
    console.log(`      e.g. ${reasonSamples.get(k)?.slice(0, 160)}`);
  }
  console.log(`\n=== COMPLIANCE / TRUST & SAFETY REMOVALS (${flagged.length}) ===`);
  for (const f of flagged.slice(0, 40)) {
    console.log(`${f.sku}\t${f.itemId}\t${f.name?.slice(0, 55)}`);
  }
  if (flagged.length > 40) console.log(`... and ${flagged.length - 40} more`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e?.message || e); process.exit(1); });
