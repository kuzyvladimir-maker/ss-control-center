// RE-QC every LIVE main image against the LISTING title (the buyer's ground truth).
//
// The original gate compared each tile to its DONOR's title, so a wrong-variant donor
// validated itself and passed (Dr Pepper listing → Diet Dr Pepper image, live). The
// modifier guard already found 65 such SKUs from the titles alone; this pass uses vision
// to catch the rest, where the mismatch is not a modifier word ("Buffalo" vs "Cajun",
// "Jewish Rye" vs "Pumpernickel").
//
// READ-ONLY: it publishes nothing. Output = _reqc_published.json (BAD list).
// Resumable: already-judged SKUs are skipped.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
process.env.SS_VISION_PROVIDER = "auto";

const STATE = "_reqc_state.json";
const CONC = Number(process.argv[2] ?? 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isErr = (s: string) => /error/i.test(s || "");

async function main() {
  const gen: Record<string, any> = JSON.parse(readFileSync("_gen_enriched_state.json", "utf8"));
  const pubNew: Record<string, any> = JSON.parse(readFileSync("_publish_gen_state.json", "utf8"));
  const pubOld: Record<string, any> = JSON.parse(readFileSync("_publishready_state.json", "utf8"));
  const buckets = JSON.parse(readFileSync("_spurious_buckets.json", "utf8"));
  const oldUrl = new Map<string, any>(buckets.genuine.map((g: any) => [g.sku, g]));
  const state: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const save = () => writeFileSync(STATE, JSON.stringify(state, null, 1));

  // every SKU whose main image is LIVE, with the tile url + pack count
  const live: { sku: string; url: string; qty: number; wave: string }[] = [];
  for (const sku in pubNew) if (pubNew[sku].status === "applied" && gen[sku]?.newUrl) live.push({ sku, url: gen[sku].newUrl, qty: gen[sku].qty, wave: "new" });
  for (const sku in pubOld) if (pubOld[sku].status === "applied" && oldUrl.has(sku)) { const g = oldUrl.get(sku); live.push({ sku, url: g.url, qty: g.pack, wave: "old245" }); }

  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const titles = new Map<string, string>();
  const skus = live.map((x) => x.sku);
  for (let i = 0; i < skus.length; i += 200) {
    const chunk = skus.slice(i, i + 200);
    const rows = (await db.execute({ sql: `SELECT sku,title FROM WalmartCatalogItem WHERE sku IN (${chunk.map(() => "?").join(",")})`, args: chunk })).rows;
    for (const r of rows) if (r.title) titles.set(String(r.sku), String(r.title));
  }

  const vision = await import("./src/lib/sourcing/vision.ts");
  const todo = live.filter((x) => !state[x.sku] && titles.has(x.sku) && x.qty >= 2);
  console.log(`живых плиток: ${live.length} · с заголовком листинга: ${titles.size} · к проверке: ${todo.length} (CONC ${CONC})\n`);

  let bad = 0, good = 0, err = 0, done = 0;
  const check = async (x: any) => {
    const listing = titles.get(x.sku)!;
    let tv: any = null;
    for (let a = 0; a < 4; a++) { tv = await vision.qualifyTiledMain(x.url, listing, x.qty); if (!isErr(tv.reason)) break; await sleep(2500 * (a + 1)); }
    if (isErr(tv.reason)) { state[x.sku] = { sku: x.sku, verdict: "ERR", wave: x.wave }; err++; }
    else if (tv.pass) { state[x.sku] = { sku: x.sku, verdict: "OK", wave: x.wave }; good++; }
    else {
      state[x.sku] = { sku: x.sku, verdict: "BAD", wave: x.wave, qty: x.qty, listing, donorTitle: gen[x.sku]?.donorTitle || "", reason: (tv.reason || "").slice(0, 110), url: x.url };
      bad++;
      console.log(`  ✗ ${x.sku} q${x.qty} [${x.wave}]  ${(tv.reason || "").slice(0, 80)}`);
    }
    done++; save();
    if (done % 25 === 0) console.log(`  … ${done}/${todo.length}  OK ${good} · BAD ${bad} · ERR ${err}`);
  };
  for (let i = 0; i < todo.length; i += CONC) await Promise.all(todo.slice(i, i + CONC).map(check));

  const all = Object.values(state);
  const B = all.filter((x: any) => x.verdict === "BAD");
  writeFileSync("_reqc_published.json", JSON.stringify(B, null, 1));
  console.log(`\n=== ИТОГ === проверено ${all.length} · OK ${all.filter((x: any) => x.verdict === "OK").length} · ПЛОХИХ ${B.length} · ERR ${all.filter((x: any) => x.verdict === "ERR").length}`);
  console.log(`плохих по волнам: new ${B.filter((x: any) => x.wave === "new").length} · old245 ${B.filter((x: any) => x.wave === "old245").length}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
