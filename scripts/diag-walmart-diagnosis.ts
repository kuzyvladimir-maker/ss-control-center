import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { getWalmartClient } from "@/lib/walmart/client";
import { diagnoseWalmartGrowth } from "@/lib/walmart/growth-diagnosis";
(async()=>{
  const r = await diagnoseWalmartGrowth(prisma, getWalmartClient(1), 1);
  console.log("sellerScore:", r.sellerScore, "| headline:", r.headline);
  console.log("shipping:", JSON.stringify(r.shipping));
  console.log("\n=== DIAGNOSES (ranked) ===");
  for (const d of r.diagnoses) {
    console.log(`\n[${d.severity.toUpperCase()}] ${d.title} ${d.metric?`(${d.metric})`:""} — ${d.itemsAffected ?? "?"} items`);
    console.log(`  problem: ${d.problem}`);
    console.log(`  fix: ${d.recommendation}`);
    console.log(`  action: ${d.action.kind} "${d.action.label}"${d.action.jumpFilter?` →${d.action.jumpFilter}`:""}`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR:",e.message);process.exit(1)});
