// Сколько одновкусовых листингов ещё можно сделать: всё пространство минус уже
// собранное. Считаем в двух режимах — «прямо сейчас» (есть и художка, и UPC)
// и «после добычи штрихкодов» (художка есть).
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync } from "node:fs";
import {
  UNCRUSTABLES_FLAVORS, rationalBandFor, RENDER_LIMITS, type RecipeComponent,
} from "../src/lib/bundle-factory/uncrustables-box-planner";
import { resolveMergedUncrustablesPackageArt } from "../src/lib/bundle-factory/audit/uncrustables-authenticity-merged";

const SIZES = [4, 8, 10, 15, 18, 24];
const lkey = (c: RecipeComponent[]) => c.map((x) => `${x.flavor}:${x.cartonSize}:${x.qty}`).sort().join("|");

function layouts(sizes: number[]): number[][] {
  const out: number[][] = []; const s = [...sizes].sort((a, b) => b - a);
  const rec = (i: number, acc: number[], sum: number) => {
    if (acc.length) {
      const rows = Math.ceil(acc.length / RENDER_LIMITS.maxCartonsPerRow);
      if (sum >= 24 && sum <= 135 && rationalBandFor(sum) && rows <= RENDER_LIMITS.maxRows) out.push([...acc]);
    }
    if (sum > 135 || acc.length >= RENDER_LIMITS.maxCartons) return;
    for (let j = i; j < s.length; j++) rec(j, [...acc, s[j]], sum + s[j]);
  };
  rec(0, [], 0); return out;
}
const toComps = (flavor: string, l: number[]): RecipeComponent[] => {
  const by = new Map<number, number>();
  for (const s of l) by.set(s, (by.get(s) ?? 0) + 1);
  return [...by].sort((a, b) => b[0] - a[0]).map(([size, n]) => ({ flavor, qty: size * n, cartonSize: size }));
};

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const donors = await prisma.donorProduct.findMany({
    where: { OR: [{ title: { contains: "Uncrustable" } }, { productLine: "Uncrustables" }] },
    select: { title: true, upc: true, gtin: true },
  });
  const withUpc = new Set<string>();
  for (const d of donors) {
    if (!d.upc && !d.gtin) continue;
    const t = (d.title ?? "").toLowerCase();
    const m = t.match(/(\d+)\s*(?:ct\b|count\b|pk\b|pack\b)/i); if (!m) continue;
    for (const f of Object.keys(UNCRUSTABLES_FLAVORS)) {
      const w = f.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((x) => x.length >= 3);
      if (w.every((x) => t.includes(x))) withUpc.add(`${f}|${m[1]}`);
    }
  }
  const made = new Set((JSON.parse(readFileSync("data/batch200/recipes.json", "utf8")) as any[])
    .map((r) => lkey(r.comps)));

  let nowTotal = 0, artTotal = 0, madeCount = 0;
  const rows: string[] = [];
  for (const [flavor, meta] of Object.entries(UNCRUSTABLES_FLAVORS)) {
    const art = SIZES.filter((s) => resolveMergedUncrustablesPackageArt(flavor, "retail-carton", s));
    if (!art.length) continue;
    const ready = art.filter((s) => withUpc.has(`${flavor}|${s}`));
    const allL = layouts(art), nowL = layouts(ready);
    const freshNow = nowL.filter((l) => !made.has(lkey(toComps(flavor, l)))).length;
    const freshArt = allL.filter((l) => !made.has(lkey(toComps(flavor, l)))).length;
    const used = allL.length - freshArt;
    nowTotal += freshNow; artTotal += freshArt; madeCount += used;
    rows.push(`${meta.titleName.padEnd(26)} ${ready.join("/").padEnd(14)} ${String(freshNow).padStart(5)}   ${art.join("/").padEnd(16)} ${String(freshArt).padStart(5)}`);
  }
  console.log("вкус                       готовы сейчас  свободно   вся художка      свободно");
  for (const r of rows) console.log(r);
  console.log(`\nУЖЕ СОБРАНО: ${madeCount}`);
  console.log(`МОЖНО ПРЯМО СЕЙЧАС (художка + штрихкод): ${nowTotal}`);
  console.log(`МОЖНО ПОСЛЕ ДОБЫЧИ ШТРИХКОДОВ: ${artTotal}`);
  await prisma.$disconnect(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
