import "dotenv/config";
import { prisma } from "@/lib/prisma";
async function main() {
  const passed = await prisma.listingRemediation.findFirst({
    where: { status: "completed", audit_result: { scan_id: "cmpaisoq80000wlfz4llxuo5k" } },
    include: { audit_result: { select: { asin: true, account: true, title: true } } },
  });
  if (!passed) { console.log("no completed row"); return; }
  console.log(`PASSED: ${passed.audit_result.asin} · ${passed.audit_result.account}`);
  console.log(`Title: ${passed.audit_result.title}`);
  const b = JSON.parse(passed.new_bullets || "[]");
  console.log(`\nBullets (${b.length}):`);
  for (let i = 0; i < b.length; i++) console.log(`[${i+1}] ${b[i]}`);
  console.log(`\nDescription (${(passed.new_description||"").length} chars):`);
  console.log(passed.new_description);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
