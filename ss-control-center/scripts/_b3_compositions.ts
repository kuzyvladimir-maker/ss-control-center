// ПРАВИЛО ВЛАДЕЛЬЦА 2026-08-15: листинг определяется РАСКЛАДКОЙ коробок, а не
// суммой. 54 = 3×18 и 54 = 5×10 + 1×4 — два разных листинга: визуал разный.
// Отгружаем всё равно россыпью, поэтому любая раскладка законна.
// Считаем ЧИСЛО РАЗЛИЧНЫХ РАСКЛАДОК, а не число сумм.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { UNCRUSTABLES_FLAVORS, rationalBandFor, RENDER_LIMITS } from "../src/lib/bundle-factory/uncrustables-box-planner";

const ALL_SIZES = [4, 8, 10, 15, 18, 24];

function compositions(sizes: number[]) {
  const out: number[][] = [];
  const rec = (i: number, acc: number[], sum: number) => {
    if (acc.length) {
      const rows = Math.ceil(acc.length / RENDER_LIMITS.maxCartonsPerRow);
      if (sum >= 24 && sum <= 135 && rationalBandFor(sum) && rows <= RENDER_LIMITS.maxRows) out.push([...acc]);
    }
    if (sum > 135 || acc.length >= RENDER_LIMITS.maxCartons) return;
    for (let j = i; j < sizes.length; j++) rec(j, [...acc, sizes[j]], sum + sizes[j]);
  };
  rec(0, [], 0);
  return out;
}

const flavors = Object.keys(UNCRUSTABLES_FLAVORS);
const perFlavor = compositions(ALL_SIZES);
console.log(`Раскладок на ОДИН вкус при полном наборе фасовок ${ALL_SIZES.join("/")}: ${perFlavor.length}`);
console.log(`Вкусов в каталоге: ${flavors.length}`);
console.log(`ИТОГО одновкусовых листингов возможно: ${perFlavor.length * flavors.length}\n`);

const byTotal = new Map<number, number>();
for (const c of perFlavor) {
  const t = c.reduce((s, x) => s + x, 0);
  byTotal.set(t, (byTotal.get(t) ?? 0) + 1);
}
console.log("сколько РАЗНЫХ раскладок даёт каждое количество (на один вкус):");
const totals = [...byTotal].sort((a, b) => a[0] - b[0]);
console.log(totals.map(([t, n]) => `${t}:${n}`).join("  "));

const ex = perFlavor.filter((c) => c.reduce((s, x) => s + x, 0) === 54);
console.log(`\nпример — 54 штуки, ${ex.length} разных листингов:`);
for (const c of ex) {
  const m = new Map<number, number>();
  for (const s of c) m.set(s, (m.get(s) ?? 0) + 1);
  console.log("   " + [...m].sort((a, b) => b[0] - a[0]).map(([s, n]) => `${n}×${s}шт`).join(" + "));
}
