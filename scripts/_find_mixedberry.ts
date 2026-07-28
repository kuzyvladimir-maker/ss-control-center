import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { prisma } = await import("@/lib/prisma");
  // Mixed Berry component from the good listing B0H85P9F3R (draft cmrbhyood006g04ju4cqerjhn)
  const d = await prisma.bundleDraft.findUnique({ where: { id: "cmrbhyood006g04ju4cqerjhn" }, select: { variation_matrix: { select: { selected_variant_idx: true, variants_json: true } } } });
  const comp = JSON.parse(d!.variation_matrix!.variants_json)[d!.variation_matrix!.selected_variant_idx!].composition;
  console.log("B0H85P9F3R composition:");
  for (const c of comp) console.log("  ", JSON.stringify({ product_name: c.product_name, brand: c.brand, qty: c.qty, research_pool_id: c.research_pool_id, retail_pack_sizes: c.retail_pack_sizes }));
  // Confirm the donor image exists
  const mb = comp.find((c: any) => /mixed berry/i.test(c.product_name));
  if (mb?.research_pool_id) {
    const donor = await prisma.donorProduct.findUnique({ where: { id: mb.research_pool_id }, select: { title: true, mainImageUrl: true, brand: true } });
    console.log("\nMixed Berry donor:", JSON.stringify(donor));
  }
  await prisma.$disconnect();
}
main().catch(e=>{console.error(e.message);process.exit(1);});
