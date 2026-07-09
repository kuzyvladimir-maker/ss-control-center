// FREE Open Food Facts backfill: fill nutrition/ingredients for donors that already
// have a UPC but no structured nutrition. $0 (no Unwrangle) — pure OFF by barcode.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
async function off(upc: string): Promise<{ ing: string | null; nut: string | null } | null> {
  const code = String(upc).replace(/\D/g, ""); if (code.length < 8) return null;
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=ingredients_text,nutriments,allergens_tags`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null; const j: any = await r.json(); if (j?.status !== 1 || !j.product) return null; const p = j.product;
    const ing = typeof p.ingredients_text === "string" && p.ingredients_text.trim() ? decode(p.ingredients_text).slice(0, 2000) : null;
    const allg = Array.isArray(p.allergens_tags) ? p.allergens_tags.map((a: string) => a.replace(/^en:/, "")) : [];
    const nutObj = p.nutriments && Object.keys(p.nutriments).length ? { ...p.nutriments, ...(allg.length ? { allergens: allg } : {}) } : null;
    if (!ing && !nutObj) return null;
    return { ing, nut: nutObj ? JSON.stringify(nutObj).slice(0, 6000) : null };
  } catch { return null; }
}
(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const rows = (await db.execute(`SELECT id, COALESCE(upc,gtin) AS upc FROM "DonorProduct"
    WHERE COALESCE(upc,gtin) IS NOT NULL AND (nutritionFacts IS NULL OR nutritionFacts='' OR nutritionFacts='[]' OR ingredients IS NULL OR ingredients='')`)).rows as any[];
  console.log(`OFF backfill candidates (UPC, missing nutrition/ingredients): ${rows.length}`);
  let idx = 0, filled = 0, miss = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (true) {
      const i = idx++; if (i >= rows.length) break;
      const r = rows[i]; const d = await off(String(r.upc));
      if (d && (d.ing || d.nut)) {
        await db.execute({ sql: `UPDATE "DonorProduct" SET ingredients=COALESCE(?, ingredients), nutritionFacts=COALESCE(?, nutritionFacts), updatedAt=? WHERE id=?`, args: [d.ing, d.nut, new Date().toISOString(), r.id] });
        filled++;
      } else miss++;
      if ((filled + miss) % 100 === 0) console.log(`  ${filled + miss}/${rows.length} | filled ${filled} | not-in-OFF ${miss}`);
    }
  }));
  console.log(`\nDONE. filled ${filled} | not in OFF ${miss} | (Unwrangle spent: 0)`);
  process.exit(0);
})();
