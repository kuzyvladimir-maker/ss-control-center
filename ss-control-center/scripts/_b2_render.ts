// BATCH-200 render driver — на студийных либах (контракт v14, донор-резолвер,
// прайс-модель), r2-префикс b2. Env: SLUGS=a,b,c (обязателен), RUN=w1.
// Вывод: data/batch200/waves/<RUN>.json — строки, совместимые со stage-1
// (slug/total/title/bullets/description/comps/price/cost_cents/prompt/
// referenceUrls/main_image_url). Переживает wipe скратчпада.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

async function main() {
  const RUN = process.env.RUN ?? "w0";
  const SLUGS = (process.env.SLUGS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!SLUGS.length) { console.error("SLUGS required"); process.exit(1); }

  const sr: any = await import("../src/lib/bundle-factory/uncrustables-studio-run");
  const rr: any = await import("../src/lib/bundle-factory/uncrustables-render-runner");

  const recipes: any[] = JSON.parse(readFileSync("data/batch200/recipes.json", "utf8"));
  const bySlug = new Map(recipes.map((r) => [r.slug, r]));
  const donors = await sr.loadUncrustablesDonorPool();
  console.log(`donor pool: ${donors.length}`);

  const out: any[] = [];
  for (const slug of SLUGS) {
    const recipe = bySlug.get(slug);
    if (!recipe) { console.log(`✗ ${slug}: not in recipes.json`); continue; }
    const { errors, plan } = sr.planStudioRecipe(recipe.comps, donors);
    if (errors.length || !plan) { console.log(`✗ ${slug}: PLAN — ${errors.join("; ")}`); continue; }
    let prompt: string, referenceUrls: string[];
    try {
      const built = sr.buildStudioCandidatePrompt({ title: plan.title, recipe: plan.recipe });
      prompt = built.prompt; referenceUrls = built.referenceUrls;
    } catch (e: any) {
      console.log(`✗ ${slug}: PROMPT — ${String(e?.message ?? e).slice(0, 140)}`);
      continue;
    }
    const t0 = Date.now();
    const res = await rr.renderUncrustablesMainCandidate(
      { slug, prompt, referenceUrls, r2Prefix: "b2" },
      {},
    );
    if (!res.ok) {
      console.log(`✗ ${slug}: ${res.code} — ${res.error.slice(0, 140)}`);
      continue;
    }
    console.log(`✓ ${slug}: ${Math.round((Date.now() - t0) / 1000)}s ${res.pixelDimensions.width}x${res.pixelDimensions.height} sha ${res.imageSha256.slice(0, 12)} → ${res.imageUrl}`);
    out.push({
      slug,
      kind: recipe.kind,
      total: plan.pack_count,
      title: plan.title,
      bullets: plan.bullets,
      description: plan.description,
      comps: plan.recipe.comps.map((c: any) => ({
        flavor: c.flavor,
        qty: c.qty,
        box_size: c.box_size,
        box_count: c.box_count,
        donor_title: c.donor_title,
      })),
      price: plan.price_cents / 100,
      cost_cents: plan.cost_cents,
      cooler: plan.recipe.cooler,
      prompt,
      referenceUrls,
      main_image_url: res.imageUrl,
      image_sha256: res.imageSha256,
    });
  }
  mkdirSync("data/batch200/waves", { recursive: true });
  writeFileSync(`data/batch200/waves/${RUN}.json`, JSON.stringify(out, null, 1));
  console.log(`готово: ${out.length}/${SLUGS.length} → data/batch200/waves/${RUN}.json`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
