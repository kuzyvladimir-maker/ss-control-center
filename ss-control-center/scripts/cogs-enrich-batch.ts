// COGS enrichment BATCH runner (CLI). Thin wrapper over the shared engine core in
// src/lib/sourcing/cogs-engine.ts — the SAME logic the background cron uses, so the
// CLI and the auto-sweep can never drift apart.
//
//   npx tsx scripts/cogs-enrich-batch.ts --channel walmart --limit 10
//   npx tsx scripts/cogs-enrich-batch.ts --channel amazon  --limit 10
//   npx tsx scripts/cogs-enrich-batch.ts SKU1 SKU2 ...              # explicit SKUs
//   npx tsx scripts/cogs-enrich-batch.ts --channel walmart --limit 3 --dry   # identify only
//   npx tsx scripts/cogs-enrich-batch.ts --channel walmart --limit 10 --confidence 0.75
//   npx tsx scripts/cogs-enrich-batch.ts --channel walmart --limit 20 --concurrency 4 --openclaw

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { costOneSku, nextUncostedWalmartSkus, amazonSkus } from "@/lib/sourcing/cogs-engine";
import { openClawEnabled } from "@/lib/sourcing/openclaw-fetch";

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["channel", "limit", "confidence", "concurrency"]);
const getArg = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) { if (VALUE_FLAGS.has(a.slice(2))) i++; continue; }
  positional.push(a);
}
const CHANNEL = getArg("channel", "walmart").toLowerCase();
const LIMIT = parseInt(getArg("limit", "10"), 10);
const MIN_CONF = parseFloat(getArg("confidence", "0.7"));
const DRY = argv.includes("--dry");
const REIDENTIFY = argv.includes("--reidentify");
const CONCURRENCY = Math.max(1, parseInt(getArg("concurrency", "4"), 10));

(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const openclaw = argv.includes("--openclaw") && openClawEnabled();

  let skus = positional.length ? positional : CHANNEL === "amazon" ? await amazonSkus(LIMIT) : await nextUncostedWalmartSkus(db, LIMIT);
  skus = skus.slice(0, positional.length ? skus.length : LIMIT);

  console.log(`\n=== COGS batch — channel=${CHANNEL} · ${skus.length} SKU · confidence≥${MIN_CONF} · openclaw=${openclaw ? "on" : "off"}${DRY ? " · DRY (identify only)" : ""} ===`);

  const snapshot: any[] = [];
  let costed = 0, review = 0, noPrice = 0;
  let _idx = 0;

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, skus.length) }, async () => {
    while (true) {
      const i = _idx++;
      if (i >= skus.length) break;
      const r = await costOneSku(db, { sku: skus[i], channel: CHANNEL, minConf: MIN_CONF, openclaw, reidentify: REIDENTIFY, dry: DRY });
      console.log("\n" + r.logs.join("\n"));
      if (r.status === "costed") { costed++; if (r.needsReview) review++; }
      else if (r.status === "no-price") noPrice++;
      snapshot.push({ sku: r.sku, status: r.status, total: r.total, methods: r.methods, note: r.note, identity: r.identity, parts: r.parts });
    }
  }));

  mkdirSync("../docs/sourcing", { recursive: true });
  const out = `../docs/sourcing/batch-${CHANNEL}-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(out, JSON.stringify(snapshot, null, 2));
  console.log(`\n✅ Done. ${skus.length} SKU · costed ${costed} (of those ${review} low-confidence review) · no-price ${noPrice}${DRY ? " · DRY" : ""}`);
  console.log(`   snapshot → ${out}`);
})();
