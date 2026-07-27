import "dotenv/config";
import { syncUncrustables } from "@/lib/pricing/uncrustables";
(async () => {
  const snap = await syncUncrustables();
  console.log("counts:", JSON.stringify(snap.counts));
  console.log("sample HIGH/LOW rows:");
  snap.rows.filter(r => r.status === "HIGH" || r.status === "LOW").slice(0, 8)
    .forEach(r => console.log(`  ${r.status} ${r.total}ct ${r.cooler} cur=$${r.current} tgt=$${r.target} Δ${r.deltaPct}% ${r.sku}`));
})().catch(e => { console.error(e); process.exit(1); });
