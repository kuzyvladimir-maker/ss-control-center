// Оставшиеся раскладки пересобираем на фасовках с известным UPC производителя.
// Стейджинг требует его как доказательство того, ЧТО ИМЕННО мы перепродаём;
// новые клубные коробки 15/18/24 пришли без штрихкода, и пока он не добыт,
// эти фасовки в рецепты не идут. Каунт сохраняем — меняется только раскладка.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, writeFileSync } from "node:fs";
import {
  UNCRUSTABLES_FLAVORS, validateRecipe, RENDER_LIMITS, rationalBandFor,
  type RecipeComponent,
} from "../src/lib/bundle-factory/uncrustables-box-planner";
import { resolveMergedUncrustablesPackageArt } from "../src/lib/bundle-factory/audit/uncrustables-authenticity-merged";

const short = (f: string) => UNCRUSTABLES_FLAVORS[f].titleName.toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 18);
const lkey = (c: RecipeComponent[]) => c.map((x) => `${x.flavor}:${x.cartonSize}:${x.qty}`).sort().join("|");

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const donors = await prisma.donorProduct.findMany({
    where: { OR: [{ title: { contains: "Uncrustable" } }, { productLine: "Uncrustables" }] },
    select: { title: true, upc: true, gtin: true },
  });
  // фасовки, у которых есть хоть один донор с UPC производителя
  // UPC проверяем по ПАРЕ вкус+фасовка: у пятнашки клубники штрихкод есть,
  // а у пятнашки ореха нет — «фасовка с UPC» вообще не то понятие.
  const okPairs = new Set<string>();
  for (const d of donors) {
    if (!d.upc && !d.gtin) continue;
    const t = (d.title ?? "").toLowerCase();
    const m = t.match(/(\d+)\s*(?:ct\b|count\b|pk\b|pack\b)/i);
    if (!m) continue;
    for (const f of Object.keys(UNCRUSTABLES_FLAVORS)) {
      const words = f.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length >= 3);
      if (words.every((w) => t.includes(w))) okPairs.add(`${f}|${m[1]}`);
    }
  }
  console.log("пар вкус+фасовка с UPC:", okPairs.size);

  const state = JSON.parse(readFileSync("data/batch200/auto-state.json", "utf8"));
  const queue: any[] = JSON.parse(readFileSync("data/batch300/b4-queue.json", "utf8"));
  const recipes: any[] = JSON.parse(readFileSync("data/batch200/recipes.json", "utf8"));
  const seen = new Set(recipes.map((r) => lkey(r.comps)));
  const seenSlug = new Set(recipes.map((r) => r.slug));

  const stuck = queue.filter((q) => !state.done.includes(q.slug));
  console.log(`не доведено: ${stuck.length}\n`);
  const add: any[] = [];
  for (const q of stuck) {
    const flavor = q.comps[0].flavor;
    const total = q.comps.reduce((s: number, c: any) => s + c.qty, 0);
    const sizes = [24, 18, 15, 10, 8, 4].filter((s) =>
      okPairs.has(`${flavor}|${s}`) && resolveMergedUncrustablesPackageArt(flavor, "retail-carton", s));
    let best: number[] | null = null;
    const rec = (i: number, acc: number[], sum: number) => {
      if (sum === total) {
        if (acc.length <= RENDER_LIMITS.maxCartons
          && Math.ceil(acc.length / RENDER_LIMITS.maxCartonsPerRow) <= RENDER_LIMITS.maxRows
          && (!best || acc.length < best.length)) best = [...acc];
        return;
      }
      if (sum > total || acc.length >= RENDER_LIMITS.maxCartons) return;
      for (let j = i; j < sizes.length; j++) rec(j, [...acc, sizes[j]], sum + sizes[j]);
    };
    rec(0, [], 0);
    if (!best || !rationalBandFor(total)) { console.log(`  ✗ ${short(flavor)} ${total} — на фасовках с UPC не собирается`); continue; }
    const by = new Map<number, number>();
    for (const s of best as number[]) by.set(s, (by.get(s) ?? 0) + 1);
    const comps: RecipeComponent[] = [...by].sort((a, b) => b[0] - a[0])
      .map(([size, n]) => ({ flavor, qty: size * n, cartonSize: size }));
    if (validateRecipe(comps).length) { console.log(`  ✗ ${short(flavor)} ${total} — невалидна`); continue; }
    const k = lkey(comps);
    if (seen.has(k)) { console.log(`  ↷ ${short(flavor)} ${total} — такая уже есть`); continue; }
    const boxes = comps.map((c) => `${c.qty / (c.cartonSize as number)}x${c.cartonSize}`).join("-");
    const slug = `b6-${short(flavor)}-${total}-${boxes}`.slice(0, 70);
    if (seenSlug.has(slug)) continue;
    seen.add(k); seenSlug.add(slug);
    add.push({ slug, comps, kind: "requeue" });
    console.log(`  ✓ ${String(total).padStart(3)}шт ${short(flavor).padEnd(20)} → ${boxes}`);
  }
  writeFileSync("data/batch200/recipes.json", JSON.stringify([...recipes, ...add], null, 1));
  writeFileSync("data/batch300/b4-queue.json", JSON.stringify([...queue, ...add], null, 1));
  console.log(`\nдобавлено: ${add.length}`);
  await prisma.$disconnect(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
