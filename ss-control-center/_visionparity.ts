// PARITY: does Codex (GPT-5.4 high, free) give the SAME single-unit verdicts as
// paid Sonnet on our donor gate? Runs qualifyDonorFront on the SAME real Walmart-1P
// candidate images (caddy + single box) under both providers, side by side.
import { readFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; } for (const l of t.split("\n")) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, ""); } }
async function main() {
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { oxylabsWalmartSearch } = await import("./src/lib/sourcing/oxylabs-fetch.ts");
  const { highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const norm = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length >= 3));
  const overlap = (a: string, b: string) => { const A = norm(a), B = norm(b); if (!A.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / A.size; };
  const clean = (t: string) => t.replace(/\(pack of \d+\)/ig, "").replace(/,.*$/, "").trim();
  const titles = [
    "Cheez-It Extra Cheesy Cheese Crackers, Baked Snack Crackers, 12.4 oz (Pack of 4)",
    "Gatorade Thirst Quencher, Lemon Lime Sports Drinks, 28 fl oz, (Pack of 8)",
  ];
  const run = async (url: string, title: string, provider: string) => {
    process.env.SS_VISION_PROVIDER = provider;
    const t0 = Date.now();
    const v = await vision.qualifyDonorFront(highResImageUrl(url), title, vision.unitSizeFromTitle(title));
    return { v, ms: Date.now() - t0 };
  };
  let agree = 0, total = 0;
  for (const title of titles) {
    console.log(`\n=== ${title}`);
    const { offers } = await oxylabsWalmartSearch(clean(title));
    const cands = offers.filter(o => o.isMarketplaceItem !== true && o.imageUrls[0])
      .map(o => ({ u: o.imageUrls[0], s: overlap(title, o.title || "") })).sort((a, b) => b.s - a.s).slice(0, 4);
    for (const c of cands) {
      const a = await run(c.u, title, "anthropic");
      const g = await run(c.u, title, "codex");
      const same = a.v.pass === g.v.pass;
      agree += same ? 1 : 0; total++;
      const fmt = (v: any) => `pass=${v.pass ? "Y" : "n"} [b${+v.brand}t${+v.type}v${+v.variant}s${+v.singleUnit}f${+v.front}w${+v.whiteBg}]`;
      console.log(`  ${same ? "AGREE" : "DIFF "}  Sonnet ${fmt(a.v)} (${a.ms}ms)  |  Codex ${fmt(g.v)} (${g.ms}ms)`);
      console.log(`         Sonnet: ${a.v.reason}`);
      console.log(`         Codex : ${g.v.reason}`);
    }
  }
  console.log(`\nPARITY: ${agree}/${total} candidates got the SAME pass/reject verdict on both providers`);
}
main().catch(e => { console.error(e); process.exit(1); });
