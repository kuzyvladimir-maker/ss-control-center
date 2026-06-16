/**
 * Generate a ChannelMAX File-Uploader flat file (tab-delimited .txt) that puts
 * our cost-model guardrails INTO ChannelMAX, so its repricer holds each SKU
 * inside [floor, target] instead of fighting our manual SP-API reprices.
 *
 * ChannelMAX has no API — you upload this file via:
 *   selling.channelmax.net → Inventory → File Uploader → Analyze New File →
 *   pick this .txt → Upload File Content To ChannelMAX.
 *
 * Columns (verbatim ChannelMAX names): SKU, ASIN, SellingVenue,
 * MinSellingPrice, MaxSellingPrice.
 *   - MinSellingPrice = our floor (landed × 1.3) — never reprice below this.
 *   - MaxSellingPrice = our target (landed × 1.5) — never go above; uncontested
 *     listings sit here (≈ our 70% markup).
 * NOTE: ChannelMAX only reprices a SKU once Min is non-zero — this file sets it.
 *
 * Run: npx tsx scripts/channelmax-export.ts
 * Output: data/channelmax-uncrustables-minmax.txt
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { readSnapshot, syncUncrustables } from "@/lib/pricing/uncrustables";

const SELLING_VENUE = "AmazonUS";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function main() {
  const snap = (await readSnapshot()) ?? (await syncUncrustables());
  const rows = snap.rows;
  // Header uses ChannelMAX's exact column names.
  const header = ["SKU", "ASIN", "SellingVenue", "MinSellingPrice", "MaxSellingPrice"];
  const lines = [header.join("\t")];
  for (const r of rows) {
    if (!Number.isFinite(r.target) || !Number.isFinite(r.floor)) continue;
    lines.push(
      [
        r.sku,
        r.asin || "",
        SELLING_VENUE,
        round2(r.floor).toFixed(2), // Min = floor
        round2(r.target).toFixed(2), // Max = target
      ].join("\t"),
    );
  }
  const out = "data/channelmax-uncrustables-minmax.txt";
  writeFileSync(out, lines.join("\r\n")); // CRLF — Windows-friendly for upload
  console.log(`Wrote ${rows.length} SKUs → ${out}`);
  console.log("Preview:");
  console.log(lines.slice(0, 6).join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
