// Re-poll remediation feeds left "submitted" in _publish_fix_state.json. Walmart image
// ingestion routinely outruns the 15-min poll budget; this reads the real per-item
// outcome without resubmitting anything. Cheap (feed GETs only), safe on the cron.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }

async function main() {
  const st: Record<string, any> = JSON.parse(readFileSync("_publish_fix_state.json", "utf8"));
  const gen: Record<string, any> = JSON.parse(readFileSync("_fix_gen_state.json", "utf8"));
  const { getWalmartClient } = await import("./src/lib/walmart/client.ts");
  const { checkFeedItems } = await import("./src/lib/walmart/multipack/remediate.ts");
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const client = getWalmartClient(1);

  const feeds = new Map<string, string[]>();
  for (const k in st) if (st[k].status === "submitted" && st[k].feedId) { const f = st[k].feedId; if (!feeds.has(f)) feeds.set(f, []); feeds.get(f)!.push(k); }
  console.log(`re-polling ${feeds.size} submitted remediation feeds`);

  for (const [fid, skus] of feeds) {
    const res = await checkFeedItems(client, fid);
    if (!res) { console.log(`  ${fid.slice(0, 14)} still INPROGRESS`); continue; }
    let a = 0, q = 0, f = 0;
    for (const it of res.items) {
      if (!skus.includes(it.sku)) continue;
      const status = it.ok ? "applied" : (it.errors.some((e) => /0101119|QARTH|different details/i.test(e)) ? "qarth" : "failed");
      if (it.ok) a++; else if (status === "qarth") q++; else f++;
      st[it.sku] = { sku: it.sku, status, feedId: fid, ok: it.ok, detail: (it.errors[0] || "ok").slice(0, 80), at: new Date().toISOString() };
      const g = gen[it.sku] || {};
      await db.execute({ sql: `INSERT INTO WalmartListingRemediation (id,storeIndex,sku,runAt,changeType,feedId,feedType,feedStatus,ok,packCount,mainImageUrl,notes,createdAt) VALUES (?,1,?,datetime('now'),'multipack',?,'MP_MAINTENANCE',?,?,?,?,?,datetime('now'))`, args: [randomUUID(), it.sku, fid, status.toUpperCase(), it.ok ? 1 : 0, g.qty || 0, g.newUrl || "", "REMEDIATION repoll 2026-07-09"] });
    }
    console.log(`  ${fid.slice(0, 14)} resolved → applied ${a} qarth ${q} fail ${f}`);
  }
  writeFileSync("_publish_fix_state.json", JSON.stringify(st, null, 1));
  const c: Record<string, number> = {}; for (const k in st) c[st[k].status] = (c[st[k].status] || 0) + 1;
  console.log(`publish_fix state now: ${JSON.stringify(c)}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
