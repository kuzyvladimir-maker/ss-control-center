// Publish the NEW-SCHEME generated tiles (GEN_OK in _gen_enriched_state.json) to
// Walmart store1 — IMAGE-ONLY MP_MAINTENANCE, throttle-safe sequential feeds of 50
// (submit→drain→next; Walmart /feeds 429s on bursts). Item-level truth via
// checkFeedItems; records a WalmartListingRemediation row per SKU. Resumable: skips
// SKUs already applied/qarth in _publish_gen_state.json. Safe to run repeatedly (e.g.
// from the hourly cron) as the drip produces more GEN_OK tiles — non-destructive.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }

const GEN = "_gen_enriched_state.json";
const STATE = "_publish_gen_state.json";
const BATCH = 50;
const POLL_BUDGET_MS = 15 * 60 * 1000;
const LIMIT = process.argv[2] ? Number(process.argv[2]) : Infinity;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const gen: Record<string, any> = JSON.parse(readFileSync(GEN, "utf8"));
  const state: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const save = () => writeFileSync(STATE, JSON.stringify(state, null, 1));
  // skip applied/qarth (terminal) AND submitted (feed in flight — _repoll_gen.ts resolves those)
  const done = (s?: string) => s === "applied" || s === "qarth" || s === "submitted";

  const ready = Object.values(gen).filter((g: any) => g.status === "GEN_OK" && g.newUrl && !done(state[g.sku]?.status));
  const pool = ready.slice(0, LIMIT === Infinity ? undefined : LIMIT);
  console.log(`GEN_OK ready ${ready.length} · publishing ${pool.length} (skip already applied/qarth)\n`);
  if (!pool.length) { console.log("nothing to publish."); return; }

  const { createClient } = await import("@libsql/client");
  const { getWalmartClient } = await import("./src/lib/walmart/client.ts");
  const { submitFeedBatch, checkFeedItems } = await import("./src/lib/walmart/multipack/remediate.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const client = getWalmartClient(1);

  const meta = new Map<string, { qty: number; url: string }>(pool.map((g: any) => [g.sku, { qty: g.qty, url: g.newUrl }]));

  // build image-only MPItems (live upc + productType)
  const items: { sku: string; mpItem: any }[] = [];
  for (const g of pool as any[]) {
    try {
      const cur: any = (await client.requestRaw("GET", `/items/${encodeURIComponent(g.sku)}`)).body?.ItemResponse?.[0];
      if (!cur?.upc || !cur?.productType) { state[g.sku] = { sku: g.sku, status: "build_skip", err: "no upc/productType", at: new Date().toISOString() }; continue; }
      items.push({ sku: g.sku, mpItem: {
        Orderable: { sku: g.sku, productIdentifiers: { productIdType: "UPC", productId: cur.upc } },
        Visible: { [cur.productType]: { mainImageUrl: g.newUrl } },
      } });
    } catch (e: any) { state[g.sku] = { sku: g.sku, status: "build_skip", err: "GET " + String(e?.message).slice(0, 40), at: new Date().toISOString() }; }
  }
  save();
  console.log(`built ${items.length} MPItems\n`);

  const record = async (sku: string, feedId: string | null, status: string, ok: boolean, detail: string) => {
    const m = meta.get(sku) || { qty: 0, url: "" };
    state[sku] = { sku, status, feedId, ok, detail, at: new Date().toISOString() };
    save();
    if (feedId) {
      try {
        await db.execute({
          sql: `INSERT INTO WalmartListingRemediation (id, storeIndex, sku, runAt, changeType, feedId, feedType, feedStatus, ok, packCount, mainImageUrl, notes, createdAt)
                VALUES (?, 1, ?, datetime('now'), 'multipack', ?, 'MP_MAINTENANCE', ?, ?, ?, ?, ?, datetime('now'))`,
          args: [randomUUID(), sku, feedId, status.toUpperCase(), ok ? 1 : 0, m.qty, m.url, "new-scheme EnrichedReadySku tile 2026-07-08"],
        });
      } catch (e: any) { console.log(`   (db row failed ${sku}: ${String(e?.message).slice(0, 40)})`); }
    }
  };

  let applied = 0, qarth = 0, failed = 0;
  const nB = Math.ceil(items.length / BATCH);
  for (let off = 0; off < items.length; off += BATCH) {
    const chunk = items.slice(off, off + BATCH);
    const bn = Math.floor(off / BATCH) + 1;
    const feed = await submitFeedBatch(client, chunk.map((c) => c.mpItem));
    if (!feed.feedId) { console.log(`  batch ${bn}/${nB}: POST FAILED ${String(feed.error).slice(0, 60)}`); for (const c of chunk) { failed++; await record(c.sku, null, "post_failed", false, feed.error || "no feedId"); } continue; }
    console.log(`  batch ${bn}/${nB}: feed ${feed.feedId.slice(0, 16)}… (${chunk.length}) draining…`);
    const t0 = Date.now(); let res = null;
    while (Date.now() - t0 < POLL_BUDGET_MS && !res) { await sleep(15000); try { res = await checkFeedItems(client, feed.feedId); } catch { } }
    if (!res) { for (const c of chunk) if (!done(state[c.sku]?.status)) await record(c.sku, feed.feedId, "submitted", false, "poll budget exhausted"); console.log(`  batch ${bn}/${nB}: INPROGRESS at budget — marked submitted`); continue; }
    const seen = new Set<string>();
    for (const it of res.items) {
      seen.add(it.sku);
      if (it.ok) { applied++; await record(it.sku, feed.feedId, "applied", true, "ok"); }
      else if (it.errors.some((e) => /0101119|QARTH|different details/i.test(e))) { qarth++; await record(it.sku, feed.feedId, "qarth", false, (it.errors[0] || "").slice(0, 80)); }
      else { failed++; await record(it.sku, feed.feedId, "failed", false, (it.errors[0] || it.ingestionStatus || "?").slice(0, 80)); }
    }
    for (const c of chunk) if (!seen.has(c.sku) && !done(state[c.sku]?.status)) { failed++; await record(c.sku, feed.feedId, "failed", false, "not in feed item details"); }
    console.log(`  batch ${bn}/${nB}: applied ${applied} · qarth ${qarth} · fail ${failed} (cumulative)`);
  }

  const all = Object.values(state);
  const c = (s: string) => all.filter((x: any) => x.status === s).length;
  console.log(`\n=== PUBLISH_GEN cumulative === applied ${c("applied")} · qarth ${c("qarth")} · failed ${c("failed")} · submitted ${c("submitted")} · post_failed ${c("post_failed")} · build_skip ${c("build_skip")}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
