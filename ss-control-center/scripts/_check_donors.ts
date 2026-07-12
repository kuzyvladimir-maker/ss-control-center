import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const d = await prisma.bundleDraft.findUnique({ where: { id: process.env.DRAFT! }, select: { variation_matrix: { select: { selected_variant_idx: true, variants_json: true } } } });
  const v = JSON.parse(d!.variation_matrix!.variants_json)[d!.variation_matrix!.selected_variant_idx!];
  for (const c of v.composition) {
    const donor = c.research_pool_id ? await prisma.donorProduct.findUnique({ where: { id: c.research_pool_id }, select: { title: true, mainImageUrl: true } }) : null;
    console.log(`- ${c.product_name}  qty=${c.qty}  pool=${c.research_pool_id ?? "NONE"}`);
    console.log(`    donor: ${donor ? donor.title?.slice(0,50) : "!! NOT FOUND"}  img: ${donor?.mainImageUrl ? "yes" : "NO"}`);
  }
  await prisma.$disconnect();
}
main().catch(e=>{console.error(e.message);process.exit(1);});
