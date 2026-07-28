import "dotenv/config";
import { prisma } from "@/lib/prisma";
async function main() {
  const all = await prisma.listingRemediation.findMany({
    where: { audit_result: { scan_id: "cmpaisoq80000wlfz4llxuo5k" } },
    include: { audit_result: { select: { asin: true, account: true } } },
    orderBy: [{ status: "asc" }, { id: "asc" }],
  });
  console.log(`Total: ${all.length}`);
  const groups: Record<string, string[]> = {};
  for (const r of all) {
    const k = `${r.status}/${r.audit_result.account}`;
    (groups[k] ||= []).push(r.audit_result.asin);
  }
  for (const k of Object.keys(groups).sort()) {
    console.log(`  ${k}: ${groups[k].length} → ${groups[k].slice(0,3).join(",")}${groups[k].length>3?"...":""}`);
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
