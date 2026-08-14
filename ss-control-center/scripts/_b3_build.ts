// ПАРТИЯ-3 (owner 2026-08-13: «восстанавливать те восемь листингов и еще сто
// сингл всяких разных вариаций … сингл вкус в каждом»).
//
// Строит рецепты одновкусовых наборов, ДОСТИЖИМЫХ на уже утверждённой
// владельцем художке. Реестр подлинности хранит ровно одну фасовку на вкус,
// поэтому пространство вариантов ограничено сверху им, а не кодом: всё
// остальное ждёт owner-ревью новых фото (см. страницу статуса).
//
// Вывод: волна data/batch200/waves/b3-<n>.json + дозапись в recipes.json.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, writeFileSync } from "node:fs";

import {
  UNCRUSTABLES_FLAVORS, validateRecipe, rationalBandFor,
} from "../src/lib/bundle-factory/uncrustables-box-planner";
import { resolveMergedUncrustablesPackageArt } from "../src/lib/bundle-factory/audit/uncrustables-authenticity-merged";

// Вкусы, чьи РЕАЛЬНЫЕ донорские фото несут ретейлерский бейдж «Only at
// Walmart»: на Amazon его показывать нельзя, стирать с настоящего фото —
// подделка. Замер QA 2026-08-11: Chocolate 0/4, Beamin' Berry 1/16.
const RETAILER_BADGE_BLOCKED = [
  "Peanut Butter & Chocolate Flavored Spread",
  "Morning Protein Peanut Butter & Mixed Berry Spread",
];

const short = (f: string) =>
  UNCRUSTABLES_FLAVORS[f].titleName.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const sr: any = await import("../src/lib/bundle-factory/uncrustables-studio-run");

  const existing: any[] = JSON.parse(readFileSync("data/batch200/recipes.json", "utf8"));
  const seen = new Set(
    existing.map((r) => r.comps.map((c: any) => `${c.flavor}:${c.qty}`).sort().join("|")),
  );

  const candidates: { slug: string; comps: { flavor: string; qty: number }[]; kind: string }[] = [];
  for (const flavor of Object.keys(UNCRUSTABLES_FLAVORS)) {
    if (RETAILER_BADGE_BLOCKED.includes(flavor)) continue;
    const art = resolveMergedUncrustablesPackageArt(flavor, "retail-carton");
    if (!art) continue;
    for (let cartons = 1; cartons <= 11; cartons++) {
      const qty = cartons * art.retail_pack_size;
      if (qty < 24 || qty > 135) continue;
      if (!rationalBandFor(qty)) continue;
      const comps = [{ flavor, qty }];
      if (validateRecipe(comps).length) continue;
      const key = `${flavor}:${qty}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ slug: `b3-${short(flavor)}-${qty}`, comps, kind: "single" });
    }
  }
  console.log(`кандидатов-одновкусовых на утверждённой художке: ${candidates.length}`);

  const donors = await sr.loadUncrustablesDonorPool();
  const wave: any[] = [];
  const planned: typeof candidates = [];
  for (const c of candidates) {
    const { errors, plan } = sr.planStudioRecipe(c.comps, donors);
    if (errors.length || !plan) { console.log(`  ✗ ${c.slug}: ${errors.join("; ").slice(0, 100)}`); continue; }
    planned.push(c);
    wave.push({
      slug: c.slug, total: plan.pack_count, title: plan.title, bullets: plan.bullets,
      description: plan.description,
      comps: plan.recipe.comps.map((x: any) => ({
        flavor: x.flavor, qty: x.qty, box_size: x.box_size,
        box_count: x.box_count, donor_title: x.donor_title,
      })),
      price: plan.price_cents / 100, cost_cents: plan.cost_cents,
      cooler: plan.recipe.cooler,
      // Картинки ещё нет: её рисует автоконвейер и ставит через _b2_setmain.
      main_image_url: null, image_kind: "pending-frozen-main",
    });
  }
  writeFileSync("data/batch200/waves/b3-plan.json", JSON.stringify(wave, null, 1));
  writeFileSync("data/batch200/recipes.json", JSON.stringify([...existing, ...planned], null, 1));
  console.log(`\nзапланировано ${planned.length} → waves/b3-plan.json, recipes.json теперь ${existing.length + planned.length}`);
  for (const w of wave) console.log(`  ${String(w.total).padStart(3)}шт $${String(w.price).padStart(6)}  ${w.slug}`);
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
