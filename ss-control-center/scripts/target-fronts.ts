// Target clean-front merge (STRICT, self-correcting). For the neighbor's DONOR_FAIL
// queue (banner Walmart mains), fetch the product on Target (scene7 = clean product-
// only) and prepend those images ONLY when the Target result is the SAME VARIANT.
//
// v1 matched by brand alone → grabbed a clean image of a DIFFERENT variant (Snyder's
// Seasoned→Dipping, Cheetos Flamin'Hot→XXTRA, Pink→Zero-Sugar Lemonade). v2: the
// meaningful token set (title minus brand/filler/size/container) must be EQUAL — no
// missing and no extra variant word. Better to NOT merge (fall back to the Walmart
// gallery) than merge a wrong variant. Self-correcting: strips any prior target.scene7
// merge first, so a re-run reverts v1's mistakes.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
import { unwrangleSearch } from "@/lib/sourcing/retail-fetch";

const GENERIC = new Set(["the", "and", "with", "for", "of", "a", "an", "size", "oz", "lb", "lbs", "fl", "ml", "g", "kg", "ct", "count", "pack", "pk", "box", "boxes", "can", "cans", "bag", "bags", "cup", "cups", "pouch", "pouches", "jar", "bottle", "bottles", "loaf", "tray", "case", "each", "sticks", "stick", "family", "sharing", "share", "value", "twin", "snack", "snacks", "brand", "new", "hanover", "inc", "llc"]);
const isBanner = (u: string) => /i5\.walmartimages|\/seo\/|\/asr\//i.test(u || "");
const words = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

// Meaningful tokens = title words minus brand (first 2 words), generic/container/size, numbers.
function meaningful(title: string): Set<string> {
  const w = words(title);
  const brand = new Set(w.slice(0, 2));
  const out = new Set<string>();
  for (const t of w) {
    if (t.length < 3 || GENERIC.has(t) || brand.has(t)) continue;
    if (/^\d+(\.\d+)?$/.test(t)) continue;                 // pure number (size)
    if (/^\d+(oz|lb|ml|g|ct|pk|pack)$/.test(t)) continue;   // 12oz etc
    out.add(t);
  }
  return out;
}
// SAME variant: donor's meaningful tokens ⊆ target's AND target adds no meaningful word
// the donor lacks (set equality). Rejects both MISSING (Dipping) and EXTRA (XXTRA / Zero
// / Whole) variant words — the exact class the image chat's tile-QC caught.
function sameVariant(donorTitle: string, targetTitle: string): boolean {
  const D = meaningful(donorTitle), T = meaningful(targetTitle);
  if (!D.size) return false;
  for (const d of D) if (!T.has(d)) return false;   // donor variant word missing in target
  for (const t of T) if (!D.has(t)) return false;   // target introduces a variant word
  return true;
}

(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const p = (await db.execute(`SELECT value FROM "Setting" WHERE key='enrich_priority_skus' LIMIT 1`)).rows[0];
  let skus: string[] = []; try { skus = JSON.parse(String((p as any)?.value || "[]")); } catch { /* */ }
  const LIMIT = Number(process.env.LIMIT || skus.length);
  skus = skus.slice(0, LIMIT);
  console.log(`TARGET-FRONTS v2 (strict same-variant) for ${skus.length} priority SKUs`);
  let idx = 0, merged = 0, reverted = 0, noMatch = 0, skip = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (true) {
      const i = idx++; if (i >= skus.length) break;
      const dp: any = (await db.execute({ sql: `SELECT dp.id, dp.title, dp.imageUrls, dp.mainImageUrl FROM "SkuComponent" sc JOIN "DonorProduct" dp ON dp.id=sc.donorProductId WHERE sc.sku=? AND sc.idx=0 LIMIT 1`, args: [skus[i]] })).rows[0];
      if (!dp) { skip++; continue; }
      let gallery: string[] = []; try { gallery = JSON.parse(dp.imageUrls || "[]"); } catch { /* */ }

      // UNDO any prior target.scene7 merge → back to the original (Walmart) gallery.
      const hadTarget = gallery.some((u) => /target\.scene7/i.test(u));
      const walmartGallery = gallery.filter((u) => !/target\.scene7/i.test(u));
      const walmartMain = walmartGallery.find((u) => !isBanner(u)) || walmartGallery[0] || null;

      let newGallery = walmartGallery, newMain: string | null = walmartMain, didMerge = false;
      try {
        const r = await unwrangleSearch("target", String(dp.title));
        const cand = r.offers.find((o: any) => o.imageUrls?.length && sameVariant(String(dp.title), String(o.title || "")));
        if (cand) {
          const timgs = (cand.imageUrls || []).filter(Boolean);
          const seen = new Set<string>(); const out: string[] = [];
          for (const u of [...timgs, ...walmartGallery]) { if (u && !seen.has(u)) { seen.add(u); out.push(u); } }
          newGallery = out.slice(0, 12); newMain = timgs[0]; didMerge = true;
        }
      } catch { /* leave the Walmart gallery */ }

      if (didMerge) merged++;
      else if (hadTarget) reverted++;   // v1 had merged a WRONG target → reverted here
      else noMatch++;

      if (didMerge || hadTarget) {
        await db.execute({ sql: `UPDATE "DonorProduct" SET imageUrls=?, mainImageUrl=?, needsReview=0, updatedAt=? WHERE id=?`, args: [JSON.stringify(newGallery), newMain, new Date().toISOString(), dp.id] });
      }
      if ((merged + reverted + noMatch + skip) % 20 === 0) console.log(`  ${merged + reverted + noMatch + skip}/${skus.length} | merged ${merged} | reverted-bad ${reverted} | no-match ${noMatch}`);
    }
  }));
  console.log(`\nDONE. correct Target merges: ${merged} | reverted v1 bad merges: ${reverted} | no strict match (kept Walmart): ${noMatch} | skip ${skip}`);
  process.exit(0);
})();
