// BATCH-200 (owner «го» 2026-08-10): генератор 200 рецептов по данным спроса
// 30d (Sales&Traffic 188 живых листингов). Приоритеты вкусов: Tier A =
// Strawberry (WW/classic/protein), Grape (+WW), Honey, Blueberry, Blackberry;
// Tier B = Mixed Berry Protein, Apple Cinnamon Protein, Raspberry, Berry
// Burst, Chocolate; Tier C (минимум) = PB, Hazelnut. Все рецепты проходят
// validateRecipe (кулерные пределы владельца + renderable-лимиты) и дедуп
// против живого каталога. Вывод: data/batch200/recipes.json.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { mkdirSync, writeFileSync } from "node:fs";

import {
  UNCRUSTABLES_FLAVORS,
  validateRecipe,
  type RecipeComponent,
} from "../src/lib/bundle-factory/uncrustables-box-planner";

// Демандовые ярусы (component names из каталога)
const A = [
  "Whole Wheat Peanut Butter & Strawberry Jam",
  "Peanut Butter & Strawberry Jam",
  "Peanut Butter & Strawberry Jam Protein",
  "Peanut Butter & Grape Jelly",
  "Whole Wheat Peanut Butter & Grape Jelly",
  "Peanut Butter & Honey Spread",
  "Peanut Butter & Blueberry",
  "Peanut Butter & Blackberry Spread",
];
const B = [
  "Morning Protein Peanut Butter & Mixed Berry Spread",
  "Peanut Butter & Apple Cinnamon Jelly Protein",
  "Peanut Butter & Raspberry Spread",
  "Peanut Butter & Mixed Berry Spread",
  "Peanut Butter & Chocolate Flavored Spread",
];
const C = ["Peanut Butter", "Chocolate Flavored Hazelnut Spread"];

const short = (f: string) =>
  UNCRUSTABLES_FLAVORS[f].titleName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 18);

type Candidate = { slug: string; comps: RecipeComponent[]; kind: string; priority: number };
const out: Candidate[] = [];
const seenComp = new Set<string>();
const compKey = (comps: RecipeComponent[]) =>
  comps.map((c) => `${c.flavor}:${c.qty}`).sort().join("|");

function push(kind: string, priority: number, comps: RecipeComponent[]) {
  const errors = validateRecipe(comps);
  if (errors.length) return false;
  const key = compKey(comps);
  if (seenComp.has(key)) return false;
  seenComp.add(key);
  const total = comps.reduce((s, c) => s + c.qty, 0);
  const slug = `b2-${comps.map((c) => short(c.flavor)).join("-")}-${total}`.slice(0, 70);
  out.push({ slug, comps, kind, priority });
  return true;
}

const size = (f: string) => UNCRUSTABLES_FLAVORS[f].cartonSize;
// qty options per flavor with N cartons
const qtyFor = (f: string, cartons: number[]) => cartons.map((n) => n * size(f));

// ── 1. SINGLES: ТОЛЬКО рациональные каунты (owner canon: S = 24/28/30, не
// 8/12/16 — там кулер и заморозка дают $6.62/сэндвич вместо ~$3).
// Одновкусовые ряды упираются в 4 коробки, поэтому 24+ достижимы только на
// 8/10ct-фасовках; 4ct-вкусы в синглы не идут (4×4=16 < 24).
const MIN_RATIONAL_TOTAL = 24;
for (const [tier, prio] of [[A, 1], [B, 2], [C, 3]] as const) {
  for (const f of tier) {
    for (const q of qtyFor(f, [3, 4])) {
      if (q < MIN_RATIONAL_TOTAL) continue;
      push("single", prio, [{ flavor: f, qty: q }]);
    }
  }
}

// ── 2. DUOS: пары Tier A×A (все), A×B (выборочно) × размеры
const duoSizes = (f1: string, f2: string): [number, number][] => {
  const combos: [number, number][] = [];
  for (const n1 of [1, 2, 3, 4]) {
    for (const n2 of [1, 2, 3, 4]) {
      const q1 = n1 * size(f1), q2 = n2 * size(f2);
      const total = q1 + q2;
      if (total >= 24 && total <= 54) combos.push([q1, q2]);
    }
  }
  return combos;
};
const duoPairs: [string, string, number][] = [];
for (let i = 0; i < A.length; i++)
  for (let j = i + 1; j < A.length; j++) duoPairs.push([A[i], A[j], 1]);
for (const a of A.slice(0, 5)) for (const b of B.slice(0, 3)) duoPairs.push([a, b, 2]);
for (const [f1, f2, prio] of duoPairs) {
  // на пару берём до 3 размеров: маленький, средний S, большой M
  const sizes = duoSizes(f1, f2)
    .sort((x, y) => x[0] + x[1] - (y[0] + y[1]))
    .filter(([q1, q2], idx, arr) => {
      const t = q1 + q2;
      const prev = idx > 0 ? arr[idx - 1][0] + arr[idx - 1][1] : -1;
      return t !== prev;
    });
  const pick: [number, number][] = [];
  const wantTotals = [24, 28, 30, 48, 54];
  for (const w of wantTotals) {
    const hit = sizes.find(([q1, q2]) => q1 + q2 === w);
    if (hit && pick.length < 3) pick.push(hit);
  }
  for (const [q1, q2] of pick) {
    push("duo", prio, [
      { flavor: f1, qty: q1 },
      { flavor: f2, qty: q2 },
    ]);
  }
}

