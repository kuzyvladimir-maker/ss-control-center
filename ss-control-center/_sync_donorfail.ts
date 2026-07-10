// Sync current DONOR_FAIL SKUs from the running generator into Setting.enrich_priority_skus
// so COGS can re-enrich them WITHOUT waiting for the ~12h drip to finish (the drip only
// flushes needEnrich at end-of-run). Idempotent union. Run each cron tick.
// DONOR_FAIL = donor gallery had no clean single-unit white-bg front (mostly Walmart
// "enhanced" banner'd images) → COGS should re-source a clean Target/Sam's front.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }

async function main() {
  const gen: Record<string, any> = JSON.parse(readFileSync("_gen_enriched_state.json", "utf8"));
  // Three donor problems, all COGS's to re-source, all flushed to the enrich queue:
  //   DONOR_FAIL       — gallery had no clean single-unit white-bg front (banner'd images)
  //   TILE_FAIL        — the tile failed identity QC against the listing title
  //   VARIANT_MISMATCH — the free modifier guard caught the donor before any vision call
  //                      (listing says "Dr Pepper", donor says "Diet Dr Pepper")
  // VARIANT_MISMATCH was added to the generator on 2026-07-09 and this flusher did not
  // know about it, so 54 wrong-donor SKUs sat outside the queue until the drip's own
  // end-of-run flush ~12h later. Keep this list in sync with _gen_enriched.ts statuses.
  const FAIL_STATUSES = ["DONOR_FAIL", "TILE_FAIL", "VARIANT_MISMATCH"];
  const df = Object.keys(gen).filter((k) => FAIL_STATUSES.includes(gen[k].status));

  // A fourth donor problem hiding inside ERR: the SKU has no row in EnrichedReadySku at
  // all (COGS's donor was deleted, or its gallery went empty). Retrying the generator on
  // these does nothing — only a re-harvest helps — so they belong in the queue as well.
  // Other ERRs (vision retries) are genuinely transient; leave them for the next drip.
  const noDonor = Object.keys(gen).filter((k) => gen[k].status === "ERR" && /not in EnrichedReadySku/.test(gen[k].reason || ""));
  df.push(...noDonor);
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const ex = (await db.execute(`SELECT value FROM Setting WHERE key='enrich_priority_skus'`)).rows;
  let existing: string[] = []; if (ex.length) { try { existing = JSON.parse(String(ex[0].value)) || []; } catch { } }
  const exSet = new Set(existing);
  const add = df.filter((s) => !exSet.has(s));
  const merged = [...new Set([...existing, ...df])];
  if (ex.length) await db.execute({ sql: `UPDATE Setting SET value=? WHERE key='enrich_priority_skus'`, args: [JSON.stringify(merged)] });
  else await db.execute({ sql: `INSERT INTO Setting (id,key,value) VALUES (?,?,?)`, args: [randomUUID(), "enrich_priority_skus", JSON.stringify(merged)] });
  console.log(`DONOR_FAIL ${df.length} · added ${add.length} new · queue now ${merged.length}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
