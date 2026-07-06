// FINAL merge: authoritative per-SKU verdict = v2 (real-title re-judge) where it
// exists, else v1. Then cross-tab against Walmart item-level truth (LIVE/SAFE) so the
// numbers are (a) identity-reliable and (b) reflect what is ACTUALLY live. Produces
// the definitive damage table + the actionable fix lists by type, live-only.
import { readFileSync, writeFileSync } from "node:fs";
const v1 = JSON.parse(readFileSync("_reaudit686_result.json", "utf8"));
const v2 = JSON.parse(readFileSync("_reaudit_v2_result.json", "utf8"));
const truth = JSON.parse(readFileSync("_feedtruth_all.json", "utf8")); // sku -> LIVE|SAFE
const v2by: Record<string, any> = {}; for (const r of v2) v2by[r.sku] = r;
// final verdict per sku
const final = v1.map((x: any) => {
  const o = v2by[x.sku];
  return { sku: x.sku, defect: o ? o.now : x.defect, title: (o?.title || x.title || ""), units: o?.units ?? x.realUnits, url: x.url, reason: o?.reason ?? x.reason, corrected: !!o, live: truth[x.sku] || "UNKNOWN" };
});
writeFileSync("_final_audit.json", JSON.stringify(final, null, 2));
// overall
const cnt: Record<string, number> = {}; for (const x of final) cnt[x.defect] = (cnt[x.defect] || 0) + 1;
const okTotal = cnt["OK"] || 0; const defTotal = final.length - okTotal;
console.log(`FINAL audit of ${final.length} touched listings`);
console.log(`  OK (identity-verified where title existed): ${okTotal}`);
console.log(`  DEFECTIVE: ${defTotal}\n`);
// live-only defective by type
const order = ["wrong-product", "multipack-in-cell", "not-face-on", "not-multipack", "colored-bg", "wrong-count", "no-image", "other-fail"];
console.log("defect".padEnd(20) + "TOTAL".padEnd(8) + "LIVE".padEnd(8) + "SAFE".padEnd(8) + "UNKNOWN");
for (const d of order) {
  const rows = final.filter((x: any) => x.defect === d); if (!rows.length) continue;
  const live = rows.filter((x: any) => x.live === "LIVE").length;
  const safe = rows.filter((x: any) => x.live === "SAFE").length;
  const unk = rows.filter((x: any) => x.live === "UNKNOWN").length;
  console.log(d.padEnd(20) + String(rows.length).padEnd(8) + String(live).padEnd(8) + String(safe).padEnd(8) + String(unk));
}
const liveDef = final.filter((x: any) => x.defect !== "OK" && x.live === "LIVE");
const safeDef = final.filter((x: any) => x.defect !== "OK" && x.live === "SAFE");
console.log(`\nTRULY LIVE + DEFECTIVE (real damage): ${liveDef.length}`);
console.log(`SAFE (ingestion failed, not live): ${safeDef.length}`);
// OK live count (the good ones we can keep)
const okLive = final.filter((x: any) => x.defect === "OK" && x.live === "LIVE").length;
console.log(`OK + LIVE (clean & live): ${okLive}`);
// fix-list files (live-defective, by action)
const revert = liveDef.filter((x: any) => x.defect === "not-multipack");
const rebuild = liveDef.filter((x: any) => ["wrong-product", "multipack-in-cell", "not-face-on", "colored-bg", "wrong-count", "no-image", "other-fail"].includes(x.defect));
writeFileSync("_fix_revert.json", JSON.stringify(revert, null, 2));
writeFileSync("_fix_rebuild.json", JSON.stringify(rebuild, null, 2));
console.log(`\nFIX LISTS (live only): revert=${revert.length}  rebuild=${rebuild.length}`);
