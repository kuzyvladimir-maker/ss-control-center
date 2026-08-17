// ПЕРЕСБОРКА БРАКА. Замер 2026-08-16: сцены из многих мелких коробок модель
// путает заметно чаще — «carton total 6 vs expected 7» и опечатки на лицевой
// панели идут именно с них. Тот же каунт, но раскладка с МИНИМУМОМ коробок:
// три десятки в один ряд рисуются надёжнее, чем семь четвёрок в два.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, writeFileSync } from "node:fs";
import {
  UNCRUSTABLES_FLAVORS, validateRecipe, RENDER_LIMITS, type RecipeComponent,
} from "../src/lib/bundle-factory/uncrustables-box-planner";
import { resolveMergedUncrustablesPackageArt } from "../src/lib/bundle-factory/audit/uncrustables-authenticity-merged";

const SIZES = [24, 18, 15, 10, 8, 4];
const short = (f: string) => UNCRUSTABLES_FLAVORS[f].titleName.toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 18);
const layoutKey = (c: RecipeComponent[]) =>
  c.map((x) => `${x.flavor}:${x.cartonSize}:${x.qty}`).sort().join("|");

/** Минимальное число коробок для каунта из утверждённых фасовок вкуса. */
function fewestCartons(flavor: string, total: number): number[] | null {
  const ok = SIZES.filter((s) => resolveMergedUncrustablesPackageArt(flavor, "retail-carton", s));
  let best: number[] | null = null;
  const rec = (i: number, acc: number[], sum: number) => {
    if (sum === total) {
      if (acc.length <= RENDER_LIMITS.maxCartons
        && Math.ceil(acc.length / RENDER_LIMITS.maxCartonsPerRow) <= RENDER_LIMITS.maxRows
        && (!best || acc.length < best.length)) best = [...acc];
      return;
    }
    if (sum > total || acc.length >= RENDER_LIMITS.maxCartons) return;
    for (let j = i; j < ok.length; j++) rec(j, [...acc, ok[j]], sum + ok[j]);
  };
  rec(0, [], 0);
  return best;
}

const state = JSON.parse(readFileSync("data/batch200/auto-state.json", "utf8"));
const queue: any[] = JSON.parse(readFileSync("data/batch300/b4-queue.json", "utf8"));
const recipes: any[] = JSON.parse(readFileSync("data/batch200/recipes.json", "utf8"));
const seen = new Set(recipes.map((r) => layoutKey(r.comps)));
const seenSlug = new Set(recipes.map((r) => r.slug));

const failed = queue.filter((q) => state.failed.includes(q.slug));
console.log(`в браке: ${failed.length}\n`);
const add: any[] = [];
for (const f of failed) {
  const flavor = f.comps[0].flavor;
  const total = f.comps.reduce((s: number, c: any) => s + c.qty, 0);
  const was = f.comps.reduce((s: number, c: any) => s + c.qty / c.cartonSize, 0);
  const better = fewestCartons(flavor, total);
  if (!better) { console.log(`  ✗ ${f.slug} — другой раскладки на ${total} нет`); continue; }
  if (better.length >= was) { console.log(`  ↷ ${f.slug} — ${was} коробок уже минимум`); continue; }
  const by = new Map<number, number>();
  for (const s of better) by.set(s, (by.get(s) ?? 0) + 1);
  const comps: RecipeComponent[] = [...by].sort((a, b) => b[0] - a[0])
    .map(([size, n]) => ({ flavor, qty: size * n, cartonSize: size }));
  if (validateRecipe(comps).length) { console.log(`  ✗ ${f.slug} — новая раскладка невалидна`); continue; }
  const key = layoutKey(comps);
  if (seen.has(key)) { console.log(`  ↷ ${f.slug} — такая раскладка уже есть`); continue; }
  const boxes = comps.map((c) => `${c.qty / (c.cartonSize as number)}x${c.cartonSize}`).join("-");
  const slug = `b5-${short(flavor)}-${total}-${boxes}`.slice(0, 70);
  if (seenSlug.has(slug)) continue;
  seen.add(key); seenSlug.add(slug);
  add.push({ slug, comps, kind: "rework" });
  console.log(`  ✓ ${String(total).padStart(3)}шт: было ${was} коробок → стало ${better.length} (${boxes})`);
}
writeFileSync("data/batch200/recipes.json", JSON.stringify([...recipes, ...add], null, 1));
const q2 = [...queue, ...add];
writeFileSync("data/batch300/b4-queue.json", JSON.stringify(q2, null, 1));
console.log(`\nдобавлено в очередь: ${add.length}`);
