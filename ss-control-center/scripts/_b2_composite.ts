// BATCH-200 composite driver — ГЛАВНЫЕ КАРТИНКИ ИЗ РЕАЛЬНЫХ ФОТО.
// Правило владельца 2026-07-08 (docs/wiki/bundle-factory-composite-images.md):
// «нам нельзя продавать выдуманный Uncrustables… картинки должны генериться
// 100% теми вкусами, которые есть». Поэтому упаковка НЕ рисуется нейросетью —
// берутся нетронутые пиксели реальных фото коробок донора и складываются в
// сетку на чистом белом, а QA-офицер (Claude vision на подписке, $0) проверяет
// каждую картинку до публикации.
// Env: SLUGS=a,b,c RUN=c1. Вывод: data/batch200/waves/<RUN>.json
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

async function main() {
  const RUN = process.env.RUN ?? "c0";
  const SLUGS = (process.env.SLUGS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!SLUGS.length) { console.error("SLUGS required"); process.exit(1); }

  const sr: any = await import("../src/lib/bundle-factory/uncrustables-studio-run");
  const ci: any = await import("../src/lib/bundle-factory/composite-image");
  const oi: any = await import("../src/lib/bundle-factory/uncrustables-official-ingredients");

  const recipes: any[] = JSON.parse(readFileSync("data/batch200/recipes.json", "utf8"));
  const bySlug = new Map(recipes.map((r) => [r.slug, r]));
  const donors = await sr.loadUncrustablesDonorPool();
  const stamp = new Date().toISOString().slice(0, 10);
  console.log(`donor pool: ${donors.length} | stamp ${stamp}`);

  const out: any[] = [];
  for (const slug of SLUGS) {
    const recipe = bySlug.get(slug);
    if (!recipe) { console.log(`✗ ${slug}: нет в recipes.json`); continue; }
    const { errors, plan } = sr.planStudioRecipe(recipe.comps, donors);
    if (errors.length || !plan) { console.log(`✗ ${slug}: PLAN — ${errors.join("; ")}`); continue; }

    // Variant для композитора: реальные доноры + официальные данные состава
    const variant = {
      idx: 0,
      name: plan.title,
      composition: plan.recipe.comps.map((c: any) => ({
        research_pool_id: c.donor_id,
        product_name: c.flavor,
        brand: "Uncrustables",
        qty: c.qty,
        unit_price_cents: c.unit_price_cents ?? 0,
        flavor: c.flavor,
        ingredients: oi.INGREDIENTS[c.flavor],
        allergen_declaration: oi.allergensFor(c.flavor),
        donor_image_urls: c.donor_image ? [c.donor_image] : [],
        retail_pack_sizes: [c.box_size],
      })),
      cost_cents: plan.cost_cents ?? 0,
      suggested_price_cents: plan.price_cents,
      margin_cents: 0,
      margin_pct: 0,
      feasibility_score: 1,
      notes: "batch200",
    };

    const elig = ci.compositeEligible({ brand: "Uncrustables", variant });
    if (!elig.eligible) { console.log(`✗ ${slug}: not composite-eligible — ${elig.reason}`); continue; }

    const t0 = Date.now();
    const res = await ci.buildCompositeWithQA({ variant, r2Slug: `b2c-${slug}`, stamp, maxAttempts: 3 });
    const secs = Math.round((Date.now() - t0) / 1000);
    if (!res.ok || !res.image_url) {
      console.log(`✗ ${slug}: BUILD — ${String(res.error ?? "no image").slice(0, 140)}`);
      continue;
    }
    const qaPass = res.qa?.pass === true;
    console.log(
      `${qaPass ? "✓" : "✗"} ${slug}: ${secs}s | boxes ${res.total_boxes} units ${res.total_units} | attempts ${res.attempts} | QA ${qaPass ? "PASS" : "FAIL: " + String(res.qa?.issues ?? res.qa?.reason ?? "?").slice(0, 120)} → ${res.image_url}`,
    );
    if (!qaPass) continue; // QA-rejected НИКОГДА не публикуется

    out.push({
      slug,
      kind: recipe.kind,
      total: plan.pack_count,
      title: plan.title,
      bullets: plan.bullets,
      description: plan.description,
      comps: plan.recipe.comps.map((c: any) => ({
        flavor: c.flavor, qty: c.qty, box_size: c.box_size,
        box_count: c.box_count, donor_title: c.donor_title, donor_image: c.donor_image,
      })),
      price: plan.price_cents / 100,
      cost_cents: plan.cost_cents,
      cooler: plan.recipe.cooler,
      main_image_url: res.image_url,
      image_kind: "real-photo-composite",
      composite_plan: res.plan,
      composite_boxes: res.total_boxes,
      qa: res.qa,
    });
  }
  mkdirSync("data/batch200/waves", { recursive: true });
  writeFileSync(`data/batch200/waves/${RUN}.json`, JSON.stringify(out, null, 1));
  console.log(`готово: ${out.length}/${SLUGS.length} QA-passed → data/batch200/waves/${RUN}.json`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
