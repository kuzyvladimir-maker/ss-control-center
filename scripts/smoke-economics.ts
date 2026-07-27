// Smoke test for loadSkuEconomics against the live DB. One-shot, read-only.
// Run: npx tsx scripts/smoke-economics.ts [store] [marketplace]
import { loadSkuEconomics } from "@/lib/economics/resolve-sku";

(async () => {
  const store = Number(process.argv[2] ?? "1") || 1;
  const marketplace = (process.argv[3] as "amazon" | "walmart") ?? "amazon";
  const s = await loadSkuEconomics({ storeIndex: store, marketplace });
  console.log(
    `store ${store} / ${marketplace}: total=${s.total} cogsMissing=${s.cogsMissing} belowTarget=${s.belowTargetMargin}`,
  );
  console.log("\nFirst 8 rows (blocked first, then worst margin):");
  for (const r of s.rows.slice(0, 8)) {
    const margin = r.marginPct == null ? "BLOCKED" : `${(r.marginPct * 100).toFixed(1)}%`;
    console.log(
      `  ${r.sku.padEnd(16)} price=${r.breakdown.itemPrice} cogs=${r.breakdown.cogs} ` +
        `pkg=${r.breakdown.packaging} ref=${r.breakdown.referralFee} ship=${r.breakdown.ownShipping} ` +
        `profit=${r.profit ?? "BLOCKED"} margin=${margin} [${r.flags.join(",")}]`,
    );
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
