// Publish the 9 eyeball-verified main images (image-only feeds — title untouched).
// 3 Jarritos (×2/×4/×6 single 1.5L bottles) + 6 clean-pipeline rebuilds. FaisalX-1156
// (Sweet Hawaiian, donor has a promo banner) is HELD for Vladimir's review.
// Uses the production-proven submitMainImageOnly → poll checkFeed to terminal →
// record a WalmartListingRemediation row so tracking stays consistent.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
const ITEMS: Array<{ sku: string; pack: number; url: string }> = [
  { sku: "FaisalX-1856", pack: 2, url: "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/walmart-multipack/FaisalX-1856/main-jarritosfix.png" },
  { sku: "FaisalX-1857", pack: 4, url: "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/walmart-multipack/FaisalX-1857/main-jarritosfix.png" },
  { sku: "FaisalX-1858", pack: 6, url: "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/walmart-multipack/FaisalX-1858/main-jarritosfix.png" },
  { sku: "FaisalX-1159", pack: 6, url: "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/walmart-multipack/FaisalX-1159/main-pipeline.png" },
  { sku: "FaisalX-1171", pack: 6, url: "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/walmart-multipack/FaisalX-1171/main-pipeline.png" },
  { sku: "FaisalX-1182", pack: 4, url: "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/walmart-multipack/FaisalX-1182/main-pipeline.png" },
  { sku: "FaisalX-1207", pack: 6, url: "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/walmart-multipack/FaisalX-1207/main-pipeline.png" },
  { sku: "FaisalX-1210", pack: 6, url: "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/walmart-multipack/FaisalX-1210/main-pipeline.png" },
  { sku: "FaisalX-4397", pack: 8, url: "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/walmart-multipack/FaisalX-4397/main-pipeline.png" },
];
async function main() {
  const { createClient } = await import("@libsql/client");
  const { getWalmartClient } = await import("./src/lib/walmart/client.ts");
  const { submitMainImageOnly, checkFeed } = await import("./src/lib/walmart/multipack/remediate.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const client = getWalmartClient(1);
  const subs: any[] = [];
  for (const it of ITEMS) {
    try {
      const r = await submitFeedWithRetry(() => submitMainImageOnly(client, it.sku, it.url));
      subs.push({ ...it, feedId: r.feedId, error: r.error });
      console.log(`  submit ${it.sku} ×${it.pack} → ${r.feedId ? "feed " + r.feedId.slice(0, 14) + "…" : "FAILED " + r.error}`);
    } catch (e: any) { subs.push({ ...it, feedId: null, error: String(e?.message || e).slice(0, 100) }); console.log(`  submit ${it.sku} ERR ${e?.message}`); }
    await new Promise((r) => setTimeout(r, 2500));
  }
  // poll all feeds to terminal (up to ~12 min)
  console.log("\npolling feeds to terminal…");
  const t0 = Date.now();
  for (const s of subs) {
    if (!s.feedId) { s.final = "POST_FAILED"; s.ok = false; continue; }
    while (Date.now() - t0 < 12 * 60 * 1000) {
      try { const c = await checkFeed(client, s.feedId); if (c) { s.final = c.status; s.ok = c.ok; s.detail = c.detail; break; } } catch { }
      await new Promise((r) => setTimeout(r, 25000));
    }
    if (!s.final) { s.final = "SUBMITTED"; s.ok = false; s.detail = "still processing at timeout"; }
    console.log(`  ${s.sku} → ${s.final} ${s.detail || ""}`);
  }
  // record rows
  for (const s of subs) {
    if (!s.feedId) continue;
    await db.execute({
      sql: `INSERT INTO WalmartListingRemediation (id, storeIndex, sku, runAt, changeType, feedId, feedType, feedStatus, ok, packCount, mainImageUrl, notes, createdAt)
            VALUES (?, 1, ?, datetime('now'), 'multipack', ?, 'MP_MAINTENANCE', ?, ?, ?, ?, ?, datetime('now'))`,
      args: [randomUUID(), s.sku, s.feedId, s.final, s.ok ? 1 : 0, s.pack, s.url, "clean-pipeline verified fix (eyeballed) 2026-07-06"],
    });
  }
  const good = subs.filter((s) => s.ok).length;
  console.log(`\n=== PUBLISHED OK: ${good}/${ITEMS.length} (rest: ${subs.filter(s => !s.ok).map(s => s.sku + ":" + s.final).join(", ") || "none"}) ===`);
}
async function submitFeedWithRetry(fn: () => Promise<{ feedId: string | null; error?: string }>): Promise<{ feedId: string | null; error?: string }> {
  let last: any = null;
  for (let a = 0; a < 4; a++) {
    last = await fn();
    if (last.feedId) return last;
    if (!/429|throttl|TOO_MANY/i.test(String(last.error || ""))) return last;
    await new Promise((r) => setTimeout(r, 15000 * (a + 1)));
  }
  return last;
}
main().catch((e) => { console.error(e); process.exit(1); });
