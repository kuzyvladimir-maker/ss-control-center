// Re-poll the feeds whose SKUs were left "submitted" (poll-budget exhausted) by the
// sequential publisher. Their images may have finished ingesting since. Reads the
// existing feedIds from _publishready_state.json — does NOT resubmit — and records the
// real per-item outcome (applied / qarth / failed) into state + WalmartListingRemediation.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }

const STATE = "_publishready_state.json";
const BUDGET_MS = 20 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const state: Record<string, any> = JSON.parse(readFileSync(STATE, "utf8"));
  const buckets = JSON.parse(readFileSync("_spurious_buckets.json", "utf8"));
  const meta = new Map<string, { pack: number; url: string }>(buckets.genuine.map((g: any) => [g.sku, { pack: g.pack, url: g.url }]));
  const save = () => writeFileSync(STATE, JSON.stringify(state, null, 1));

  const feeds = new Map<string, string[]>();
  for (const k in state) if (state[k].status === "submitted" && state[k].feedId) { const f = state[k].feedId; if (!feeds.has(f)) feeds.set(f, []); feeds.get(f)!.push(k); }
  console.log(`re-polling ${feeds.size} feeds covering ${[...feeds.values()].reduce((a, b) => a + b.length, 0)} submitted SKUs\n`);

  const { createClient } = await import("@libsql/client");
  const { getWalmartClient } = await import("./src/lib/walmart/client.ts");
  const { checkFeedItems } = await import("./src/lib/walmart/multipack/remediate.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const client = getWalmartClient(1);

  const record = async (sku: string, feedId: string, status: string, ok: boolean, detail: string) => {
    const m = meta.get(sku) || { pack: 0, url: "" };
    state[sku] = { sku, status, feedId, ok, detail, at: new Date().toISOString() };
    save();
    try {
      await db.execute({
        sql: `INSERT INTO WalmartListingRemediation (id, storeIndex, sku, runAt, changeType, feedId, feedType, feedStatus, ok, packCount, mainImageUrl, notes, createdAt)
              VALUES (?, 1, ?, datetime('now'), 'multipack', ?, 'MP_MAINTENANCE', ?, ?, ?, ?, ?, datetime('now'))`,
        args: [randomUUID(), sku, feedId, status.toUpperCase(), ok ? 1 : 0, m.pack, m.url, "re-poll of publishready feed 2026-07-08"],
      });
    } catch (e: any) { console.log(`   (db row failed ${sku}: ${String(e?.message).slice(0, 50)})`); }
  };

  let applied = 0, qarth = 0, failed = 0;
  const t0 = Date.now();
  const pending = new Set(feeds.keys());
  while (pending.size && Date.now() - t0 < BUDGET_MS) {
    for (const [feedId, skus] of feeds) {
      if (!pending.has(feedId)) continue;
      let res = null;
      try { res = await checkFeedItems(client, feedId); } catch { }
      if (!res) continue;
      pending.delete(feedId);
      const seen = new Set<string>();
      for (const it of res.items) {
        if (!skus.includes(it.sku)) continue;
        seen.add(it.sku);
        if (it.ok) { applied++; await record(it.sku, feedId, "applied", true, "ok"); }
        else if (it.errors.some((e) => /0101119|QARTH|different details/i.test(e))) { qarth++; await record(it.sku, feedId, "qarth", false, (it.errors[0] || "").slice(0, 90)); }
        else { failed++; await record(it.sku, feedId, "failed", false, (it.errors[0] || it.ingestionStatus || "?").slice(0, 90)); }
      }
      for (const sku of skus) if (!seen.has(sku)) { failed++; await record(sku, feedId, "failed", false, "not in feed item details"); }
      console.log(`  feed ${feedId.slice(0, 14)}… resolved → applied ${applied} · qarth ${qarth} · fail ${failed} (feeds left ${pending.size})`);
    }
    if (pending.size) await sleep(20000);
  }
  if (pending.size) console.log(`\n${pending.size} feeds STILL not terminal after ${BUDGET_MS / 60000} min — left as submitted.`);

  const all = Object.values(state);
  const c = (s: string) => all.filter((x: any) => x.status === s).length;
  console.log(`\n=== AFTER RE-POLL (cumulative) === applied ${c("applied")} · qarth ${c("qarth")} · failed ${c("failed")} · submitted ${c("submitted")} · post_failed ${c("post_failed")}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
