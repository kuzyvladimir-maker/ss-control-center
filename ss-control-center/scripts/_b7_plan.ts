// ПАРТИЯ-7: все одновкусовые раскладки, доступные СЕЙЧАС (утверждённая художка
// + штрихкод производителя). Круговой обход вкусов, чтобы партия шла
// разнообразной, а не сплошной малиной.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, writeFileSync } from "node:fs";
import {
  UNCRUSTABLES_FLAVORS, rationalBandFor, RENDER_LIMITS, validateRecipe, type RecipeComponent,
} from "../src/lib/bundle-factory/uncrustables-box-planner";
import { resolveMergedUncrustablesPackageArt } from "../src/lib/bundle-factory/audit/uncrustables-authenticity-merged";

const SIZES = [4, 8, 10, 15, 18, 24];
const short = (f: string) => UNCRUSTABLES_FLAVORS[f].titleName.toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 18);
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
  const recipes: any[] = JSON.parse(readFileSync("data/batch200/recipes.json", "utf8"));
  const made = new Set(recipes.map((r) => lkey(r.comps)));
  const seenSlug = new Set(recipes.map((r) => r.slug));

  const pool = new Map<string, RecipeComponent[][]>();
  for (const flavor of Object.keys(UNCRUSTABLES_FLAVORS)) {
    const ready = SIZES.filter((s) =>
      withUpc.has(`${flavor}|${s}`) && resolveMergedUncrustablesPackageArt(flavor, "retail-carton", s));
    if (!ready.length) continue;
    const fresh = layouts(ready).map((l) => toComps(flavor, l))
      .filter((c) => !made.has(lkey(c)) && !validateRecipe(c).length);
    // мелкие полосы вперёд: дешевле в закупке, быстрее оборачиваются
    fresh.sort((a, b) => a.reduce((s, c) => s + c.qty, 0) - b.reduce((s, c) => s + c.qty, 0));
    if (fresh.length) pool.set(flavor, fresh);
  }
  const order = [...pool.keys()];
  const idx = new Map(order.map((f) => [f, 0]));
  const out: any[] = [];
  let guard = 0;
  while (guard++ < 100000) {
    let added = false;
    for (const f of order) {
      const list = pool.get(f)!; let i = idx.get(f)!;
      if (i >= list.length) continue;
      const comps = list[i]; idx.set(f, i + 1);
      const total = comps.reduce((s, c) => s + c.qty, 0);
      const boxes = comps.map((c) => `${c.qty / (c.cartonSize as number)}x${c.cartonSize}`).join("-");
      const slug = `b7-${short(f)}-${total}-${boxes}`.slice(0, 70);
      if (seenSlug.has(slug)) continue;
      seenSlug.add(slug); made.add(lkey(comps));
      out.push({ slug, comps, kind: "single" });
      added = true;
    }
    if (!added) break;
  }
  writeFileSync("data/batch200/recipes.json", JSON.stringify([...recipes, ...out], null, 1));
  writeFileSync("data/batch300/b4-queue.json", JSON.stringify(out, null, 1));
  const byF = new Map<string, number>();
  for (const r of out) byF.set(UNCRUSTABLES_FLAVORS[r.comps[0].flavor].titleName,
    (byF.get(UNCRUSTABLES_FLAVORS[r.comps[0].flavor].titleName) ?? 0) + 1);
  console.log(`в очередь: ${out.length}`);
  console.log([...byF].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(" · "));
  await prisma.$disconnect(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
