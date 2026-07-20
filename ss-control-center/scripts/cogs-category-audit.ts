// LLM category audit — fix Frozen/Dry data quality in SkuShippingData using a
// smart model (titles), instead of brittle keyword rules. Both directions:
//   - Dry→Frozen (SAFETY: a frozen item mistagged Dry would ship without cold chain)
//   - Frozen→Dry (cleanup: shelf-stable / equipment / supplements wrongly Frozen)
// Auto-applies ONLY high-confidence changes; prints EVERY change; lists low-conf
// disagreements for manual review. Category drives shipping carrier → handled carefully.
//
//   npx tsx scripts/cogs-category-audit.ts            # apply (>=0.92) + report
//   npx tsx scripts/cogs-category-audit.ts --dry-run  # report only

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";
import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE } from "@/lib/ai-models";
import { assertMeteredProviderCall } from "@/lib/sourcing/metered-call-guard";

throw new Error("LEGACY_METERED_SCRIPT_DISABLED: migrate this audit to the durable Product Truth budget ledger before use");

const DRY = process.argv.includes("--dry-run");
const APPLY_AT = 0.92;
const MODEL = CLAUDE.balanced;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYS = `You classify grocery/e-commerce products for SHIPPING handling. Return ONLY a JSON array, one object per input line: [{"sku":"","category":"Frozen"|"Dry","confidence":0.0,"reason":"<=12 words"}].
FROZEN = must ship cold-chain: frozen entrees/meals, breaded frozen appetizers (mozzarella sticks, jalapeno poppers, shrimp), chicken nuggets, ice cream, frozen sandwiches INCLUDING Smucker's Uncrustables, bagel bites / bagel dogs, toaster grills, frozen dough, frozen meat/seafood/tripe.
DRY = shelf-stable / non-perishable: canned or jarred or boxed foods, soup (canned), bread, bagels (shelf pre-sliced), crackers, chips, cereal, cookies, snacks, condiments, pasta, rice, tortillas; OR non-food equipment (styrofoam coolers, ice chests, gel ice packs, insulated bags); OR supplements (detox).
Be decisive; confidence reflects certainty.`;

const chunk = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const rows = (await db.execute(
    "SELECT sku, category, productTitle FROM SkuShippingData WHERE productTitle IS NOT NULL AND productTitle != ''"
  )).rows as any[];
  console.log(`Auditing ${rows.length} rows (${DRY ? "DRY RUN" : "apply >=" + APPLY_AT}) …`);

  const proposals = new Map<string, { category: string; confidence: number; reason: string }>();
  const batches = chunk(rows, 40);
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    const list = b.map((r) => `${r.sku}\t${String(r.productTitle).slice(0, 90)}`).join("\n");
    try {
      assertMeteredProviderCall({ provider: "anthropic", operation: "classification" });
      const resp = await anthropic.messages.create({
        model: MODEL, max_tokens: 4096,
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: `${SYS}\n\nPRODUCTS (sku<TAB>title):\n${list}` }],
      });
      const txt = resp.content.find((c) => c.type === "text");
      const m = txt && txt.type === "text" ? txt.text.match(/\[[\s\S]*\]/) : null;
      if (m) for (const o of JSON.parse(m[0])) proposals.set(o.sku, { category: o.category, confidence: +o.confidence, reason: o.reason });
    } catch (e: any) { console.log(`  batch ${i + 1}/${batches.length} failed: ${String(e.message).slice(0, 60)}`); }
    if ((i + 1) % 5 === 0) console.log(`  …${i + 1}/${batches.length} batches`);
  }

  const now = new Date().toISOString();
  const applied: string[] = [], manual: string[] = [];
  for (const r of rows) {
    const p = proposals.get(r.sku);
    if (!p || !p.category || p.category === r.category) continue;
    const line = `${r.category}→${p.category} (${p.confidence}) ${r.sku} — ${String(r.productTitle).slice(0, 50)} [${p.reason}]`;
    if (p.confidence >= APPLY_AT) {
      if (!DRY) await db.execute({ sql: "UPDATE SkuShippingData SET category=?, updatedAt=? WHERE sku=?", args: [p.category, now, r.sku] });
      applied.push(line);
    } else manual.push(line);
  }

  console.log(`\n=== CHANGES ${DRY ? "(proposed)" : "APPLIED"} : ${applied.length} ===`);
  applied.forEach((l) => console.log("  " + l));
  console.log(`\n=== LOW-CONFIDENCE — manual review : ${manual.length} ===`);
  manual.forEach((l) => console.log("  " + l));
  const tot = await db.execute("SELECT category, COUNT(*) n FROM SkuShippingData GROUP BY category");
  console.log("\nCategory totals:"); for (const x of tot.rows as any[]) console.log(`  ${x.category}: ${x.n}`);
})();
