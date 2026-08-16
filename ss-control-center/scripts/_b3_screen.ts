// Прогон отсева по ВСЕМ кандидатам художки: для каждой пары «вкус × фасовка»
// перебираем все донорские фото (main + галерея) и берём первое чистое.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { writeFileSync } from "node:fs";
import { UNCRUSTABLES_FLAVORS } from "../src/lib/bundle-factory/uncrustables-box-planner";
import { resolveMergedUncrustablesPackageArt } from "../src/lib/bundle-factory/audit/uncrustables-authenticity-merged";
import { screenPackageArt } from "../src/lib/bundle-factory/audit/package-art-screen";
import { UNCRUSTABLES_DONOR_QUALIFIERS } from "../src/lib/bundle-factory/uncrustables-donor-resolver";

const SIZES = [4, 8, 10, 15, 18, 24];

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const donors = await prisma.donorProduct.findMany({
    where: { OR: [{ brand: { contains: "Uncrustable" } }, { title: { contains: "Uncrustable" } }, { productLine: "Uncrustables" }] },
    select: { title: true, mainImageUrl: true, imageUrls: true, bestPrice: true, bestRetailer: true },
  });

  const results: any[] = [];
  for (const [flavor, meta] of Object.entries(UNCRUSTABLES_FLAVORS)) {
    for (const size of SIZES) {
      if (resolveMergedUncrustablesPackageArt(flavor, "retail-carton", size)) continue;
      const re = new RegExp(`(?:^|[^0-9])${size}\\s*(?:ct\\b|count\\b|pk\\b|pack\\b)`, "i");
      const words = flavor.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length >= 3);
      // Дисквалификация как в donor-resolver: КАЖДЫЙ квалификатор, которого нет
      // в запрошенном вкусе, запрещён в заголовке донора. Иначе «Peanut Butter»
      // цепляет «Peanut Butter & Grape Jelly» — и виноградная коробка уходит в
      // художку арахисовой пасты. Это ровно тот класс, из-за которого летом
      // сотни живых плиток показывали чужой товар.
      const f = flavor.toLowerCase();
      const BAN = UNCRUSTABLES_DONOR_QUALIFIERS.filter((q) => !f.includes(q));
      const NEED = UNCRUSTABLES_DONOR_QUALIFIERS.filter((q) => f.includes(q));
      const rows = donors.filter((d: any) => {
        const t = (d.title ?? "").toLowerCase();
        if (!re.test(d.title ?? "")) return false;
        if (!words.every((w) => t.includes(w))) return false;
        if (BAN.some((q) => t.includes(q))) return false;
        if (!NEED.every((q) => t.includes(q))) return false;
        return true;
      });
      const candidates: { url: string; title: string; retailer: string | null; price: number | null }[] = [];
      for (const d of rows) {
        const urls = [d.mainImageUrl, ...(JSON.parse(d.imageUrls || "[]") as string[])].filter(Boolean);
        for (const u of urls) if (!candidates.some((c) => c.url === u)) candidates.push({ url: u as string, title: d.title, retailer: d.bestRetailer, price: d.bestPrice });
      }
      if (!candidates.length) continue;

      let winner: any = null; const rejected: string[] = [];
      for (const c of candidates.slice(0, 6)) {
        const v = await screenPackageArt({ image_url: c.url, expectedFlavor: meta.titleName, expectedCount: size });
        if (v.clean) { winner = { ...c, notes: v.observed?.notes }; break; }
        rejected.push(`${v.reasons.join("; ")}`);
      }
      results.push({ flavor, titleName: meta.titleName, size, winner, rejected, tried: Math.min(candidates.length, 6) });
      const mark = winner ? "✓ чистое" : "✗ чистого нет";
      console.log(`${meta.titleName.padEnd(24)} ${String(size).padStart(2)}шт  ${mark}  (кандидатов ${candidates.length})`);
      for (const r of rejected.slice(0, 2)) console.log(`      отбраковано: ${r.slice(0, 100)}`);
    }
  }
  writeFileSync("data/batch300/art-screen.json", JSON.stringify(results, null, 1));
  const ok = results.filter((r) => r.winner).length;
  console.log(`\nчистых фото найдено: ${ok} из ${results.length} пар`);
  await prisma.$disconnect(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
