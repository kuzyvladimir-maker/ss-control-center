import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const skus = process.env.SKUS!.split(",");
  for (const sku of skus) {
    const s = await prisma.channelSKU.findFirst({ where: { sku }, select: { sku: true, asin: true, title: true, master_bundle_id: true } });
    if (!s) { console.log(sku, "NOT FOUND"); continue; }
    const d = s.master_bundle_id ? await prisma.bundleDraft.findFirst({ where: { master_bundle_id: s.master_bundle_id }, select: { id: true, variation_matrix: { select: { selected_variant_idx: true, variants_json: true } } } }) : null;
    let comp: any[] = [];
    try { comp = JSON.parse(d!.variation_matrix!.variants_json)[d!.variation_matrix!.selected_variant_idx!].composition; } catch {}
    console.log(`\n${sku} (${s.asin ?? "?"}) draft=${d?.id}`);
    console.log(`  TITLE: ${s.title}`);
    console.log(`  RECIPE: ${comp.map((c) => `${c.qty}× ${c.product_name} [pool:${c.research_pool_id ? "y" : "NONE"}]`).join(" | ")}`);
  }
  await prisma.$disconnect();
}
main().catch(e=>{console.error(e.message);process.exit(1);});
