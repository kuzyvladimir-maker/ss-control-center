// BATCH-200 staging — SKU/UPC/комплаенс для композитных листингов.
// НИ ОДНОЙ записи на Amazon: только боевая stage-последовательность
// (GenerationJob → BundleDraft → GeneratedContent → runComplianceGate →
// promoteDraftToChannelSkus → ship-specs → operator inventory).
// Публикация отдельным шагом и требует решения владельца по гейту подлинности
// (см. docs/wiki/uncrustables-listing-rules-canon.md §5).
// Env: WAVES=c1.json,…  LIMIT=n  ONLY=slug,slug
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const WAVE_DIR = "data/batch200/waves/";

async function main() {
  const ONLY = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const LIMIT = Number(process.env.LIMIT ?? 999);

  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const stageLib: any = await import("../src/lib/bundle-factory/uncrustables-stage");
  const gate: any = await import("../src/lib/bundle-factory/compliance/gate");
  const pd: any = await import("../src/lib/bundle-factory/validation/promote-draft");
  const pps: any = await import("../src/lib/bundle-factory/physical-package-specs");
  const dd: any = await import("../src/lib/bundle-factory/donor-dedup");

  // все композитные волны (c*.json), later-wins по slug
  const waves = (process.env.WAVES ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const files = waves.length
    ? waves
    : readdirSync(WAVE_DIR).filter((f) => /^c\d+\.json$/.test(f)).sort();
  const bySlug = new Map<string, any>();
  for (const f of files) {
    for (const row of JSON.parse(readFileSync(WAVE_DIR + f, "utf8"))) bySlug.set(row.slug, row);
  }
  // только те, что в актуальном плане
  const plan: any[] = JSON.parse(readFileSync("data/batch200/recipes.json", "utf8"));
  const planned = plan.map((r) => r.slug).filter((s) => bySlug.has(s));
  const targets = (ONLY.length ? planned.filter((s) => ONLY.includes(s)) : planned).slice(0, LIMIT);
  console.log(`волн: ${files.length} | картинок: ${bySlug.size} | к стейджингу: ${targets.length}`);

  // уже застейдженные этим конвейером (идемпотентность)
  const priorJobs = await prisma.generationJob.findMany({
    where: { brief: { contains: "uncrustables-batch200" } },
    select: { brief: true, bundle_drafts: { select: { master_bundle_id: true } } },
  });
  const staged = new Set<string>();
  for (const j of priorJobs) {
    try {
      const slug = JSON.parse(j.brief).slug;
      if (j.bundle_drafts.some((d: any) => d.master_bundle_id)) staged.add(slug);
    } catch { /* ignore */ }
  }

  const results: any[] = [];
  let ok = 0, skip = 0, fail = 0;
  for (const slug of targets) {
    const row = bySlug.get(slug);
    if (staged.has(slug)) { skip++; continue; }
    const res = await stageLib.stageUncrustablesCandidate(
      {
        slug,
        title: row.title,
        bullets: row.bullets,
        description: row.description,
        mainImageUrl: row.main_image_url,
        packCount: row.total,
        costCents: row.cost_cents ?? null,
        comps: row.comps.map((c: any) => ({ flavor: c.flavor, qty: c.qty, donor_title: c.donor_title })),
        briefSource: "uncrustables-batch200",
        ownerOrder: "2026-08-10 давай сделаем еще 200 новых листингов … го",
        actor: "claude-batch200-composite",
      },
      {
        prisma,
        donorUnitPriceCents: dd.donorUnitPriceCents,
        runComplianceGate: gate.runComplianceGate,
        promoteDraftToChannelSkus: pd.promoteDraftToChannelSkus,
        withVerifiedPhysicalPackageSpecs: pps.withVerifiedPhysicalPackageSpecs,
      },
    );
    if (!res.ok) {
      console.log(`✗ ${slug}: ${res.stage} — ${String(res.error).slice(0, 120)}`);
      results.push({ slug, ok: false, stage: res.stage, error: res.error });
      fail++;
      continue;
    }
    const sku = res.skus[0];
    console.log(`✓ ${slug} (${row.total}ct $${row.price}) → ${sku.sku} | upc ${sku.upc}`);
    results.push({
      slug, ok: true, sku: sku.sku, upc: sku.upc, price_cents: sku.price_cents,
      channel_sku_id: sku.channel_sku_id, draft_id: res.draftId,
      master_bundle_id: res.masterBundleId, pack_count: row.total,
      main_image_url: row.main_image_url, image_kind: row.image_kind,
      comps: row.comps, title: row.title,
    });
    ok++;
  }
  writeFileSync("data/batch200/staged.json", JSON.stringify(results.filter((r) => r.ok), null, 1));
  console.log(`\nитого: ✓ ${ok} | ↷ уже было ${skip} | ✗ ${fail} → data/batch200/staged.json`);
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
