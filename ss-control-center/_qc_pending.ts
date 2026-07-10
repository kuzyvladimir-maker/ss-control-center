// Vision-QC the GEN_OK tiles that were built under the OLD (donor-anchored) gate and are
// still UNPUBLISHED. They sit in _gen_enriched_state.json with no `listing` field — the
// tell-tale of the old code path, where a wrong-variant donor validated its own image.
//
// This is the last chance to catch them before they go live, so the check is the strict
// one: tile vs the LISTING title. A passer gets `listing` stamped on its state row and
// stays GEN_OK (safe for _publish_gen.ts). A failer is DEMOTED to TILE_FAIL so the
// publisher skips it, and it flows into the enrich queue like any other bad donor.
//
// Read-only against Walmart. Resumable (skips rows already stamped or demoted).
import { readFileSync, writeFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto";

const GEN = "_gen_enriched_state.json";
const CONC = Number(process.argv[2] ?? 4);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isErr = (s: string) => /error/i.test(s || "");

const MODIFIERS = ["diet", "zero", "decaf", "decaffeinated", "caffeine", "whole", "honey", "xxtra", "flamin", "unsweetened", "sugarfree", "lite", "reduced", "gluten", "organic", "spicy", "original", "classic", "smoked", "toasted"];
const words = (s: string) => new Set((s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean));
function modifierMismatch(listing: string, donor: string): string {
  const L = words(listing), D = words(donor);
  for (const m of MODIFIERS) if (L.has(m) !== D.has(m)) return m;
  return "";
}

async function main() {
  const gen: Record<string, any> = JSON.parse(readFileSync(GEN, "utf8"));
  const pub: Record<string, any> = JSON.parse(readFileSync("_publish_gen_state.json", "utf8"));
  const save = () => writeFileSync(GEN, JSON.stringify(gen, null, 1));
  const done = (s?: string) => s === "applied" || s === "qarth" || s === "submitted";

  const todo = Object.values(gen).filter((x: any) => x.status === "GEN_OK" && x.newUrl && x.qty >= 2 && !x.listing && !done(pub[x.sku]?.status)) as any[];
  console.log(`неопубликованных плиток старого гейта: ${todo.length} (CONC ${CONC})\n`);
  if (!todo.length) return;

  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const titles = new Map<string, string>();
  const skus = todo.map((x) => x.sku);
  for (let i = 0; i < skus.length; i += 200) {
    const chunk = skus.slice(i, i + 200);
    const rows = (await db.execute({ sql: `SELECT sku,title FROM WalmartCatalogItem WHERE sku IN (${chunk.map(() => "?").join(",")})`, args: chunk })).rows;
    for (const r of rows) if (r.title) titles.set(String(r.sku), String(r.title));
  }
  const vision = await import("./src/lib/sourcing/vision.ts");

  let pass = 0, fail = 0, err = 0, n = 0;
  const check = async (x: any) => {
    const listing = titles.get(x.sku);
    if (!listing) { gen[x.sku] = { ...x, status: "ERR", reason: "no listing title (cannot verify identity)" }; err++; n++; return; }

    // free guard first — a modifier disagreement needs no vision call
    const mism = modifierMismatch(listing, x.donorTitle || "");
    if (mism) { gen[x.sku] = { ...x, status: "TILE_FAIL", reason: `donor≠listing on "${mism}" (old-gate audit)`, listing }; fail++; n++; save(); console.log(`  ✗ ${x.sku}  модификатор "${mism}"`); return; }

    let tv: any = null;
    for (let a = 0; a < 4; a++) { tv = await vision.qualifyTiledMain(x.newUrl, listing, x.qty); if (!isErr(tv.reason)) break; await sleep(2500 * (a + 1)); }
    if (isErr(tv.reason)) { gen[x.sku] = { ...x, status: "ERR", reason: "vision errors during old-gate audit (retry later)" }; err++; }
    else if (tv.pass) { gen[x.sku] = { ...x, listing, tileReason: tv.reason }; pass++; }   // stays GEN_OK, now listing-verified
    else { gen[x.sku] = { ...x, status: "TILE_FAIL", reason: (tv.reason || "").slice(0, 110), listing }; fail++; console.log(`  ✗ ${x.sku}  ${(tv.reason || "").slice(0, 80)}`); }
    n++; save();
  };
  for (let i = 0; i < todo.length; i += CONC) await Promise.all(todo.slice(i, i + CONC).map(check));

  console.log(`\n=== АУДИТ СТАРОГО ГЕЙТА === прошло ${pass} · отбито ${fail} · ошибок ${err}`);
  console.log(`прошедшие безопасны для _publish_gen.ts; отбитые демонтированы в TILE_FAIL и уйдут в enrich_priority_skus`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
