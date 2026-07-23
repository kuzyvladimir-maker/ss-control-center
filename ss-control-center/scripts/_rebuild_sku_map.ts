// Rebuild the consolidated SKU reference list for the preview-publish batch
// from the DB (stage-1 accidentally overwrites it with partial runs).
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const SCRATCH = "/private/tmp/claude-501/-Users-vladimirkuznetsov-SS-Command-Center/1dbdc77d-9c20-49be-9e0d-c48b604008f6/scratchpad/";
const FILES = [
  "preview-final-2.json", "preview-final-4.json", "preview-final-5.json",
  "preview-final-6.json", "preview-final-7.json", "preview-final-7b.json",
];

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const bySlug = new Map<string, any>();
  for (const f of FILES) {
    if (!existsSync(SCRATCH + f)) continue;
    for (const l of JSON.parse(readFileSync(SCRATCH + f, "utf8"))) bySlug.set(l.slug, l);
  }
  const jobs = await prisma.generationJob.findMany({
    where: { brief: { contains: "preview-publish-batch12" } },
    select: { brief: true, bundle_drafts: { select: { id: true, master_bundle_id: true, draft_main_image_url: true, pack_count: true } } },
  });
  const out: any[] = [];
  for (const j of jobs) {
    let slug = "";
    try { slug = JSON.parse(j.brief).slug; } catch {}
    const l = bySlug.get(slug);
    for (const d of j.bundle_drafts) {
      if (!d.master_bundle_id) continue;
      const skus = await prisma.channelSKU.findMany({
        where: { master_bundle_id: d.master_bundle_id },
        select: { id: true, sku: true, upc: true, price_cents: true },
      });
      for (const s of skus) {
        out.push({
          slug, draft_id: d.id, master_bundle_id: d.master_bundle_id,
          channel_sku_id: s.id, sku: s.sku, upc: s.upc, price_cents: s.price_cents,
          pack_count: d.pack_count, main_image_url: d.draft_main_image_url,
          comps: l?.comps ?? [], title: l?.title ?? "",
        });
      }
    }
  }
  writeFileSync(SCRATCH + "publish-batch12-skus.json", JSON.stringify(out, null, 1));
  console.log("rows:", out.length, out.map((r: any) => r.sku).join(","));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
