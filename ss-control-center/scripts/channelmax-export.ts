/**
 * Generate a ChannelMAX File-Uploader flat file (tab-delimited .txt) that puts
 * canonical safety bounds INTO ChannelMAX. This does NOT authorize repricing:
 * the Uncrustables rows must remain disabled in ChannelMAX because launch
 * promotions are coupon-only.
 *
 * ChannelMAX has no API — you upload this file via:
 *   selling.channelmax.net → Inventory → File Uploader → Analyze New File →
 *   pick this .txt → Upload File Content To ChannelMAX.
 *
 * Columns (verbatim ChannelMAX names): SKU, ASIN, SellingVenue,
 * MinSellingPrice, MaxSellingPrice.
 *   - MinSellingPrice = our floor (landed × 1.3) — never reprice below this.
 *   - MaxSellingPrice = the canonical .99 consumer base — never go above it.
 * NOTE: uploading bounds alone does not disable ChannelMAX's repricing model.
 *
 * Run: npx tsx scripts/channelmax-export.ts
 * Output: data/channelmax-uncrustables-minmax.txt
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { syncUncrustables } from "@/lib/pricing/uncrustables";

const SELLING_VENUE = "AmazonUS";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function main() {
  // Never build an upload from the Setting cache: a stale snapshot can restore
  // pre-repair bounds. A fresh live sync also prefers structured item count over
  // legacy title arithmetic.
  const snap = await syncUncrustables();
  const rows = snap.rows;
  const unverified = rows.filter((row) => !row.liveCountVerified);
  if (rows.length === 0 || unverified.length > 0) {
    throw new Error(
      `Refusing ChannelMAX artifact: ${rows.length === 0 ? "no rows" : `${unverified.length} row(s) lack a fresh structured count`}`,
    );
  }
  // Header uses ChannelMAX's exact column names.
  const header = ["SKU", "ASIN", "SellingVenue", "MinSellingPrice", "MaxSellingPrice"];
  const lines = [header.join("\t")];
  for (const r of rows) {
    if (!Number.isFinite(r.suggested) || !Number.isFinite(r.floor)) continue;
    lines.push(
      [
        r.sku,
        r.asin || "",
        SELLING_VENUE,
        round2(r.floor).toFixed(2), // Min = floor
        round2(r.suggested).toFixed(2), // Max = canonical .99 consumer base
      ].join("\t"),
    );
  }
  const out = "data/channelmax-uncrustables-minmax.txt";
  writeFileSync(out, lines.join("\r\n")); // CRLF — Windows-friendly for upload
  console.log(`Wrote ${rows.length} SKUs → ${out}`);
  console.log("Preview:");
  console.log(lines.slice(0, 6).join("\n"));
  console.warn(
    "IMPORTANT: this file sets safety bounds only. ChannelMAX repricing must be disabled for these SKU rows; promotions use Amazon Coupons.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
