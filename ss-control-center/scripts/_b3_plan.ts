// ПЛАН ПАРТИИ-3: одновкусовые вариации + восстановление исторических.
// Единственный настоящий гейт — реестр утверждённой владельцем художки
// (одна фасовка на вкус). Скрипт печатает достижимое СЕЙЧАС и то, что
// заблокировано отсутствием утверждённого фото нужной фасовки.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { writeFileSync } from "node:fs";
import { UNCRUSTABLES_FLAVORS, validateRecipe, rationalBandFor } from "../src/lib/bundle-factory/uncrustables-box-planner";
import { resolveMergedUncrustablesPackageArt } from "../src/lib/bundle-factory/audit/uncrustables-authenticity-merged";
import { priceFor } from "../src/lib/pricing/cost-model";

type Variant = { flavor: string; total: number; artSize: number; cartons: number; rows: number; price: number; band: string };

const out: Variant[] = [];
const noArt: string[] = [];
for (const flavor of Object.keys(UNCRUSTABLES_FLAVORS)) {
  const art = resolveMergedUncrustablesPackageArt(flavor, "retail-carton");
  if (!art) { noArt.push(flavor); continue; }
  const s = art.retail_pack_size;
  for (let n = 1; n <= 11; n++) {
    const total = n * s;
    if (total < 24 || total > 135) continue;
    if (validateRecipe([{ flavor, qty: total }]).length) continue;
    const p = priceFor(total) as { suggested?: number } | null;
    out.push({ flavor, total, artSize: s, cartons: n, rows: Math.ceil(n / 4),
      price: p?.suggested ?? 0, band: rationalBandFor(total)?.name ?? "?" });
  }
}
out.sort((a, b) => a.flavor.localeCompare(b.flavor) || a.total - b.total);
console.log(`ДОСТУПНО СЕЙЧАС (на утверждённой художке): ${out.length} одновкусовых\n`);
let cur = "";
for (const v of out) {
  if (v.flavor !== cur) { cur = v.flavor; console.log(`\n${v.flavor}  [художка ${v.artSize}ct]`); }
  console.log(`   ${String(v.total).padStart(3)} шт — ${v.cartons} кор × ${v.artSize}ct, ${v.rows} ряд(а), ${v.band}, $${v.price}`);
}
if (noArt.length) console.log(`\nБЕЗ УТВЕРЖДЁННОЙ ХУДОЖКИ: ${noArt.join(", ")}`);
writeFileSync("data/batch300/variants-available.json", JSON.stringify(out, null, 1));
