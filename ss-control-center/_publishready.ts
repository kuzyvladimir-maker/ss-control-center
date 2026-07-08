// Batch-publish the 245 GENUINE ready mains to Walmart (store1) — IMAGE-ONLY
// MP_MAINTENANCE, batched by 15. Source = _spurious_buckets.json .genuine (247
// banner-clean rebuilds MINUS Comm-01 + FaisalX-1148, the two confirmed spurious
// over-tiles). Non-destructive: a feed that fails ingestion leaves the live listing
// unchanged.
//
// DESIGN: submit ALL batches first, THEN poll all feeds together — Walmart image
// feeds sit INPROGRESS several minutes; polling each serially wastes time, so we let
// all ~17 process in parallel and drain them with one global budget. checkFeedItems
// gives ITEM-LEVEL truth (feed-level status alone stalls). Records a
// WalmartListingRemediation row per resolved SKU. Resumable: skips SKUs already
// applied/qarth in _publishready_state.json; re-submits anything else (idempotent —
// same image URL).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }

const STATE = "_publishready_state.json";
const BATCH = 50; // fewer, larger feeds — Walmart's /feeds POST rate limit (not feed size) is what throttles
const SUBMIT_SPACING_MS = 20000; // canonical spacing to avoid REQUEST_THRESHOLD_VIOLATED
const POLL_BUDGET_MS = 15 * 60 * 1000; // per-feed drain budget
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const buckets = JSON.parse(readFileSync("_spurious_buckets.json", "utf8"));
  const ready: any[] = buckets.genuine;
  const state: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const save = () => writeFileSync(STATE, JSON.stringify(state, null, 1));

  const { createClient } = await import("@libsql/client");
  const { getWalmartClient } = await import("./src/lib/walmart/client.ts");
  const { submitFeedBatch, checkFeedItems } = await import("./src/lib/walmart/multipack/remediate.ts");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const client = getWalmartClient(1);

  const done = (s: string) => s === "applied" || s === "qarth";
  const pending = ready.filter((r) => !state[r.sku] || !done(state[r.sku].status));
  console.log(`ready ${ready.length} · already applied/qarth ${ready.length - pending.length} · to process ${pending.length}\n`);

  // ---- Phase 1: build image-only MPItems (live upc + productType per SKU) ----
  const meta = new Map<string, { pack: number; url: string }>();
  const items: { sku: string; mpItem: any }[] = [];
  for (const f of pending) {
    meta.set(f.sku, { pack: f.pack, url: f.url });
    try {
      const cur: any = (await client.requestRaw("GET", `/items/${encodeURIComponent(f.sku)}`)).body?.ItemResponse?.[0];
      if (!cur?.upc || !cur?.productType) { state[f.sku] = { sku: f.sku, status: "build_skip", err: "no upc/productType live", at: new Date().toISOString() }; continue; }
      items.push({ sku: f.sku, mpItem: {
        Orderable: { sku: f.sku, productIdentifiers: { productIdType: "UPC", productId: cur.upc } },
        Visible: { [cur.productType]: { mainImageUrl: f.url } },
      } });
    } catch (e: any) { state[f.sku] = { sku: f.sku, status: "build_skip", err: "GET " + String(e?.message).slice(0, 50), at: new Date().toISOString() }; }
  }
  save();
  console.log(`built ${items.length} MPItems (${pending.length - items.length} build_skip)\n`);

  const record = async (sku: string, feedId: string | null, status: string, ok: boolean, detail: string) => {
    const m = meta.get(sku) || { pack: 0, url: "" };
    state[sku] = { sku, status, feedId, ok, detail, at: new Date().toISOString() };
    save();
    if (feedId) {
      try {
        await db.execute({
          sql: `INSERT INTO WalmartListingRemediation (id, storeIndex, sku, runAt, changeType, feedId, feedType, feedStatus, ok, packCount, mainImageUrl, notes, createdAt)
                VALUES (?, 1, ?, datetime('now'), 'multipack', ?, 'MP_MAINTENANCE', ?, ?, ?, ?, ?, datetime('now'))`,
          args: [randomUUID(), sku, feedId, status.toUpperCase(), ok ? 1 : 0, m.pack, m.url, "clean-pipeline verified fix (eyeball sample + spurious-filter) 2026-07-08"],
        });
      } catch (e: any) { console.log(`   (db row failed ${sku}: ${String(e?.message).slice(0, 50)})`); }
    }
  };

  // ---- Phase 2+3 SEQUENTIAL: submit one feed → drain it to terminal → next feed.
  // Feed POSTs are naturally spaced by each feed's processing time (~several min),
  // which respects Walmart's /feeds rate limit far better than firing them in a burst.
  const nBatches = Math.ceil(items.length / BATCH);
  let applied = 0, qarth = 0, failed = 0;
  for (let off = 0; off < items.length; off += BATCH) {
    const chunk = items.slice(off, off + BATCH);
    const bn = Math.floor(off / BATCH) + 1;
    const feed = await submitFeedBatch(client, chunk.map((c) => c.mpItem));
    if (!feed.feedId) {
      console.log(`  batch ${bn}/${nBatches}: POST FAILED ${String(feed.error).slice(0, 70)}`);
      for (const c of chunk) { failed++; await record(c.sku, null, "post_failed", false, feed.error || "no feedId"); }
      continue;
    }
    console.log(`  batch ${bn}/${nBatches}: feed ${feed.feedId.slice(0, 16)}… (${chunk.length} skus) — draining…`);
    // drain this feed to terminal (per-feed budget)
    const t0 = Date.now();
    let res = null;
    while (Date.now() - t0 < POLL_BUDGET_MS && !res) {
      await sleep(15000);
      try { res = await checkFeedItems(client, feed.feedId); } catch { }
    }
    if (!res) {
      for (const c of chunk) if (!done(state[c.sku]?.status)) { await record(c.sku, feed.feedId, "submitted", false, "poll budget exhausted"); }
      console.log(`  batch ${bn}/${nBatches}: still INPROGRESS at budget — marked submitted (re-run to re-poll)`);
      continue;
    }
    const seen = new Set<string>();
    for (const it of res.items) {
      seen.add(it.sku);
      if (it.ok) { applied++; await record(it.sku, feed.feedId, "applied", true, "ok"); }
      else if (it.errors.some((e) => /0101119|QARTH|different details/i.test(e))) { qarth++; await record(it.sku, feed.feedId, "qarth", false, (it.errors[0] || "").slice(0, 90)); }
      else { failed++; await record(it.sku, feed.feedId, "failed", false, (it.errors[0] || it.ingestionStatus || "?").slice(0, 90)); }
    }
    for (const c of chunk) if (!seen.has(c.sku) && !done(state[c.sku]?.status)) { failed++; await record(c.sku, feed.feedId, "failed", false, "not in feed item details"); }
    console.log(`  batch ${bn}/${nBatches}: done → applied ${applied} · qarth ${qarth} · fail ${failed} (cumulative)`);
  }

  const all = Object.values(state);
  const c = (s: string) => all.filter((x: any) => x.status === s).length;
  console.log(`\n=== PUBLISH RESULT (cumulative over all runs) ===`);
  console.log(`APPLIED (image now live): ${c("applied")}`);
  console.log(`QARTH-locked (catalog lock, not our fault): ${c("qarth")}`);
  console.log(`FAILED: ${c("failed")} · SUBMITTED(unresolved): ${c("submitted")} · POST_FAILED: ${c("post_failed")} · build_skip: ${c("build_skip")}`);
  const fails = all.filter((x: any) => ["failed", "post_failed", "submitted"].includes(x.status));
  for (const x of fails.slice(0, 40)) console.log(`  ${x.status} ${x.sku}: ${x.detail || x.err || ""}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
