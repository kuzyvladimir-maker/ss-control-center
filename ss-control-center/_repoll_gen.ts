// Re-poll new-scheme publish feeds left "submitted" (Walmart ingestion backlog) in
// _publish_gen_state.json — does NOT resubmit, just reads the real per-item outcome and
// records it. Cheap (feed GETs only). Safe to run from the hourly cron.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }

/** Both this script and _publish_gen.ts do read→mutate→writeFileSync on the SAME state
 *  file, so running them together silently loses whichever write lands first. The cron
 *  fires re-poll and publish in the same tick, and a publish of 5 feeds outlives the
 *  tick — so this is not hypothetical. Bail rather than corrupt; the next tick re-polls. */
function publisherRunning(script: string): boolean {
  try { return execSync(`pgrep -f "${script}" || true`, { encoding: "utf8" }).trim().length > 0; }
  catch { return false; }
}

async function main() {
  if (publisherRunning("_publish_gen.ts")) { console.log("_publish_gen.ts ещё пишет _publish_gen_state.json — пропускаю тик (гонка за файл состояния)"); return; }
  const st: Record<string, any> = JSON.parse(readFileSync("_publish_gen_state.json", "utf8"));
  const gen: Record<string, any> = JSON.parse(readFileSync("_gen_enriched_state.json", "utf8"));
  const { getWalmartClient } = await import("./src/lib/walmart/client.ts");
  const { checkFeedItemsPartial } = await import("./src/lib/walmart/multipack/remediate.ts");
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const client = getWalmartClient(1);

  const feeds = new Map<string, string[]>();
  for (const k in st) if (st[k].status === "submitted" && st[k].feedId) { const f = st[k].feedId; if (!feeds.has(f)) feeds.set(f, []); feeds.get(f)!.push(k); }
  console.log(`re-polling ${feeds.size} submitted new-scheme feeds`);

  for (const [fid, skus] of feeds) {
    // Settle every item Walmart has already decided, even if the feed as a whole is still
    // INPROGRESS — one slow item used to hold 46 finished ones hostage. See checkFeedItemsPartial.
    const res = await checkFeedItemsPartial(client, fid);
    let a = 0, q = 0, f = 0, waiting = 0;
    for (const it of res.items) {
      if (!skus.includes(it.sku)) continue;
      if (!it.settled) { waiting++; continue; }
      const status = it.ok ? "applied" : (it.errors.some((e) => /0101119|QARTH|different details/i.test(e)) ? "qarth" : "failed");
      if (it.ok) a++; else if (status === "qarth") q++; else f++;
      st[it.sku] = { sku: it.sku, status, feedId: fid, ok: it.ok, detail: (it.errors[0] || "ok").slice(0, 80), at: new Date().toISOString() };
      const g = gen[it.sku] || {};
      await db.execute({ sql: `INSERT INTO WalmartListingRemediation (id,storeIndex,sku,runAt,changeType,feedId,feedType,feedStatus,ok,packCount,mainImageUrl,notes,createdAt) VALUES (?,1,?,datetime('now'),'multipack',?,'MP_MAINTENANCE',?,?,?,?,?,datetime('now'))`, args: [randomUUID(), it.sku, fid, status.toUpperCase(), it.ok ? 1 : 0, g.qty || 0, g.newUrl || "", "new-scheme repoll 2026-07-08"] });
    }
    console.log(`  ${fid.slice(0, 14)} [${res.feedStatus}] → applied ${a} qarth ${q} fail ${f}${waiting ? ` · ещё в обработке ${waiting}` : ""}`);
  }
  writeFileSync("_publish_gen_state.json", JSON.stringify(st, null, 1));
  const c: Record<string, number> = {}; for (const k in st) c[st[k].status] = (c[st[k].status] || 0) + 1;
  console.log(`publish_gen state now: ${JSON.stringify(c)}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
