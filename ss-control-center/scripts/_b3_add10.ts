// Клубника 10 и малина 10: чистые фото найдены вне нашего каталога
// (Shoppers Food / Wegmans), прошли машинный отсев и визуальную сверку.
// Обновляем фото у существующих донорских карточек и вносим в реестр v3.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fetchImageBuffer } from "../src/lib/walmart/multipack/composite";
import { resolveMergedUncrustablesPackageArt } from "../src/lib/bundle-factory/audit/uncrustables-authenticity-merged";

const DIR = "data/audits/uncrustables-owner-art-review-20260815";
const EXT = "src/lib/bundle-factory/audit/data/uncrustables-authenticity-registry-v3-extension.json";

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const found: any[] = JSON.parse(readFileSync("data/batch300/found10.json", "utf8"));
  const ext = JSON.parse(readFileSync(EXT, "utf8"));

  for (const f of found) {
    // Без указания фасовки резолвер честно отдаёт null, когда у вкуса уже
    // несколько утверждённых коробок — это и есть fail-closed на неоднозначность.
    // Поэтому flavor_id достаём через любую УЖЕ известную фасовку.
    let base = null as ReturnType<typeof resolveMergedUncrustablesPackageArt>;
    for (const probe of [4, 8, 10, 15, 18, 24]) {
      base = resolveMergedUncrustablesPackageArt(f.flavor, "retail-carton", probe);
      if (base) break;
    }
    if (!base) { console.log(`✗ ${f.flavor}: нет flavor_id`); continue; }

    // 1. фото в аудит + SHA
    const buf = await fetchImageBuffer(f.url);
    const sha = createHash("sha256").update(buf).digest("hex");
    const file = `${DIR}/${base.flavor_id}-${f.size}ct.jpg`;
    writeFileSync(file, buf);

    // 2. подменяем главное фото у донорских карточек этой фасовки:
    //    старое несло рекламную плашку ритейлера поверх снимка.
    const re = new RegExp(`(?:^|[^0-9])${f.size}\\s*(?:ct\\b|count\\b)`, "i");
    const rows = await prisma.donorProduct.findMany({
      where: { AND: [{ title: { contains: "Uncrustable" } }] },
      select: { id: true, title: true, mainImageUrl: true },
    });
    const words = f.flavor.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w: string) => w.length >= 3);
    let patched = 0;
    for (const r of rows) {
      const t = (r.title ?? "").toLowerCase();
      if (!re.test(r.title ?? "")) continue;
      if (!words.every((w: string) => t.includes(w))) continue;
      if (/whole wheat|protein|reduced sugar/.test(t)) continue;
      await prisma.donorProduct.update({ where: { id: r.id }, data: { mainImageUrl: f.url, needsReview: false } });
      patched++;
    }

    // 3. в расширение реестра
    const entry = ext.flavors.find((x: any) => x.flavor_id === base.flavor_id)
      ?? (ext.flavors.push({ flavor_id: base.flavor_id, art: [] }), ext.flavors[ext.flavors.length - 1]);
    if (!entry.art.some((a: any) => a.retail_pack_size === f.size && a.pack_mode === "retail-carton")) {
      entry.art.push({
        art_id: `${base.flavor_id}-carton-us-${f.size}ct-2026-v3`,
        pack_mode: "retail-carton", retail_pack_size: f.size, market: "US",
        brand_marks: ["Smucker's", "Uncrustables"],
        evidence: [{ kind: "reviewed-artifact", locator: file, sha256: sha }],
      });
    }
    console.log(`✓ ${f.titleName} ${f.size}шт — ${f.source}, карточек обновлено ${patched}, sha ${sha.slice(0, 12)}…`);
  }
  ext.review_note += " Strawberry 10ct and Raspberry 10ct were added on the same day " +
    "from Shoppers Food and Wegmans after every photo in our own catalog turned out " +
    "to carry a retailer overlay banner; both passed screenPackageArt and visual check.";
  writeFileSync(EXT, JSON.stringify(ext, null, 2) + "\n");
  console.log(`\nхудожек в расширении: ${ext.flavors.reduce((s: number, x: any) => s + x.art.length, 0)}`);
  await prisma.$disconnect(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
