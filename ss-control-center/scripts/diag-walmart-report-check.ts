// Poll a Buy Box report until READY, then download + parse + sanity-check the
// parser against the REAL file (no DB). Re-downloadable, so safe to re-run.
//   RID=<requestId> npx tsx scripts/diag-walmart-report-check.ts
import "dotenv/config";
import { getWalmartClient } from "@/lib/walmart/client";
import {
  getReportStatus,
  getReportDownloadUrl,
  fetchReportText,
  parseCsv,
  col,
} from "@/lib/walmart/reports-insights";

const POLL_EVERY_MS = 60_000;
const MAX_POLLS = 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const client = getWalmartClient(1);
  const id = process.env.RID!;
  let ready = false;
  for (let i = 0; i < MAX_POLLS; i++) {
    const st = await getReportStatus(client, id);
    console.log(`[poll ${i + 1}] status = ${st.status}`);
    if (st.status === "READY") { ready = true; break; }
    if (st.status === "ERROR") { console.log("report ERROR"); return; }
    if (i < MAX_POLLS - 1) await sleep(POLL_EVERY_MS);
  }
  if (!ready) { console.log("still not ready — re-run later"); return; }

  const url = await getReportDownloadUrl(client, id);
  const text = await fetchReportText(url);
  const recs = parseCsv(text);
  console.log("\nrows:", recs.length);
  console.log("HEADERS:", Object.keys(recs[0] ?? {}));
  console.log("\n=== first 2 raw rows ===");
  for (const r of recs.slice(0, 2)) console.log(JSON.stringify(r));

  // Sanity-check the column mapping the persist layer relies on.
  let losing = 0, winning = 0, withGap = 0, totalGap = 0;
  const losers: Array<{ name: string; gap: number; our: number; bb: number }> = [];
  for (const rec of recs) {
    const sku = col(rec, "SKU", "Seller SKU");
    if (!sku) continue;
    const w = (col(rec, "isSellerBuyBoxWinner", "Buy Box Winner") ?? "").toLowerCase();
    const isWinner = w === "yes" || w === "true";
    const our = num(col(rec, "Seller Item Price")) + num(col(rec, "Seller Ship Price"));
    const bb = num(col(rec, "BuyBox Item Price", "Buy Box Item Price")) + num(col(rec, "BuyBox Ship Price", "Buy Box Ship Price"));
    if (isWinner) winning++; else losing++;
    const gap = Math.round((our - bb) * 100) / 100;
    if (!isWinner && gap > 0) { withGap++; totalGap += gap; losers.push({ name: col(rec, "Product Name")?.slice(0, 40) ?? sku, gap, our, bb }); }
  }
  console.log(`\n=== MAPPING CHECK ===`);
  console.log(`winning=${winning} losing=${losing} losersWithGap=${withGap} totalGapToClose=$${totalGap.toFixed(2)}`);
  losers.sort((a, b) => b.gap - a.gap);
  console.log("top gaps:");
  for (const l of losers.slice(0, 8)) console.log(`  +$${l.gap.toFixed(2)} (our $${l.our.toFixed(2)} vs BB $${l.bb.toFixed(2)}) ${l.name}`);
}

function num(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(v.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e.message); process.exit(1); });
