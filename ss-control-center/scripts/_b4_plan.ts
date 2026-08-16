// НОЧНАЯ ОЧЕРЕДЬ: 7 восстановлений + одновкусовые по РАСКЛАДКАМ.
// Дедуп по полной раскладке, а не по сумме: 54 из трёх восемнадцаток и 54 из
// пяти десяток с четвёркой — разные листинги (владелец 2026-08-15).
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, writeFileSync } from "node:fs";
import {
  UNCRUSTABLES_FLAVORS, rationalBandFor, validateRecipe, RENDER_LIMITS,
  type RecipeComponent,
} from "../src/lib/bundle-factory/uncrustables-box-planner";
import { resolveMergedUncrustablesPackageArt } from "../src/lib/bundle-factory/audit/uncrustables-authenticity-merged";

const TARGET = Number(process.env.TARGET ?? 130);
const SIZES = [4, 8, 10, 15, 18, 24];
// Приоритет по истории продаж: виноград и клубника — лидеры оборота.
const PRIORITY = ["Peanut Butter & Grape Jelly", "Peanut Butter & Strawberry Jam",
  "Peanut Butter & Raspberry Spread", "Chocolate Flavored Hazelnut Spread",
  "Peanut Butter & Honey Spread"];

const short = (f: string) => UNCRUSTABLES_FLAVORS[f].titleName.toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 18);
const layoutKey = (c: RecipeComponent[]) =>
  c.map((x) => `${x.flavor}:${x.cartonSize}:${x.qty}`).sort().join("|");

// раскладки одного вкуса из утверждённых коробок
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
const toComps = (flavor: string, layout: number[]): RecipeComponent[] => {
  const by = new Map<number, number>();
  for (const s of layout) by.set(s, (by.get(s) ?? 0) + 1);
  return [...by].sort((a, b) => b[0] - a[0]).map(([size, n]) => ({ flavor, qty: size * n, cartonSize: size }));
};

const existing: any[] = JSON.parse(readFileSync("data/batch200/recipes.json", "utf8"));
const seen = new Set(existing.map((r) => layoutKey(r.comps)));
const seenSlug = new Set(existing.map((r) => r.slug));
const out: { slug: string; comps: RecipeComponent[]; kind: string }[] = [];

function push(kind: string, comps: RecipeComponent[]) {
  if (validateRecipe(comps).length) return false;
  const k = layoutKey(comps);
  if (seen.has(k)) return false;
  const total = comps.reduce((s, c) => s + c.qty, 0);
  const boxes = comps.map((c) => `${c.qty / (c.cartonSize as number)}x${c.cartonSize}`).join("-");
  let slug = `b4-${comps.map((c) => short(c.flavor)).join("-")}-${total}-${boxes}`.slice(0, 70);
  if (seenSlug.has(slug)) return false;
  seen.add(k); seenSlug.add(slug);
  out.push({ slug, comps, kind });
  return true;
}

// ── 1. ВОССТАНОВЛЕНИЯ (исторические листинги, удалённые в апреле)
const REST: [string, RecipeComponent[]][] = [
  ["Strawberry 30", [{ flavor: "Peanut Butter & Strawberry Jam", qty: 30, cartonSize: 10 }]],
  ["Chocolate Hazelnut 30", [{ flavor: "Chocolate Flavored Hazelnut Spread", qty: 30, cartonSize: 10 }]],
  ["Honey 28", [{ flavor: "Peanut Butter & Honey Spread", qty: 20, cartonSize: 10 }, { flavor: "Peanut Butter & Honey Spread", qty: 8, cartonSize: 4 }]],
  ["Strawberry 64", [{ flavor: "Peanut Butter & Strawberry Jam", qty: 24, cartonSize: 24 }, { flavor: "Peanut Butter & Strawberry Jam", qty: 30, cartonSize: 15 }, { flavor: "Peanut Butter & Strawberry Jam", qty: 10, cartonSize: 10 }]],
];
for (const [name, comps] of REST) {
  const errs = validateRecipe(comps);
  console.log(`${push("restore", comps) ? "✓" : "✗"} восстановление ${name}${errs.length ? " — " + errs.join("; ") : ""}`);
}

// ── 2. ОДНОВКУСОВЫЕ по раскладкам, круговым обходом вкусов (чтобы партия была
//     разнообразной, а не сплошным виноградом)
const pool = new Map<string, RecipeComponent[][]>();
for (const flavor of Object.keys(UNCRUSTABLES_FLAVORS)) {
  const ok = SIZES.filter((s) => resolveMergedUncrustablesPackageArt(flavor, "retail-carton", s));
  if (!ok.length) continue;
  const ls = layouts(ok).map((l) => toComps(flavor, l));
  // сначала мелкие полосы (S) — они дешевле в закупке и быстрее оборачиваются
  ls.sort((a, b) => a.reduce((s, c) => s + c.qty, 0) - b.reduce((s, c) => s + c.qty, 0));
  pool.set(flavor, ls);
}
const order = [...PRIORITY.filter((f) => pool.has(f)), ...[...pool.keys()].filter((f) => !PRIORITY.includes(f))];
const idx = new Map(order.map((f) => [f, 0]));
let guard = 0;
while (out.length < TARGET && guard++ < 200000) {
  let added = false;
  for (const f of order) {
    if (out.length >= TARGET) break;
    const list = pool.get(f)!; let i = idx.get(f)!;
    while (i < list.length && !push("single", list[i])) i++;
    if (i < list.length) { added = true; i++; }
    idx.set(f, i);
  }
  if (!added) break;
}

const plan = [...existing, ...out];
writeFileSync("data/batch200/recipes.json", JSON.stringify(plan, null, 1));
writeFileSync("data/batch300/b4-queue.json", JSON.stringify(out, null, 1));
console.log(`\nв очередь добавлено: ${out.length} (восстановлений ${out.filter((r) => r.kind === "restore").length}, одновкусовых ${out.filter((r) => r.kind === "single").length})`);
const byF = new Map<string, number>();
for (const r of out) { const f = UNCRUSTABLES_FLAVORS[r.comps[0].flavor].titleName; byF.set(f, (byF.get(f) ?? 0) + 1); }
console.log([...byF].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(" · "));
