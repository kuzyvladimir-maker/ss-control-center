// Did COGS's force re-enrichment actually fix DONOR SELECTION, or just refresh galleries?
//
// Zero vision, zero credits: for every SKU my listing-anchored gate quarantined
// (DONOR_FAIL / TILE_FAIL / VARIANT_MISMATCH / missing donor row), compare the donor
// title now in EnrichedReadySku against the Walmart LISTING title, using the same free
// modifier guard the generator uses. If the re-link worked, the modifier disagreement
// rate should collapse. If it stayed flat, the matcher is still brand+category+size and
// re-running the drip would burn hours of vision to rediscover the same 43%.
//
// Also reports how many donors actually CHANGED, so "no change" cannot be mistaken
// for "changed but still wrong".
import { readFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }

import { modifierMismatch } from "./_gatewords.ts";

async function main() {
  const gen: Record<string, any> = JSON.parse(readFileSync("_gen_enriched_state.json", "utf8"));
  const QUARANTINED = ["DONOR_FAIL", "TILE_FAIL", "VARIANT_MISMATCH"];
  const skus = Object.keys(gen).filter((k) => QUARANTINED.includes(gen[k].status) || (gen[k].status === "ERR" && /not in EnrichedReadySku/.test(gen[k].reason || "")));
  console.log(`SKU в карантине: ${skus.length}\n`);

  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });

  const donorNow = new Map<string, string>();
  const hasRow = new Set<string>();
  for (let i = 0; i < skus.length; i += 200) {
    const c = skus.slice(i, i + 200);
    const rows = (await db.execute({ sql: `SELECT sku, donorTitle FROM EnrichedReadySku WHERE sku IN (${c.map(() => "?").join(",")})`, args: c })).rows;
    for (const r of rows) { hasRow.add(String(r.sku)); donorNow.set(String(r.sku), String(r.donorTitle || "")); }
  }
  const listing = new Map<string, string>();
  for (let i = 0; i < skus.length; i += 200) {
    const c = skus.slice(i, i + 200);
    const rows = (await db.execute({ sql: `SELECT sku,title FROM WalmartCatalogItem WHERE sku IN (${c.map(() => "?").join(",")})`, args: c })).rows;
    for (const r of rows) if (r.title) listing.set(String(r.sku), String(r.title));
  }

  let noRow = 0, changed = 0, same = 0, noOldTitle = 0;
  let checkable = 0, mismatch = 0;
  const examples: string[] = [];
  for (const s of skus) {
    if (!hasRow.has(s)) { noRow++; continue; }
    const now = donorNow.get(s) || "";
    const before = gen[s].donorTitle || "";
    if (!before) noOldTitle++;
    else if (before.trim() !== now.trim()) changed++;
    else same++;

    const L = listing.get(s);
    if (!L || !now) continue;
    checkable++;
    const m = modifierMismatch(L, now);
    if (m) {
      mismatch++;
      if (examples.length < 6) examples.push(`  ${s}  "${m}"\n     листинг: ${L.slice(0, 62)}\n     донор:   ${now.slice(0, 62)}`);
    }
  }

  console.log(`строки в EnrichedReadySku:  есть ${skus.length - noRow} · НЕТ ${noRow}`);
  console.log(`донор СМЕНИЛСЯ: ${changed} · остался тот же: ${same} · старый заголовок неизвестен: ${noOldTitle}`);
  console.log(`\nсверка с заголовком листинга (бесплатный modifier-guard): проверяемых ${checkable}`);
  console.log(`  РАСХОЖДЕНИЕ модификатора: ${mismatch} (${checkable ? (100 * mismatch / checkable).toFixed(1) : 0}%)`);
  console.log(`  сходится: ${checkable - mismatch}`);
  if (examples.length) { console.log(`\nпримеры всё ещё чужих доноров:`); for (const e of examples) console.log(e); }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
