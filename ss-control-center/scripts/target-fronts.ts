// Target clean-front merge: for the neighbor's DONOR_FAIL queue (banner Walmart mains),
// fetch the product on Target (scene7 = clean product-only images), and PREPEND those
// to the donor's gallery so the image chat's pickBestFront finds a clean front. ~1cr/SKU.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
import { unwrangleSearch } from "@/lib/sourcing/retail-fetch";
const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
const isBanner = (u: string) => /i5\.walmartimages|\/seo\/|\/asr\//i.test(u || "");
(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const p = (await db.execute(`SELECT value FROM "Setting" WHERE key='enrich_priority_skus' LIMIT 1`)).rows[0];
  let skus: string[] = []; try { skus = JSON.parse(String((p as any)?.value || "[]")); } catch { /* */ }
  const LIMIT = Number(process.env.LIMIT || skus.length);
  skus = skus.slice(0, LIMIT);
  console.log(`TARGET-FRONTS for ${skus.length} priority SKUs`);
  let idx = 0, merged = 0, noTarget = 0, skip = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (true) {
      const i = idx++; if (i >= skus.length) break;
      const dp: any = (await db.execute({ sql: `SELECT dp.id, dp.title, dp.brand, dp.imageUrls, dp.mainImageUrl FROM "SkuComponent" sc JOIN "DonorProduct" dp ON dp.id=sc.donorProductId WHERE sc.sku=? AND sc.idx=0 LIMIT 1`, args: [skus[i]] })).rows[0];
      if (!dp) { skip++; continue; }
      let gallery: string[] = []; try { gallery = JSON.parse(dp.imageUrls || "[]"); } catch { /* */ }
      const hasClean = gallery.some((u) => !isBanner(u));
      if (hasClean && dp.mainImageUrl && !isBanner(dp.mainImageUrl)) { skip++; continue; } // already clean
      try {
        const r = await unwrangleSearch("target", String(dp.title));
        const brandTok = norm(String(dp.brand || dp.title))[0];
        const cand = r.offers.find((o: any) => o.imageUrls?.length && (!brandTok || norm(o.title || "").includes(brandTok)));
        if (!cand) { noTarget++; continue; }
        const targetImgs = (cand.imageUrls || []).filter(Boolean);
        // Prepend clean Target images, dedup, keep the old gallery after.
        const seen = new Set<string>(); const out: string[] = [];
        for (const u of [...targetImgs, ...gallery]) { if (u && !seen.has(u)) { seen.add(u); out.push(u); } }
        await db.execute({ sql: `UPDATE "DonorProduct" SET imageUrls=?, mainImageUrl=?, needsReview=0, updatedAt=? WHERE id=?`, args: [JSON.stringify(out.slice(0, 12)), targetImgs[0] || dp.mainImageUrl, new Date().toISOString(), dp.id] });
        merged++;
      } catch { noTarget++; }
      if ((merged + noTarget + skip) % 20 === 0) console.log(`  ${merged + noTarget + skip}/${skus.length} | merged ${merged} | no-target ${noTarget} | skip ${skip}`);
    }
  }));
  console.log(`\nDONE. merged clean Target fronts: ${merged} | no target match: ${noTarget} | already clean/skip: ${skip}`);
  process.exit(0);
})();
