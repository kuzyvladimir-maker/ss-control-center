import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { prisma } from "@/lib/prisma";
import { rationalBandFor, UNCRUSTABLES_FLAVORS } from "@/lib/bundle-factory/uncrustables-box-planner";

async function main() {
  const donors = await prisma.donorProduct.findMany({
    where: { OR: [{ brand: { contains: "Uncrustable" } }, { title: { contains: "Uncrustable" } }] },
    select: { title: true, mainImageUrl: true },
  });
  // какие carton size реально имеют ФОТО у каждого вкуса из каталога
  const sizes = new Map<string, Set<number>>();
  for (const [key, f] of Object.entries(UNCRUSTABLES_FLAVORS)) {
    const set = new Set<number>();
    for (const d of donors) {
      if (!d.mainImageUrl) continue;
      const t = (d.title ?? "").toLowerCase();
      const words = key.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length >= 3);
      if (!words.every((w) => t.includes(w))) continue;
      const m = t.match(/(\d+)\s*(?:ct|count)/);
      if (m && [4, 8, 10, 15, 18].includes(Number(m[1]))) set.add(Number(m[1]));
    }
    if (set.size) sizes.set(key, set);
    else sizes.set(key, new Set([f.cartonSize]));
  }
  // перебор мультимножеств коробок (одинаковый вкус, размеры могут смешиваться)
  const rows: { flavor: string; total: number; cartons: number; rowsN: number; mix: string }[] = [];
  for (const [flavor, sizeSet] of sizes) {
    const S = [...sizeSet].sort((a, b) => b - a);
    const best = new Map<number, { cartons: number; mix: number[] }>();
    const rec = (i: number, acc: number[], sum: number) => {
      if (acc.length > 11) return;
      if (sum >= 24 && sum <= 135 && rationalBandFor(sum) && acc.length >= 1) {
        const cur = best.get(sum);
        if (!cur || acc.length < cur.cartons) best.set(sum, { cartons: acc.length, mix: [...acc] });
      }
      if (sum > 135 || i >= S.length) return;
      for (let j = i; j < S.length; j++) rec(j, [...acc, S[j]], sum + S[j]);
    };
    rec(0, [], 0);
    for (const [total, v] of best) {
      const rowsN = Math.ceil(v.cartons / 4);
      if (rowsN > 4) continue;
      const counts = new Map<number, number>();
      for (const s of v.mix) counts.set(s, (counts.get(s) ?? 0) + 1);
      rows.push({ flavor, total, cartons: v.cartons, rowsN,
        mix: [...counts].sort((a,b)=>b[0]-a[0]).map(([s, n]) => `${s}ct×${n}`).join(" + ") });
    }
  }
  rows.sort((a, b) => a.flavor.localeCompare(b.flavor) || a.total - b.total);
  console.log(`ВСЕГО одновкусовых вариантов: ${rows.length}`);
  const byRows: Record<number, number> = {}; for (const r of rows) byRows[r.rowsN] = (byRows[r.rowsN]??0)+1;
  console.log(`по рядам: ${JSON.stringify(byRows)}`);
  console.log(`вкусов: ${new Set(rows.map(r=>r.flavor)).size}`);
  console.log("\nразмеры коробок с фото по вкусам:");
  for (const [f, s] of sizes) console.log(`  ${f.padEnd(46)} ${[...s].sort((a,b)=>a-b).join(", ")}`);
  require("node:fs").writeFileSync("/private/tmp/claude-501/-Users-vladimirkuznetsov-SS-Command-Center/1dbdc77d-9c20-49be-9e0d-c48b604008f6/scratchpad/space.json", JSON.stringify(rows, null, 1));
  await prisma.$disconnect();
}
main();
