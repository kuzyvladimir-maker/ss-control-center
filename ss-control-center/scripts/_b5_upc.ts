import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const d = await prisma.donorProduct.findMany({
    where: { OR: [{ title: { contains: "Uncrustable" } }, { productLine: "Uncrustables" }] },
    select: { id: true, title: true, upc: true, gtin: true, bestRetailer: true, mainImageUrl: true },
  });
  const noUpc = d.filter((x: any) => !x.upc && !x.gtin);
  console.log(`доноров всего: ${d.length} | без UPC: ${noUpc.length}`);
  for (const x of noUpc) console.log(`  ${(x.bestRetailer ?? "—").padEnd(9)} ${(x.title ?? "").slice(0, 78)}`);
  await prisma.$disconnect(); process.exit(0);
}
main();
