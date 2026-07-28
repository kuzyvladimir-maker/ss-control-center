// Hand off my image-chat "tail" (SKUs that still lack a good donor) to the COGS chat
// via Setting.enrich_priority_skus (JSON array). Per the division-of-labor contract I
// do NOT retail-search these myself — COGS enriches them first, then they surface in
// EnrichedReadySku for me to generate+publish. Sources: REBUILT_FAIL (pipeline) + 33
// bannered (bannercheck) + 35 browser-tail. EXCLUDE own-brand STARFIT (waits owner
// photos) and anything ALREADY image-ready in EnrichedReadySku (no re-enrich needed).
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }

const STARFIT = new Set(["15369958986", "13941264614"]);

async function main() {
  const pipe = JSON.parse(readFileSync("_pipeline_state.json", "utf8"));
  const banner = JSON.parse(readFileSync("_bannercheck_state.json", "utf8"));
  const browser = JSON.parse(readFileSync("_tail_browser_pool.json", "utf8"));

  const src = new Map<string, string>(); // sku -> reason
  for (const x of Object.values(pipe) as any[]) if (x.status === "REBUILT_FAIL") src.set(x.sku, "rebuilt_fail");
  for (const x of Object.values(banner) as any[]) if (x.clean === false) src.set(x.sku, src.has(x.sku) ? src.get(x.sku)! + "+bannered" : "bannered");
  for (const x of (Array.isArray(browser) ? browser : []) as any[]) src.set(x.sku, src.has(x.sku) ? src.get(x.sku)! + "+browser_tail" : "browser_tail");

  // drop STARFIT own-brand
  for (const s of STARFIT) if (src.has(s)) { console.log(`  exclude own-brand STARFIT ${s}`); src.delete(s); }

  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });

  // drop anything already image-ready (COGS already enriched it — I can just regenerate)
  const ready = new Set((await db.execute(`SELECT DISTINCT sku FROM EnrichedReadySku`)).rows.map((r: any) => String(r.sku)));
  let alreadyReady = 0;
  for (const sku of [...src.keys()]) if (ready.has(sku)) { src.delete(sku); alreadyReady++; }

  const skus = [...src.keys()].sort();
  console.log(`\ntail sources: rebuilt_fail + bannered + browser_tail`);
  console.log(`already image-ready (dropped, no re-enrich needed): ${alreadyReady}`);
  console.log(`→ handing ${skus.length} SKUs to enrich_priority_skus:\n`);
  for (const sku of skus) console.log(`  ${sku}  [${src.get(sku)}]`);

  // merge with any existing value (union), then upsert
  const ex = (await db.execute(`SELECT id, value FROM Setting WHERE key='enrich_priority_skus'`)).rows;
  let existing: string[] = [];
  if (ex.length) { try { existing = JSON.parse(String(ex[0].value)) || []; } catch { } }
  const merged = [...new Set([...existing, ...skus])];
  if (ex.length) await db.execute({ sql: `UPDATE Setting SET value=? WHERE key='enrich_priority_skus'`, args: [JSON.stringify(merged)] });
  else await db.execute({ sql: `INSERT INTO Setting (id, key, value) VALUES (?, 'enrich_priority_skus', ?)`, args: [randomUUID(), JSON.stringify(merged)] });

  console.log(`\nenrich_priority_skus now holds ${merged.length} SKUs (was ${existing.length}).`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
