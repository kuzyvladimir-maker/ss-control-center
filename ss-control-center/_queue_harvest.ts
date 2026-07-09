// Push every bad-image SKU that CANNOT be fixed from our existing donor catalog into
// Setting.enrich_priority_skus — the queue the COGS chat drains. Two sources:
//   1. _suggested_donors.json entries with no candidate at all (need a fresh retail find)
//   2. _fix_gen_state.json failures — the replacement donor existed but its gallery has
//      no clean single-unit white-bg front, or the rebuilt tile still failed identity QC
// Read-only over the catalog; the only write is the queue. Idempotent (set-merge).
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }

async function main() {
  const sugg: any[] = JSON.parse(readFileSync("_suggested_donors.json", "utf8"));
  const noCand = sugg.filter((x) => !x.suggestions.length).map((x) => x.sku);

  const fix: Record<string, any> = existsSync("_fix_gen_state.json") ? JSON.parse(readFileSync("_fix_gen_state.json", "utf8")) : {};
  const fixFail = Object.values(fix).filter((x: any) => ["DONOR_FAIL", "SUGGEST_BAD", "TILE_FAIL"].includes(x.status)).map((x: any) => x.sku);

  const want = [...new Set([...noCand, ...fixFail])];
  console.log(`нет кандидата в каталоге: ${noCand.length} · замена не прошла QC: ${fixFail.length} · итого в очередь: ${want.length}`);

  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const ex = (await db.execute(`SELECT value FROM Setting WHERE key='enrich_priority_skus'`)).rows;
  let existing: string[] = []; if (ex.length) { try { existing = JSON.parse(String(ex[0].value)) || []; } catch { } }
  const merged = [...new Set([...existing, ...want])];
  const added = merged.length - existing.length;
  if (ex.length) await db.execute({ sql: `UPDATE Setting SET value=? WHERE key='enrich_priority_skus'`, args: [JSON.stringify(merged)] });
  else await db.execute({ sql: `INSERT INTO Setting (id,key,value) VALUES (?,?,?)`, args: [randomUUID(), "enrich_priority_skus", JSON.stringify(merged)] });
  console.log(`очередь была ${existing.length} → стала ${merged.length} (+${added} новых)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