// ── 3. TRIOS: тройки из Tier A (+1 из B) на 28/30/48/54/60
const trioSets: [string[], number][] = [];
for (let i = 0; i < A.length; i++)
  for (let j = i + 1; j < A.length; j++)
    for (let k = j + 1; k < A.length; k++) trioSets.push([[A[i], A[j], A[k]], 1]);
for (const [flavors, prio] of trioSets) {
  const opts: RecipeComponent[][] = [];
  for (const n1 of [1, 2, 3, 4]) for (const n2 of [1, 2, 3, 4]) for (const n3 of [1, 2, 3, 4]) {
    const comps = [
      { flavor: flavors[0], qty: n1 * size(flavors[0]) },
      { flavor: flavors[1], qty: n2 * size(flavors[1]) },
      { flavor: flavors[2], qty: n3 * size(flavors[2]) },
    ];
    const t = comps.reduce((s, c) => s + c.qty, 0);
    if ([28, 30, 48, 54, 60].includes(t)) opts.push(comps);
  }
  // максимум 2 размера на тройку: приоритет 48/54, потом 28/30/60
  const byTotal = (t: number) => opts.find((c) => c.reduce((s, x) => s + x.qty, 0) === t);
  let added = 0;
  for (const t of [48, 54, 28, 30, 60]) {
    const comps = byTotal(t);
    if (comps && added < 2 && push("trio", prio, comps)) added++;
  }
}

// ── 4. XL flagships: 90-96 на лидерах (структуры из доказанных суб-блоков)
const xl: RecipeComponent[][] = [
  [
    { flavor: "Peanut Butter & Honey Spread", qty: 20 },
    { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 20 },
    { flavor: "Peanut Butter & Blueberry", qty: 32 },
    { flavor: "Peanut Butter & Apple Cinnamon Jelly Protein", qty: 24 },
  ], // 96, cartons 2+2+4+3=11
  [
    { flavor: "Peanut Butter & Honey Spread", qty: 30 },
    { flavor: "Peanut Butter & Strawberry Jam Protein", qty: 32 },
    { flavor: "Morning Protein Peanut Butter & Mixed Berry Spread", qty: 32 },
  ], // 94, 3+4+4=11
  [
    { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 30 },
    { flavor: "Peanut Butter & Blueberry", qty: 32 },
    { flavor: "Peanut Butter & Strawberry Jam Protein", qty: 32 },
  ], // 94, 3+4+4=11
  [
    { flavor: "Peanut Butter & Honey Spread", qty: 20 },
    { flavor: "Peanut Butter & Blueberry", qty: 32 },
    { flavor: "Peanut Butter & Apple Cinnamon Jelly Protein", qty: 32 },
    { flavor: "Morning Protein Peanut Butter & Mixed Berry Spread", qty: 8 },
  ], // 92, 2+4+4+1=11
  [
    { flavor: "Peanut Butter & Honey Spread", qty: 30 },
    { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 20 },
    { flavor: "Peanut Butter & Blueberry", qty: 16 },
    { flavor: "Peanut Butter & Strawberry Jam Protein", qty: 24 },
  ], // 90, 3+2+2+3=10
];
for (const comps of xl) push("xl", 1, comps);

async function main() {
  // дедуп против живого каталога (по множеству flavor:qty)
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const liveBundles = await prisma.masterBundle.findMany({
    where: { channel_skus: { some: { channel: "AMAZON_SALUTEM" } }, brand: { contains: "Uncrustables" } },
    select: { components: { select: { product_name: true, flavor: true, qty: true } } },
  }).catch(() => []);
  const liveKeys = new Set<string>(
    liveBundles.map((b: any) =>
      b.components
        .map((c: any) => `${c.flavor ?? c.product_name}:${c.qty}`)
        .sort()
        .join("|"),
    ),
  );
  const fresh = out.filter((c) => !liveKeys.has(compKey(c.comps)));

  // сортировка: priority, потом разнообразие видов; кап 200
  fresh.sort((a, b) => a.priority - b.priority);
  const singles = fresh.filter((c) => c.kind === "single");
  const duos = fresh.filter((c) => c.kind === "duo");
  const trios = fresh.filter((c) => c.kind === "trio");
  const xls = fresh.filter((c) => c.kind === "xl");
  const picked = [
    ...singles,
    ...xls,
    ...duos,
    ...trios,
  ].slice(0, 200);

  mkdirSync("data/batch200", { recursive: true });
  writeFileSync(
    "data/batch200/recipes.json",
    JSON.stringify(picked.map(({ slug, comps, kind }) => ({ slug, comps, kind })), null, 1),
  );
  const stat = (arr: Candidate[], k: string) => arr.filter((c) => c.kind === k).length;
  console.log(
    `generated: ${out.length} valid | after live-dedup: ${fresh.length} | picked: ${picked.length}`,
  );
  console.log(
    `singles ${stat(picked, "single")} | duos ${stat(picked, "duo")} | trios ${stat(picked, "trio")} | xl ${stat(picked, "xl")}`,
  );
  const totals: Record<string, number> = {};
  for (const c of picked) {
    const t = c.comps.reduce((s, x) => s + x.qty, 0);
    const band = t <= 30 ? "S" : t <= 54 ? "M" : t <= 66 ? "L" : "XL";
    totals[band] = (totals[band] ?? 0) + 1;
  }
  console.log("bands:", JSON.stringify(totals));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
